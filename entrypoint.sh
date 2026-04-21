#!/bin/bash
set -euo pipefail

# ─── Remote GSD v2 Entrypoint ───────────────────────────────────────────────
# Starts gsd in web mode. `gsd --web` spawns a Next.js server as a daemon
# and exits. We start it once, then keep the container alive with a health
# monitor that only restarts if the web server actually stops responding.
# ─────────────────────────────────────────────────────────────────────────────

GSD_PORT="${GSD_PORT:-3000}"
GSD_HOST="${GSD_HOST:-0.0.0.0}"
WORKSPACE="${WORKSPACE:-/workspace}"

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

git config --global --get user.email >/dev/null 2>&1 || \
  git config --global user.email "gsd-agent@remote"
git config --global --get user.name >/dev/null 2>&1 || \
  git config --global user.name "GSD Remote Agent"

# ── Start gsd web mode ──────────────────────────────────────────────────────
# gsd --web spawns the Next.js server and exits. The server runs as a
# background daemon managed by gsd's own process management.
echo "[entrypoint] Starting GSD web mode..."
cd "${WORKSPACE}"
gsd --web --host "${GSD_HOST}" --port "${GSD_PORT}" 2>&1 | tee /tmp/gsd-web.log

# ── Wait for web server to be ready ─────────────────────────────────────────
echo "[entrypoint] Waiting for web UI on port ${GSD_PORT}..."
RETRIES=0
while ! curl -sf "http://127.0.0.1:${GSD_PORT}" >/dev/null 2>&1; do
  RETRIES=$((RETRIES + 1))
  if [ ${RETRIES} -ge 120 ]; then
    echo "[entrypoint] ERROR: Web UI did not start within 120s"
    tail -30 /tmp/gsd-web.log 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo "[entrypoint] ✓ GSD web UI is ready on http://${GSD_HOST}:${GSD_PORT}"
echo "[entrypoint] Token URL:"
grep -o 'http.*#token=.*' /tmp/gsd-web.log || true
echo ""
echo "[entrypoint] Session is persistent — survives client disconnects."

# ── Keep container alive, health-check the web server ────────────────────────
# Only restart if the web server actually stops responding (3 consecutive failures).
FAIL_COUNT=0
while true; do
  if curl -sf "http://127.0.0.1:${GSD_PORT}" >/dev/null 2>&1; then
    FAIL_COUNT=0
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "[entrypoint] Health check failed (${FAIL_COUNT}/3)"
    if [ ${FAIL_COUNT} -ge 3 ]; then
      echo "[entrypoint] Web server unresponsive — restarting GSD..."
      pkill -f "node.*server.js" 2>/dev/null || true
      sleep 3
      cd "${WORKSPACE}"
      gsd --web --host "${GSD_HOST}" --port "${GSD_PORT}" 2>&1 | tee /tmp/gsd-web.log
      FAIL_COUNT=0
      # Wait for it to come back
      sleep 10
    fi
  fi
  sleep 15
done
