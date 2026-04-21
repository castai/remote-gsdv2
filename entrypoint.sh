#!/bin/bash
set -euo pipefail

# ─── Remote GSD v2 Entrypoint ───────────────────────────────────────────────
# Starts gsd in web mode inside a tmux session so it survives disconnects.
# The web UI binds to 0.0.0.0:3000 for port-forwarding access.
# ─────────────────────────────────────────────────────────────────────────────

GSD_PORT="${GSD_PORT:-3000}"
GSD_HOST="${GSD_HOST:-0.0.0.0}"
WORKSPACE="${WORKSPACE:-/workspace}"
TMUX_SESSION="gsd-agent"

echo "═══════════════════════════════════════════════════════════════"
echo "  GSD v2 Remote Agent"
echo "  Web UI: http://${GSD_HOST}:${GSD_PORT}"
echo "  Workspace: ${WORKSPACE}"
echo "═══════════════════════════════════════════════════════════════"

# ── Ensure workspace has git init (gsd requires it) ─────────────────────────
cd "${WORKSPACE}"
if [ ! -d .git ]; then
  echo "[entrypoint] Initializing git repo in ${WORKSPACE}..."
  git config --global user.email "gsd-agent@remote"
  git config --global user.name "GSD Remote Agent"
  git config --global init.defaultBranch main
  git init
fi

# ── Configure git globally if not set ────────────────────────────────────────
git config --global --get user.email >/dev/null 2>&1 || \
  git config --global user.email "gsd-agent@remote"
git config --global --get user.name >/dev/null 2>&1 || \
  git config --global user.name "GSD Remote Agent"

# ── Start gsd web mode inside tmux ──────────────────────────────────────────
# tmux keeps the process alive even if no client is attached.
# The web UI (Next.js) serves both the browser interface and the RPC endpoint.

# Kill any stale tmux session
tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true

echo "[entrypoint] Starting GSD web mode in tmux session '${TMUX_SESSION}'..."
tmux new-session -d -s "${TMUX_SESSION}" \
  "cd ${WORKSPACE} && exec gsd --web --host ${GSD_HOST} --port ${GSD_PORT} 2>&1 | tee /tmp/gsd-web.log"

# ── Wait for web server to be ready ─────────────────────────────────────────
echo "[entrypoint] Waiting for web UI on port ${GSD_PORT}..."
RETRIES=0
MAX_RETRIES=60
while ! curl -sf "http://127.0.0.1:${GSD_PORT}" >/dev/null 2>&1; do
  RETRIES=$((RETRIES + 1))
  if [ ${RETRIES} -ge ${MAX_RETRIES} ]; then
    echo "[entrypoint] ERROR: Web UI did not start within ${MAX_RETRIES}s"
    echo "[entrypoint] Last log output:"
    tail -20 /tmp/gsd-web.log 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo "[entrypoint] ✓ GSD web UI is ready on http://${GSD_HOST}:${GSD_PORT}"
echo "[entrypoint] Agent session is persistent — survives client disconnects."
echo ""

# ── Keep the container alive ─────────────────────────────────────────────────
# Monitor tmux session; if gsd crashes, restart it.
while true; do
  if ! tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
    echo "[entrypoint] GSD session died — restarting..."
    tmux new-session -d -s "${TMUX_SESSION}" \
      "cd ${WORKSPACE} && exec gsd --web --host ${GSD_HOST} --port ${GSD_PORT} 2>&1 | tee /tmp/gsd-web.log"
    sleep 5
  fi
  sleep 10
done
