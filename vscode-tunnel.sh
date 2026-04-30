#!/bin/bash
# Start VS Code tunnel for remote IDE access in the background.
# If you need to re-auth, run: code tunnel user login --provider github
#
# Connect from:
#   VS Code:  Cmd+Shift+P → Remote-Tunnels: Connect to Tunnel
#   Browser:  https://vscode.dev/tunnel/<name>

NAME="${1:-${PROJECT_NAME:-gsd-remote}}"
LOG="/tmp/vscode-tunnel-${NAME}.log"

# Check if already running (exclude this script and bash wrappers)
if pgrep -f "code tunnel" | xargs ps -o cmd= 2>/dev/null | grep -vE '(vscode-tunnel|/bin/bash)' | grep -q .; then
  echo "✓ VS Code tunnel already running"
  echo "  → https://vscode.dev/tunnel/${NAME}"
  echo "  → Log: ${LOG}"
  echo ""
  echo "  To stop: pkill -f 'code tunnel'"
  exit 0
fi

# If we're inside tmux, launch a dedicated background window
if [ -n "${TMUX}" ]; then
  # Kill any stale tunnel window from a previous run
  tmux list-windows -t "$(tmux display-message -p '#S')" -F '#{window_index}:#{window_name}' 2>/dev/null | \
    grep ':tunnel$' | cut -d: -f1 | xargs -I{} tmux kill-window -t {} 2>/dev/null

  echo "Starting VS Code tunnel '${NAME}' in a new tmux window..."
  tmux new-window -d -n tunnel "code tunnel --name '${NAME}' --accept-server-license-terms 2>&1 | tee '${LOG}'; exec bash"
  sleep 1
  echo "✓ Tunnel window created. Attach to it with: tmux select-window -t tunnel"
  echo "  → https://vscode.dev/tunnel/${NAME}"
  echo "  → Log: tail -f ${LOG}"
  echo "  → To stop: tmux kill-window -t tunnel   or   pkill -f 'code tunnel'"
  exit 0
fi

# Not in tmux — background with nohup
echo "Starting VS Code tunnel '${NAME}' in the background..."
nohup code tunnel --name "${NAME}" --accept-server-license-terms > "${LOG}" 2>&1 &
sleep 1

if pgrep -f "code tunnel" | xargs ps -o cmd= 2>/dev/null | grep -vE '(vscode-tunnel|/bin/bash)' | grep -q .; then
  echo "✓ Tunnel started in background"
  echo "  → https://vscode.dev/tunnel/${NAME}"
  echo "  → Log: tail -f ${LOG}"
  echo "  → To stop: pkill -f 'code tunnel'"
else
  echo "✗ Tunnel failed to start. Last log lines:"
  tail -20 "${LOG}" 2>/dev/null
fi
