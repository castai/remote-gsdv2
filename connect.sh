#!/bin/bash
set -euo pipefail

# ─── GSD Remote Connect ─────────────────────────────────────────────────────
# Connect to a remote GSD agent running in Kubernetes.
# Lists available tmux sessions and lets you pick one, or attaches directly
# if there's only one.
#
# Usage:
#   ./connect.sh              # interactive session picker
#   ./connect.sh gsd          # attach directly to session named 'gsd'
# ─────────────────────────────────────────────────────────────────────────────

NAMESPACE="${GSD_NAMESPACE:-gsd-remote}"
POD="${GSD_POD:-gsd-agent-0}"

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

# ── Direct attach if session name given ──────────────────────────────────────
if [ -n "${1:-}" ]; then
  echo "→ Attaching to tmux session '${1}' on ${POD}..."
  exec kubectl exec -it -n "${NAMESPACE}" "${POD}" -- tmux attach -t "${1}"
fi

# ── List sessions ────────────────────────────────────────────────────────────
SESSIONS=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created}|#{?session_attached,attached,detached}' 2>/dev/null || true)

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
