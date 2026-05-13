# Quick Task: terminal-clipboard-fixes

**Date:** 2026-05-13
**Branch:** gsd/quick/3-terminal-clipboard-fixes

## What Changed

- **Auto-copy on selection (X11 primary-selection style)** in the terminal browser tab. Mouseup inside the iframe writes the live xterm selection straight to the clipboard, with dedup so the same selection isn't written twice. The Copy button stays as a manual fallback.
- **Same-origin ttyd reverse proxy** so the iframe shares the dashboard origin. ttyd ran on its own port (e.g. localhost:7700) while the dashboard was on localhost:3001 — different origins mean the outer page silently couldn't access `iframe.contentDocument`, so the selection-capture listeners never attached. Added an HTTP proxy at `/ttyd/<port>/*` and a WebSocket upgrade proxy that forwards to `127.0.0.1:<port>`. The iframe now loads `/ttyd/<port>/...` on the same origin. Validates the port against `ttydProcs` to prevent open-proxy abuse.
- **Tmux mouse-mode toggle + default off in pod.** Pod sessions run inside tmux with `set -g mouse on` baked into the Dockerfile, which intercepts mouse drags so xterm.js never sees a real selection. Flipped the Dockerfile default to `mouse off`, added a "Mouse: on/off" toggle button in the terminal title bar that calls a new `POST /api/terminal/:name/mouse` endpoint (kubectl exec → `tmux set -g mouse <flag>`), with per-instance localStorage persistence.
- **Image paste with pod-aware routing.** `POST /api/clipboard-image?instance=<name>` accepts raw image bytes (`Content-Type: image/*`, 25mb limit) and writes to `/tmp/clipboard-<timestamp>-<rand>.<ext>`. For pod instances the file is also `kubectl cp`'d into the pod's `/tmp/` so the agent running there can read it, and the returned `path` is the pod-side path. A `[image: /tmp/...]` reference is injected into the active xterm session via `term.paste()` so the data reaches the live terminal session (not a phantom ttyd session). Listener attached to both outer page and iframe document so paste works whether either has focus. Reentry guard prevents double-fire from both listeners catching the same event.
- **Removed duplicate Cmd+V keydown handlers** that were also calling `pasteFromClipboard`. The native `paste` event fires on Cmd+V naturally — having both keydown and paste handlers caused image bytes to be processed twice and produced garbage characters in the terminal.
- **Persist Done-window filter in localStorage.** The "Done: Last 7d" select now remembers the user's choice across page reloads.

## Files Modified

- `dashboard/server.js` — terminal-page inline script (auto-copy on selection, image paste handler, mouse toggle button, paste via `term.paste()`); new endpoints `POST /api/clipboard-image`, `POST /api/terminal/:name/mouse`; ttyd HTTP and WS reverse proxy.
- `dashboard/public/index.html` — Done-window filter localStorage persistence.
- `Dockerfile` — tmux `set -g mouse off` default.
- `.gsd/quick/3-terminal-clipboard-fixes/3-SUMMARY.md` — this file.

## Verification

- Selection in pod terminal (salesanalyzer/gsd) auto-copies to OS clipboard on mouseup — confirmed visually via status-dot flash and verified by pasting elsewhere.
- Image paste in pod terminal: screenshot → Cmd+V → status dot flashes "Pod image: /tmp/clipboard-...png" → `[image: /tmp/clipboard-...png]` typed in prompt → `kubectl exec ... ls /tmp/` shows the file on the pod side.
- Mouse toggle: `curl -X POST .../api/terminal/salesanalyzer/mouse -d '{"enabled":true,"session":"gsd"}'` succeeds; `kubectl exec ... tmux show-options -g mouse` reflects the state change.
- ttyd proxy: `curl http://localhost:3001/ttyd/<port>/` returns 200 from the actual ttyd; the iframe loads via the proxy and the WS handshake succeeds.
- Garbage characters from duplicate paste handlers — gone after removing the keydown shadows; verified by repeating the image paste flow several times with no extraneous output.
