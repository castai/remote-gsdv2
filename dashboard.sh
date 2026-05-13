#!/bin/bash
# ─── GSD Dashboard ────────────────────────────────────────────────────────────
# Start the GSD Control Plane dashboard.
#
# Usage:
#   ./dashboard.sh          # start on default port 3001
#   ./dashboard.sh --port 3002
#   ./dashboard.sh --open   # also open browser
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$SCRIPT_DIR/dashboard"
PORT=3001
OPEN_BROWSER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p) PORT="$2"; shift 2 ;;
    --open|-o) OPEN_BROWSER=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--port PORT] [--open]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Check node
if ! command -v node &>/dev/null; then
  echo "Error: node not found in PATH" >&2
  exit 1
fi

# Install deps if needed
if [[ ! -d "$DASHBOARD_DIR/node_modules" ]]; then
  echo "Installing dashboard dependencies..."
  npm --prefix "$DASHBOARD_DIR" install --silent
fi

echo "Starting GSD dashboard on http://localhost:${PORT}"

if $OPEN_BROWSER; then
  # Give server a moment to bind before opening
  (sleep 1 && open "http://localhost:${PORT}") &
fi

PORT="$PORT" node "$DASHBOARD_DIR/server.js"
