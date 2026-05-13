# Quick Task: terminal-clipboard-fixes

**Date:** 2026-05-13
**Branch:** gsd/quick/3-terminal-clipboard-fixes

## What Changed

- **Auto-copy on selection (X11 primary-selection style)** in the terminal browser tab. The previous Copy button raced with iframe focus loss — xterm.js cleared the selection before `getSelection()` returned. Now a `mouseup`/shift+keyup listener inside the iframe writes the live selection to the clipboard immediately, with deduplication so the same selection isn't written twice. The Copy button still works as a fallback for when the auto-copy is blocked by browser permission policy.
- **tmux mouse-mode hint banner.** Remote pod sessions run inside tmux with `set -g mouse on`, which intercepts normal mouse drags so xterm.js never sees a real selection — the highlight appears during the drag then vanishes on release. xterm respects the standard escape: hold Option/Alt while dragging to bypass tmux's mouse capture and produce a real selection that auto-copy can grab. Added a visible `⌥-drag to select` hint in the terminal title bar and updated the Copy button title so users know about the modifier without digging into tmux docs.
- **Same-origin ttyd reverse proxy** so the iframe shares the dashboard's origin. ttyd ran on its own port (e.g. localhost:7700) while the dashboard was on localhost:3001 — different origins mean the outer page silently couldn't access `iframe.contentDocument` or call `iframe.contentWindow.term.getSelection()`, so the selection-capture listeners never attached. Added a built-in HTTP proxy at `/ttyd/<port>/*` (using node:http's `httpRequest`) and a WebSocket upgrade proxy on the underlying server (using node:net) that forwards `/ttyd/<port>/ws` to `ws://127.0.0.1:<port>/ws`. The iframe now loads `/ttyd/<port>/...` on the same origin, making the selection listeners actually work. Validates the requested port is one of the currently-running ttyd ports tracked in `ttydProcs` to prevent open-proxy abuse.
- **Image paste support.** When the user pastes an image (e.g. a screenshot) into the terminal page, the blob is uploaded via `POST /api/clipboard-image` to `/tmp/clipboard-<timestamp>-<rand>.<ext>` and a `[image: /tmp/...]` reference is injected into the terminal through the existing bracketed-paste WebSocket so the agent inside tmux can read it.
- **New endpoint `POST /api/clipboard-image`** accepts raw image bytes (`Content-Type: image/png|jpeg|gif|webp`), validates content-type and size (25mb limit), persists to `/tmp/`, and returns `{ path, bytes }`. Uses `express.raw` middleware scoped to the route to avoid touching the global JSON body parser.
- **Visual feedback via the status dot** — flashes amber with a tooltip ("Selection copied", "Image pasted: /tmp/...") for ~600ms after each copy or paste action.

## Files Modified

- `dashboard/server.js` — added `/api/clipboard-image` route; replaced the inline terminal-page script's `copyTerminalSelection` with cached-selection logic; added auto-copy on selection, image-paste handler, status flash helper, and iframe-load wiring for selection capture.

## Verification

- `curl -X POST http://localhost:3001/api/clipboard-image -H 'Content-Type: image/png' --data-binary @file.png` returns `{path,bytes}` and writes the file to `/tmp/`. Confirmed the saved file matches the input bytes.
- Loaded `http://localhost:3001/terminal-page/remote_gsdv2` and confirmed the served HTML contains `autoCopyIfNew`, `handleImagePaste`, and `cachedSelection` definitions (grep -c → 8 matches).
- Dashboard server starts cleanly and `/api/health` returns ok.
- The X-style auto-copy uses xterm's `getSelection()` polled on iframe `mouseup`/`keyup` with a 30ms delay, so a user mouse-drag-release naturally triggers a clipboard write before the user can move focus away. Dedup via `lastWrittenSelection` prevents redundant writes on identical selections.
