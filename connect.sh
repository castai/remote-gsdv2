#!/bin/bash
set -euo pipefail

# ─── GSD Remote Connect ─────────────────────────────────────────────────────
# Connect to a remote GSD agent running in Kubernetes.
#
# Usage:
#   ./connect.sh                          # auto-discover, pick if multiple
#   ./connect.sh --project salesanalyzer  # connect to specific project
#   ./connect.sh --iterm                  # iTerm2 native tmux mode
#   ./connect.sh --new steering           # create new tmux session
#   ./connect.sh --list                   # show status without attaching
# ─────────────────────────────────────────────────────────────────────────────

NAMESPACE="${GSD_NAMESPACE:-lk-gsd}"
PROJECT=""
ITERM_MODE=false
LIST_MODE=false
NEW_SESSION=""
SESSION_NAME=""

# ── Parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --iterm) ITERM_MODE=true; shift ;;
    --new) NEW_SESSION="$2"; shift 2 ;;
    --list|-l) LIST_MODE=true; shift ;;
    --project|-p) PROJECT="$2"; shift 2 ;;
    --namespace|-n) NAMESPACE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: ./connect.sh [options] [tmux-session]"
      echo ""
      echo "Options:"
      echo "  --project, -p <name>  Connect to a specific project (e.g. salesanalyzer)"
      echo "  --new <name>          Create and attach a new tmux session (e.g. steering)"
      echo "  --list, -l            List pods and tmux sessions without attaching"
      echo "  --iterm               Use iTerm2 native tmux integration (tmux -CC)"
      echo "  --namespace, -n <ns>  K8s namespace (default: lk-gsd, override with GSD_NAMESPACE env var)"
      echo ""
      echo "Examples:"
      echo "  ./connect.sh                          # attach to existing session"
      echo "  ./connect.sh --new steering            # new session for steering"
      echo "  ./connect.sh --new steering --iterm    # new session, iTerm2 native"
      echo "  ./connect.sh --iterm                   # attach existing, iTerm2 native"
      echo "  ./connect.sh --list                    # show status"
      echo ""
      echo "VS Code: run 'vscode-tunnel' inside the tmux session."
      echo "If multiple GSD pods are running, you'll be prompted to pick one."
      exit 0
      ;;
    -*) echo "Unknown flag: $1"; exit 1 ;;
    *) SESSION_NAME="$1"; shift ;;
  esac
done

# ── Find the pod ─────────────────────────────────────────────────────────────

discover_pod() {
  local pods
  pods=$(kubectl get pods -n "${NAMESPACE}" -l "app.kubernetes.io/name=gsd-remote" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.labels.gsd\/project}{"|"}{.metadata.creationTimestamp}{"\n"}{end}' 2>/dev/null || true)

  pods=$(echo "${pods}" | sed '/^$/d')

  if [ -z "${pods}" ]; then
    echo "✗ No running GSD pods found in namespace ${NAMESPACE}"
    echo ""
    echo "  Deploy one with:"
    echo "    helm install <release> ./chart/gsd-remote -f values.yaml"
    exit 1
  fi

  local count
  count=$(echo "${pods}" | wc -l | tr -d ' ')

  if [ "${count}" -eq 1 ]; then
    POD=$(echo "${pods}" | cut -d'|' -f1)
    PROJECT=$(echo "${pods}" | cut -d'|' -f2)
    echo "✓ Found: ${PROJECT} (${POD})"
    return
  fi

  echo ""
  echo "┌─────────────────────────────────────────────────┐"
  echo "│  GSD Remote Agents (${count} running)                 │"
  echo "└─────────────────────────────────────────────────┘"
  echo ""

  local idx=0
  declare -g -a POD_LIST=()
  declare -g -a PROJECT_LIST=()

  while IFS='|' read -r pname pproject pcreated; do
    [ -z "${pname}" ] && continue
    idx=$((idx + 1))
    printf "  [%d]  %-24s  project: %s\n" "${idx}" "${pproject:-unknown}" "${pname}"
    POD_LIST+=("${pname}")
    PROJECT_LIST+=("${pproject}")
  done <<< "${pods}"

  echo ""
  read -rp "  Select [1-${idx}]: " choice

  if ! [[ "${choice}" =~ ^[0-9]+$ ]] || [ "${choice}" -lt 1 ] || [ "${choice}" -gt "${idx}" ]; then
    echo "✗ Invalid selection"
    exit 1
  fi

  POD="${POD_LIST[$((choice - 1))]}"
  PROJECT="${PROJECT_LIST[$((choice - 1))]}"
}

if [ -n "${PROJECT}" ]; then
  POD=$(kubectl get pods -n "${NAMESPACE}" -l "gsd/project=${PROJECT}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [ -z "${POD}" ]; then
    echo "✗ No running pod for project '${PROJECT}' in namespace ${NAMESPACE}"
    echo ""
    echo "  Available:"
    kubectl get pods -n "${NAMESPACE}" -l "app.kubernetes.io/name=gsd-remote" \
      -o custom-columns='POD:.metadata.name,PROJECT:.metadata.labels.gsd\/project,STATUS:.status.phase' 2>&1
    exit 1
  fi
  echo "✓ Found: ${PROJECT} (${POD})"
else
  discover_pod
fi

# ── List mode — show everything and exit ─────────────────────────────────────
if [ "${LIST_MODE}" = true ]; then
  echo ""
  echo "┌─────────────────────────────────────────────────┐"
  echo "│  Pod: ${POD}"
  echo "│  Project: ${PROJECT:-unknown}"
  echo "└─────────────────────────────────────────────────┘"
  echo ""

  SESSIONS=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
    tmux list-sessions -F '  #{session_name}  #{session_windows} window(s)  #{?session_attached,attached,detached}  (created #{session_created_string})' 2>/dev/null || true)

  if [ -n "${SESSIONS}" ]; then
    echo "  tmux sessions:"
    echo "${SESSIONS}"
  else
    echo "  No tmux sessions"
  fi

  # Check for vscode tunnel process and verify it's actually connected
  TUNNEL_INFO=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
    bash -c '
      if pgrep -f "code.*tunnel" >/dev/null 2>&1; then
        if [ -f /tmp/vscode-tunnel.log ] && grep -q "is connected" /tmp/vscode-tunnel.log 2>/dev/null; then
          echo "connected"
        else
          echo "process running (status unknown)"
        fi
      else
        echo "not running — start with: vscode-tunnel"
      fi
    ' 2>/dev/null || echo "unknown")
  echo ""
  echo "  VS Code tunnel: ${TUNNEL_INFO}"
  echo ""
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────────────────────
STATUS=$(kubectl get pod "${POD}" -n "${NAMESPACE}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "NotFound")
if [ "${STATUS}" != "Running" ]; then
  echo "✗ Pod ${POD} is ${STATUS}"
  exit 1
fi

# ── Attach to tmux ──────────────────────────────────────────────────────────

TMUX_CMD="tmux"
if [ "${ITERM_MODE}" = true ]; then
  TMUX_CMD="tmux -CC"
  echo "  (iTerm2 native mode — windows appear as native tabs)"
fi

# Create new session if --new was given
if [ -n "${NEW_SESSION}" ]; then
  echo "→ Creating new tmux session '${NEW_SESSION}'..."
  WORK_DIR=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- bash -c 'echo $WORKSPACE' 2>/dev/null || echo "/workspace")
  kubectl exec -n "${NAMESPACE}" "${POD}" -- tmux new-session -d -s "${NEW_SESSION}" -c "${WORK_DIR}" 2>/dev/null || true
  echo "  Attaching... (detach: Ctrl+B, D)"
  echo ""
  exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- ${TMUX_CMD} attach -t "${NEW_SESSION}"
fi

# Direct session name given
if [ -n "${SESSION_NAME}" ]; then
  exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- ${TMUX_CMD} attach -t "${SESSION_NAME}"
fi

# List tmux sessions
SESSIONS=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  tmux list-sessions -F '#{session_name}|#{session_windows}|#{?session_attached,attached,detached}' 2>/dev/null || true)

if [ -z "${SESSIONS}" ]; then
  echo "  No tmux sessions — opening a shell..."
  exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- zsh
fi

COUNT=$(echo "${SESSIONS}" | wc -l | tr -d ' ')

# Single session → attach
if [ "${COUNT}" -eq 1 ]; then
  NAME=$(echo "${SESSIONS}" | cut -d'|' -f1)
  STATE=$(echo "${SESSIONS}" | cut -d'|' -f3)
  echo "→ ${NAME} (${STATE}) — detach: Ctrl+B, D"
  echo ""
  exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- ${TMUX_CMD} attach -t "${NAME}"
fi

# Multiple → pick
echo ""
IDX=0
declare -a NAMES
while IFS='|' read -r NAME WINDOWS STATE; do
  IDX=$((IDX + 1))
  printf "  [%d]  %-16s  %d window(s)  %s\n" "${IDX}" "${NAME}" "${WINDOWS}" "${STATE}"
  NAMES+=("${NAME}")
done <<< "${SESSIONS}"

echo ""
read -rp "  Select session [1-${IDX}]: " CHOICE

if ! [[ "${CHOICE}" =~ ^[0-9]+$ ]] || [ "${CHOICE}" -lt 1 ] || [ "${CHOICE}" -gt "${IDX}" ]; then
  echo "✗ Invalid selection"; exit 1
fi

SELECTED="${NAMES[$((CHOICE - 1))]}"
echo "→ ${SELECTED} — detach: Ctrl+B, D"
echo ""
exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- ${TMUX_CMD} attach -t "${SELECTED}"
