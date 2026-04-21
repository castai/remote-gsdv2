#!/bin/bash
set -euo pipefail

# ─── Remote GSD v2 Entrypoint ───────────────────────────────────────────────
# Runs GSD inside a tmux session. Attach/detach via:
#   kubectl exec -it -n gsd-remote gsd-agent-0 -- tmux attach -t gsd
#
# If you disconnect, the tmux session keeps running. Reattach anytime.
# ─────────────────────────────────────────────────────────────────────────────

WORKSPACE="${WORKSPACE:-/workspace/dev_root/oc-salesanalyzer-control}"
TMUX_SESSION="gsd"

echo "═══════════════════════════════════════════════════════════════"
echo "  GSD v2 Remote Agent (tmux mode)"
echo "  Workspace: ${WORKSPACE}"
echo ""
echo "  Attach:  kubectl exec -it -n gsd-remote gsd-agent-0 -- tmux attach -t gsd"
echo "  Detach:  Ctrl+B, D"
echo "═══════════════════════════════════════════════════════════════"

# ── Ensure workspace exists and has git ──────────────────────────────────────
if [ ! -d "${WORKSPACE}" ]; then
  echo "[entrypoint] Creating workspace at ${WORKSPACE}..."
  mkdir -p "${WORKSPACE}"
fi

cd "${WORKSPACE}"

if [ ! -d .git ]; then
  echo "[entrypoint] Initializing git repo in ${WORKSPACE}..."
  git init
fi

git config --global --get user.email >/dev/null 2>&1 || \
  git config --global user.email "gsd-agent@remote"
git config --global --get user.name >/dev/null 2>&1 || \
  git config --global user.name "GSD Remote Agent"
git config --global init.defaultBranch main

# ── Start tmux with GSD ─────────────────────────────────────────────────────
# If session already exists (container restart with preserved PVC), attach to it.
if tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
  echo "[entrypoint] Existing tmux session found. Keeping it alive."
else
  echo "[entrypoint] Starting tmux session '${TMUX_SESSION}' with GSD..."
  tmux new-session -d -s "${TMUX_SESSION}" -c "${WORKSPACE}" "gsd"
fi

echo "[entrypoint] ✓ tmux session '${TMUX_SESSION}' is running."
echo "[entrypoint] Container will stay alive. Attach with:"
echo "  kubectl exec -it -n gsd-remote gsd-agent-0 -- tmux attach -t gsd"
echo ""

# ── Keep container alive ────────────────────────────────────────────────────
# If the tmux session dies (gsd exits), restart it.
while true; do
  if ! tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
    echo "[entrypoint] tmux session ended — restarting GSD..."
    sleep 2
    tmux new-session -d -s "${TMUX_SESSION}" -c "${WORKSPACE}" "gsd"
  fi
  sleep 10
done
