# GSD Control Plane — Dashboard

A browser-based control plane for monitoring and interacting with GSD agent instances — remote Kubernetes pods and local dev environments. Shows live milestone/slice state on a kanban board, provides terminal access, and lets you track freeform work sessions alongside formal GSD milestones.

```
Browser (5s poll + SSE) → Express :3001 → kubectl exec pod / local FS → python3 reads .gsd/ → JSON
```

## Quick start

```bash
cd dashboard
npm install
node server.js
# open http://localhost:3001
```

## What you see

### Board

Six phase columns matching the GSD lifecycle: **Discussing → Researching → Planning → Executing → Validating → Done**

- **Milestone cards** — colour-coded by attention state (red=Errored, orange=Blocked, yellow=QuestionPending/AwaitingVerification, green=Healthy). Coloured left bar indicates the instance. Click to open the slide-over panel.
- **Quick task chips** (⚡) — GSD quick tasks, shown in Done when complete. In-progress tasks (directory exists, no summary yet) appear in Executing with a 🔧 amber badge.
- **Vibe Cards** — freeform session-tracking cards. Visually distinct with a purple dashed border. Drag to any column to change lane.

### Header controls

| Control | Description |
|---|---|
| **Board / Attention** tabs | Switch between full board and cards needing human action |
| **Instances** dropdown | Show/hide cards by instance |
| **Done: Last Xd** | Filter how far back Done cards show |
| **Show hidden (N)** | Reveal cards hidden with ✕. Only appears when there are hidden cards. |
| **+ Vibe** | Open the Vibe Card create modal |

### Card actions

- **✕ button** (hover on any milestone card or quick chip) — hides the card. State persists in localStorage across reloads.
- **👁 button** (when "Show hidden" is active) — restores a hidden card.

### Slide-over panel

Click any milestone card to open the detail panel: slices, tasks, runtime state, VS Code link, and recent journal activity with live SSE updates.

---

## Vibe Cards

Vibe Cards are freeform board cards you manage manually. They live alongside milestone cards in the same phase columns and survive server restarts.

### Creating a card

Click **+ Vibe** in the header. Fill in:

| Field | Description |
|---|---|
| Title | Required. Slug-derived ID shown below. |
| Description | Optional free-text context. |
| Comments | Append-only thought stream (edit mode only). |
| Lane | Which board column the card lives in. |
| Priority | low / medium / high. |
| Color | Card accent color. |
| Instance | Associate with a GSD instance. |
| Session | tmux session (loaded from the chosen instance). |
| Jira URL | Clickable link shown on the card face. |
| Labels | Comma-separated tags shown as chips. |
| Linked quick task ID | Enter a GSD quick task number to merge with it (see below). |

### Comments

Click an existing Vibe Card to open edit mode. The Comments section (below Description) shows a threaded log of notes. Type in the compose area and click **Add**. Hover a comment to reveal the ✕ delete button. Comments persist in `vibe-cards.json`.

### Drag to move

Drag a Vibe Card to any column. The lane is saved immediately via PATCH and survives browser reload.

### Linking to a GSD quick task

Set **Linked quick task ID** to a quick task number (e.g. `2`). Once that task's directory appears in `.gsd/quick/`, the board:

- Shows a merged **"Vibe + Task"** card with a blue border and ⚡ badge
- Suppresses the standalone quick chip to avoid duplication
- Automatically moves the Vibe Card to Done when the quick task completes (summary written)

If you drag the Vibe Card back out of Done, the done quick chip reappears independently.

---

## Instances

### Adding an instance

Click **+ Add** in the sidebar. Fill in the display name and click **Browse…** to pick the project directory with a native macOS folder picker. The path must contain a `.gsd/` directory.

For Kubernetes pod instances, edit `instances.json` directly:

```json
{
  "name": "salesanalyzer",
  "pod": "gsd-salesanalyzer-7cc96c56f8-j4j9p",
  "namespace": "lk-gsd",
  "gsdPath": "/home/gsd/workspace/salesanalyzer/.gsd",
  "vscodeTunnelUrl": "https://vscode.dev/tunnel/salesanalyzer",
  "tmuxSession": "gsd"
}
```

For local instances:

```json
{
  "name": "my-local-project",
  "localPath": "/path/to/project/.gsd",
  "tmuxSession": "gsd"
}
```

### Removing an instance

Click **✕** next to the instance name in the sidebar. First click shows "Sure?" — click again to confirm. The instance is removed from `instances.json` immediately.

### Instance config fields

| Field | Description |
|---|---|
| `name` | Display name |
| `pod` | Kubernetes pod name (pod mode) |
| `namespace` | Kubernetes namespace (default: `lk-gsd`) |
| `gsdPath` | Path to `.gsd/` inside the pod |
| `localPath` | Path to `.gsd/` on this machine |
| `vscodeTunnelUrl` | Shows "Open VS Code" in slide-over |
| `tmuxSession` | Default tmux session name for terminal access |

---

## Terminal access

Click a tmux session row in the sidebar to open a terminal tab. Pod sessions use `kubectl exec`; local sessions use `ttyd`. Session preference is remembered per instance.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server listen port |
| `POLL_INTERVAL_MS` | `5000` | Instance poll frequency |
| `INSTANCES_FILE` | `./instances.json` | Instance config path |
| `VIBE_CARDS_FILE` | `./vibe-cards.json` | Vibe Card store path |
| `DEBUG` | unset | Set to `1` for verbose poll timing logs |

---

## Architecture

```
dashboard/
  server.js              Express backend — polling, SSE, CRUD routes
  reader.js              kubectl exec / local transport + inline Python reader
  derive.js              Pure phase/attention derivation (unit-tested)
  derive.test.js         Unit tests: node --test dashboard/derive.test.js
  instances.json         Instance configs (add/remove instances here)
  vibe-cards.json        Vibe Card store (managed by server, don't edit manually)
  terminal-prefs.json    Terminal font/size preferences
  gsd-journal-watcher.py Redis pubsub watcher for real-time SSE journal events
  public/
    index.html           Single-file SPA — no build step, vanilla JS
  scripts/
    verify-vibe-cards-api.mjs    Runtime API verifier (self-hosted)
    verify-vibe-cards-board.mjs  Playwright board verifier (render/drag/modal modes)
```

### Data flow

```
5s poll + SSE event
  → poll() fetches /api/instances + fetchVibeCards()
  → render() → renderBoard() composes milestone cards, Vibe Cards, quick chips
  → Vibe Card merge: linked quick tasks suppressed, merged badge shown
  → Auto-move: Vibe Card PATCHed to done when linked task completes
```

### Persistence

All server-side state lives in JSON files in the `dashboard/` directory — the same pattern as `instances.json`. No database. Files are loaded at startup, written on every mutation, with rollback if the write fails.

| File | Contents |
|---|---|
| `instances.json` | Instance configs |
| `vibe-cards.json` | Vibe Cards with comments, metadata, lane |

### Real-time updates

Server-Sent Events (`/api/events`) push Redis pubsub messages from the GSD journal watcher. The browser triggers an immediate poll on each meaningful event. 5s polling continues as a fallback when SSE/Redis is down.

---

## Running the verifiers

```bash
# API CRUD + restart persistence
node dashboard/scripts/verify-vibe-cards-api.mjs

# Board render verification
npm --prefix dashboard run verify:vibe-cards:board:render

# Drag persistence
npm --prefix dashboard run verify:vibe-cards:board:drag
```

Each verifier self-hosts the real `dashboard/server.js` on an isolated port so it never depends on the running local instance.
