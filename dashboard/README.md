# GSD Control Plane — Browser POC

A read-only browser dashboard that shows live state from one or more remote GSD instances (Kubernetes pods or local directories). Zero changes to existing pods. Zero new pod infrastructure.

```
Browser (5s poll) → Express :3001 → kubectl exec pod → python3 reads .gsd/ files → JSON
```

## What you see

- **Six phase columns**: Discussing / Researching / Planning / Executing / Validating / Done
- **Cards** colour-coded by attention state (red=Errored, orange=Blocked, yellow=Awaiting, grey=Healthy)
- **Attention queue tab** listing only cards that need human action
- **Slide-over panel** with slices, tasks, runtime state, VS Code link, and recent journal activity
- **Auto-refreshes** every 5 seconds without page reload

## Install and run

```bash
cd dashboard
npm install
node server.js
# open http://localhost:3001
```

## Configure instances

Edit `dashboard/instances.json`:

```json
[
  {
    "name": "salesanalyzer",
    "pod": "gsd-salesanalyzer-7cc96c56f8-j4j9p",
    "namespace": "lk-gsd",
    "gsdPath": "/home/gsd/workspace/salesanalyzer/.gsd",
    "vscodeTunnelUrl": "https://vscode.dev/tunnel/salesanalyzer"
  },
  {
    "name": "my-local-project",
    "localPath": "/path/to/project/.gsd"
  }
]
```

| Field | Description |
|---|---|
| `name` | Display name on the board |
| `pod` | Kubernetes pod name (pod mode) |
| `namespace` | Kubernetes namespace (default: `lk-gsd`) |
| `gsdPath` | Path to `.gsd/` directory *inside the pod* |
| `localPath` | Path to `.gsd/` directory on *this machine* (local mode) |
| `vscodeTunnelUrl` | Optional — shows "Open VS Code" button in slide-over |

Use `pod` + `namespace` + `gsdPath` for remote pods, or `localPath` for local directories. After editing `instances.json`, restart the server.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |
| `POLL_INTERVAL_MS` | `5000` | How often to poll each instance |
| `INSTANCES_FILE` | `./instances.json` | Path to instance config file |
| `DEBUG` | unset | Set to `1` to log kubectl latency per poll |

## How it works

The dashboard reads five files from each GSD instance's `.gsd/` directory:

| File | What it provides |
|---|---|
| `state-manifest.json` | Full milestone/slice/task hierarchy and statuses |
| `runtime/paused-session.json` | What's currently running and why it's paused |
| `runtime/stuck-state.json` | Recent unit errors and recovery attempts |
| `notifications.jsonl` | Unread warnings and errors |
| `journal/YYYY-MM-DD.jsonl` | Last 10 live activity events |

For pod instances, the server runs a Python3 script inside the pod via `kubectl exec`. No GSD DB access is needed — all data comes from plain files.

## Adding a new pod instance

1. Find the pod name: `kubectl get pods -n lk-gsd`
2. Find the `.gsd/` path: `kubectl exec -n lk-gsd <pod> -- find /home -name gsd.db -maxdepth 6 2>/dev/null`
3. Add to `instances.json`
4. Restart server

## Architecture

```
dashboard/
  instances.json      ← instance configs (edit this)
  server.js           ← Express backend, warm cache, background polling
  reader.js           ← kubectl exec transport + inline Python script
  derive.js           ← pure phase/attention derivation (unit-tested)
  derive.test.js      ← 14 unit tests: node --test dashboard/derive.test.js
  public/
    index.html        ← single-file SPA, no build step
  package.json
```

## Current limitations (POC scope)

- **Read-only** — no write operations, no steering, no Q&A interaction
- **kubectl access required** — server must have kubectl configured for the target cluster
- **No auth** — anyone who can reach localhost:3001 sees everything
- **5s polling** — not real-time push (good enough for the POC)
- **state-manifest.json lag** — the manifest updates at unit boundaries, not continuously; live in-progress state is supplemented from `paused-session.json`
