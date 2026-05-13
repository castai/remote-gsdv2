# Quick Task: terminal-clipboard-fixes

**Date:** 2026-05-13
**Branch:** gsd/quick/3-terminal-clipboard-fixes

## What Changed

- **Auto-copy on selection (X11 primary-selection style)** in the terminal browser tab. The previous Copy button raced with iframe focus loss — xterm.js cleared the selection before `getSelection()` returned. Now a `mouseup`/shift+keyup listener inside the iframe writes the live selection to the clipboard immediately, with deduplication so the same selection isn't written twice. The Copy button still works as a fallback for when the auto-copy is blocked by browser permission policy.
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
