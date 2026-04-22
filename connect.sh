#!/bin/bash
set -euo pipefail

# ─── GSD Remote Connect ─────────────────────────────────────────────────────
# Connect to a remote GSD agent running in Kubernetes.
#
# Usage:
#   ./connect.sh              # attach to tmux session
#   ./connect.sh --vscode     # start VS Code tunnel, then attach tmux
#   ./connect.sh <session>    # attach directly to named tmux session
#
# VS Code tunnel mode (--vscode):
#   1. Starts `code tunnel` inside the pod (if not already running)
#   2. Walks you through GitHub auth if this is the first time
#   3. Prints the tunnel name for VS Code → Remote-Tunnels: Connect
#   4. Then drops you into tmux as usual
# ─────────────────────────────────────────────────────────────────────────────

NAMESPACE="${GSD_NAMESPACE:-gsd-remote}"
POD="${GSD_POD:-gsd-agent-0}"
TUNNEL_NAME="${GSD_TUNNEL_NAME:-gsd-remote}"
VSCODE_MODE=false
SESSION_NAME=""

# ── Parse args ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --vscode) VSCODE_MODE=true ;;
    --help|-h)
      echo "Usage: ./connect.sh [--vscode] [session-name]"
      echo ""
      echo "  --vscode    Start a VS Code tunnel before attaching tmux"
      echo "  <session>   Attach directly to a named tmux session"
      echo ""
      echo "Environment:"
      echo "  GSD_NAMESPACE    K8s namespace (default: gsd-remote)"
      echo "  GSD_POD          Pod name (default: gsd-agent-0)"
      echo "  GSD_TUNNEL_NAME  VS Code tunnel name (default: gsd-remote)"
      exit 0
      ;;
    -*) echo "Unknown flag: $arg"; exit 1 ;;
    *) SESSION_NAME="$arg" ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────
if ! kubectl get pod "${POD}" -n "${NAMESPACE}" &>/dev/null; then
  echo "✗ Pod ${POD} not found in namespace ${NAMESPACE}"
  echo ""
  echo "  Is the agent deployed?"
  echo "  kubectl get pods -n ${NAMESPACE}"
  exit 1
fi

STATUS=$(kubectl get pod "${POD}" -n "${NAMESPACE}" -o jsonpath='{.status.phase}')
if [ "${STATUS}" != "Running" ]; then
  echo "✗ Pod ${POD} is ${STATUS} (not Running)"
  exit 1
fi

echo "✓ Pod ${POD} is running"

# ── VS Code tunnel ──────────────────────────────────────────────────────────
if [ "${VSCODE_MODE}" = true ]; then
  echo ""
  echo "┌─────────────────────────────────────────────────┐"
  echo "│  VS Code Tunnel Setup                           │"
  echo "└─────────────────────────────────────────────────┘"

  # Check if tunnel is already running
  TUNNEL_RUNNING=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
    bash -c 'pgrep -f "code.*tunnel" >/dev/null 2>&1 && echo "yes" || echo "no"' 2>/dev/null || echo "no")

  if [ "${TUNNEL_RUNNING}" = "yes" ]; then
    echo ""
    echo "  ✓ VS Code tunnel is already running as '${TUNNEL_NAME}'"
    echo ""
    echo "  Connect from VS Code:"
    echo "    Cmd+Shift+P → Remote-Tunnels: Connect to Tunnel → ${TUNNEL_NAME}"
    echo "  Or open in browser:"
    echo "    https://vscode.dev/tunnel/${TUNNEL_NAME}"
    echo ""
  else
    echo ""
    echo "  Starting VS Code tunnel '${TUNNEL_NAME}'..."
    echo "  This will open a GitHub authentication flow."
    echo ""

    # Run the tunnel interactively so the user can complete GitHub auth.
    # The tunnel prints a GitHub device code URL — user needs to visit it.
    # Once authenticated, we background the tunnel and continue to tmux.
    kubectl exec -it -n "${NAMESPACE}" "${POD}" -- \
      bash -c "
        # Start tunnel in background, capture output to a file
        nohup code tunnel --name '${TUNNEL_NAME}' --accept-server-license-terms \
          > /tmp/vscode-tunnel.log 2>&1 &
        TUNNEL_PID=\$!
        echo \$TUNNEL_PID > /tmp/vscode-tunnel.pid

        echo '  Waiting for tunnel to initialize...'
        # Wait for either the auth URL or the ready message
        for i in \$(seq 1 30); do
          if grep -q 'https://github.com/login/device' /tmp/vscode-tunnel.log 2>/dev/null; then
            echo ''
            echo '  ┌────────────────────────────────────────────────────┐'
            echo '  │  GitHub Authentication Required                    │'
            echo '  └────────────────────────────────────────────────────┘'
            grep -A2 'https://github.com/login/device' /tmp/vscode-tunnel.log
            echo ''
            echo '  Open the URL above in your browser and enter the code.'
            echo '  Waiting for authentication...'
            echo ''
            # Wait for tunnel to become ready after auth
            for j in \$(seq 1 120); do
              if grep -q 'is connected' /tmp/vscode-tunnel.log 2>/dev/null || \
                 grep -q 'Open this link' /tmp/vscode-tunnel.log 2>/dev/null; then
                break
              fi
              sleep 2
            done
            break
          fi
          if grep -q 'is connected' /tmp/vscode-tunnel.log 2>/dev/null || \
             grep -q 'Open this link' /tmp/vscode-tunnel.log 2>/dev/null; then
            break
          fi
          sleep 1
        done

        echo ''
        echo '  ✓ VS Code tunnel is ready!'
        echo ''
        echo '  Connect from VS Code:'
        echo '    Cmd+Shift+P → Remote-Tunnels: Connect to Tunnel → ${TUNNEL_NAME}'
        echo '  Or open in browser:'
        echo '    https://vscode.dev/tunnel/${TUNNEL_NAME}'
        echo ''
        echo '  Tunnel running in background (PID='\$TUNNEL_PID')'
      "
  fi

  echo "  Continuing to tmux session..."
  echo ""
fi

# ── Direct attach if session name given ──────────────────────────────────────
if [ -n "${SESSION_NAME}" ]; then
  echo "→ Attaching to tmux session '${SESSION_NAME}'..."
  exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- tmux attach -t "${SESSION_NAME}"
fi

# ── List sessions ────────────────────────────────────────────────────────────
SESSIONS=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created}|#{?session_attached,attached,detached}' 2>/dev/null || true)

if [ -z "${SESSIONS}" ]; then
  echo "✗ No tmux sessions found on ${POD}"
  echo ""
  echo "  Start one with:"
  echo "  kubectl exec -it -n ${NAMESPACE} ${POD} -- tmux new -s gsd -c /workspace 'gsd'"
  exit 1
fi

COUNT=$(echo "${SESSIONS}" | wc -l | tr -d ' ')

# ── Single session → attach directly ─────────────────────────────────────────
if [ "${COUNT}" -eq 1 ]; then
  NAME=$(echo "${SESSIONS}" | cut -d'|' -f1)
  STATE=$(echo "${SESSIONS}" | cut -d'|' -f4)
  echo "→ One session found: ${NAME} (${STATE})"
  echo "  Attaching... (detach: Ctrl+B, D)"
  echo ""
  exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- tmux attach -t "${NAME}"
fi

# ── Multiple sessions → pick one ─────────────────────────────────────────────
echo ""
echo "┌─────────────────────────────────────────────────┐"
echo "│  GSD Remote Sessions on ${POD}                  │"
echo "└─────────────────────────────────────────────────┘"
echo ""

IDX=0
declare -a NAMES
while IFS='|' read -r NAME WINDOWS CREATED STATE; do
  IDX=$((IDX + 1))
  CREATED_FMT=$(date -r "${CREATED}" '+%H:%M:%S' 2>/dev/null || date -d "@${CREATED}" '+%H:%M:%S' 2>/dev/null || echo "${CREATED}")
  printf "  [%d]  %-20s  %d window(s)  started %s  (%s)\n" "${IDX}" "${NAME}" "${WINDOWS}" "${CREATED_FMT}" "${STATE}"
  NAMES+=("${NAME}")
done <<< "${SESSIONS}"

echo ""
read -rp "  Select session [1-${IDX}]: " CHOICE

if ! [[ "${CHOICE}" =~ ^[0-9]+$ ]] || [ "${CHOICE}" -lt 1 ] || [ "${CHOICE}" -gt "${IDX}" ]; then
  echo "✗ Invalid selection"
  exit 1
fi

SELECTED="${NAMES[$((CHOICE - 1))]}"
echo ""
echo "→ Attaching to '${SELECTED}'... (detach: Ctrl+B, D)"
echo ""
exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- tmux attach -t "${SELECTED}"
