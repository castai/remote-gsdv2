#!/bin/bash
# Start VS Code tunnel for remote IDE access.
# Run this inside your tmux session. First time requires GitHub auth.
#
# After it's running, connect from:
#   VS Code:  Cmd+Shift+P → Remote-Tunnels: Connect to Tunnel
#   Browser:  https://vscode.dev/tunnel/<name>

NAME="${1:-${PROJECT_NAME:-gsd-remote}}"

# Check if already running
if pgrep -f "code.*tunnel" >/dev/null 2>&1; then
  echo "✓ VS Code tunnel already running"
  echo "  → https://vscode.dev/tunnel/${NAME}"
  echo ""
  echo "  To stop: pkill -f 'code.*tunnel'"
  exit 0
fi

echo "Starting VS Code tunnel '${NAME}'..."
echo "Connect from VS Code or browser once it's ready."
echo ""
exec code tunnel --name "${NAME}" --accept-server-license-terms
