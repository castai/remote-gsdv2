# Remote GSD v2

Cloud-hosted persistent GSD v2 coding agent on Kubernetes. Your AI dev environment runs in a pod — attach from any terminal, VS Code, or browser. Disconnect without killing the session. The agent keeps working.

## Architecture

```
┌─────────────────────┐                              ┌──────────────────────────────┐
│  Your Machine       │      kubectl exec -it         │  GKE Pod                     │
│                     │ ◄──────────────────────────► │  ┌──────────────────────┐    │
│  Terminal (iTerm2)  │     attach tmux session       │  │ tmux session         │    │
│  VS Code            │ ◄── code tunnel ───────────► │  │  └─ zsh (oh-my-zsh) │    │
│  Browser            │     vscode.dev/tunnel/...     │  │     └─ gsd          │    │
│                     │                               │  └──────────────────────┘    │
└─────────────────────┘                               │                              │
                                                      │  PVC: /workspace (50Gi)     │
       Disconnect? No problem.                        │  PVC: ~/.gsd (10Gi)         │
       Agent keeps coding.                            │  8 CPU / 64GB RAM           │
                                                      └──────────────────────────────┘
```

## Prerequisites

- `kubectl` configured with access to the target cluster
- `helm` 3.x
- GitHub PAT with repo access (for private repos)
- Kimchi (AI Enabler) API token

## Quick Start

### 1. Clone this repo

```bash
git clone https://github.com/castai/remote-gsdv2.git
cd remote-gsdv2
```

### 2. Create a values file for your project

```yaml
# my-project.yaml
projectName: my-project
gitRepo: "https://github.com/castai/my-project.git"
```

See `chart/examples/salesanalyzer.yaml` for a full example.

### 3. Deploy

```bash
helm install my-project ./chart/gsd-remote \
  -f my-project.yaml \
  --set githubPAT="ghp_..." \
  --set kimchiToken="your-kimchi-token" \
  --set tavilyAPIKey="tvly-..." \
  --set-file modelsJSON=~/.gsd/agent/models.json \
  --set-file projectEnv=../my-project/.env \
  --set-file preferencesMD=~/.gsd/preferences.md
```

### 4. Connect

```bash
# Auto-discover pod, attach to tmux
./connect.sh

# iTerm2 native mode (recommended on macOS — best clipboard support)
./connect.sh --iterm

# Connect to a specific project
./connect.sh -p my-project

# See what's running
./connect.sh --list
```

### 5. Start GSD

Once attached to the shell:

```bash
gsd
```

### 6. VS Code (optional)

From inside the tmux session, run:

```bash
vscode-tunnel
```

First time requires GitHub device auth — follow the URL it prints. After that, connect from:
- **VS Code desktop**: Install [Remote - Tunnels](https://marketplace.visualstudio.com/items?itemName=ms-vscode.remote-server) extension → Cmd+Shift+P → Remote-Tunnels: Connect to Tunnel
- **Browser**: `https://vscode.dev/tunnel/<project-name>`

## connect.sh Reference

```bash
./connect.sh [options] [tmux-session-name]
```

| Flag | Description |
|------|-------------|
| *(no flags)* | Auto-discover pod, attach to tmux. Picker if multiple pods/sessions. |
| `--iterm` | Use iTerm2 native tmux integration (Cmd+C/V clipboard works) |
| `--project, -p <name>` | Connect to a specific project by name |
| `--new <name>` | Create a new tmux session and attach (e.g. `--new steering`) |
| `--list, -l` | Show pods, tmux sessions, and VS Code tunnel status |
| `--namespace, -n <ns>` | Kubernetes namespace (default: `gsd-remote`) |

### Multiple Sessions

Run GSD auto-mode in one session and steer from another:

```bash
# Session 1: main agent (auto-mode)
./connect.sh --iterm

# Session 2: steering / monitoring
./connect.sh --new steering --iterm
```

## Helm Values Reference

| Value | Description | Required |
|-------|-------------|----------|
| `projectName` | Resource name suffix (e.g. `salesanalyzer` → `gsd-salesanalyzer`) | **Yes** |
| `gitRepo` | GitHub repo URL to clone on first boot | No |
| `gitBranch` | Branch to checkout | No |
| `githubPAT` | GitHub Personal Access Token for git + gh CLI | Recommended |
| `kimchiToken` | Kimchi / AI Enabler API key (the `aie` provider) | Recommended |
| `tavilyAPIKey` | Tavily search API key | No |
| `braveAPIKey` | Brave search API key | No |
| `modelsJSON` | Full `models.json` contents (`--set-file`) | Recommended |
| `preferencesMD` | GSD `preferences.md` contents (`--set-file`) | No |
| `projectEnv` | Project `.env` file contents (`--set-file`) | No |
| `extraEnv` | Additional env vars as key-value map | No |
| `image.repository` | Container image | Default: Artifact Registry |
| `image.tag` | Image tag | Default: `latest` |
| `resources.requests.cpu` | CPU request | Default: `4` |
| `resources.requests.memory` | Memory request | Default: `32Gi` |
| `resources.limits.cpu` | CPU limit | Default: `8` |
| `resources.limits.memory` | Memory limit | Default: `64Gi` |
| `persistence.workspace.size` | Workspace PVC size | Default: `50Gi` |
| `persistence.gsdHome.size` | ~/.gsd PVC size | Default: `10Gi` |
| `namespace` | Kubernetes namespace | Default: `gsd-remote` |

## Migrating an Existing Project

If your local project has a `.gsd` symlink (default GSD behavior), copy the real directory into the remote workspace so it becomes a git-trackable directory:

```bash
# From your local machine
POD=$(kubectl get pods -n gsd-remote -l gsd/project=<name> -o jsonpath='{.items[0].metadata.name}')

# 1. Copy project .gsd (milestones, decisions, database)
GSD_REAL=$(readlink -f /path/to/project/.gsd)
kubectl cp "${GSD_REAL}/" gsd-remote/"${POD}":/workspace/<name>/.gsd/

# 2. Copy skills, agents, and preferences into the pod's ~/.gsd
kubectl cp ~/.gsd/agent/skills/ gsd-remote/"${POD}":/home/gsd/.gsd/agent/skills/
kubectl cp ~/.gsd/agent/agents/ gsd-remote/"${POD}":/home/gsd/.gsd/agent/agents/
kubectl cp ~/.gsd/preferences.md gsd-remote/"${POD}":/home/gsd/.gsd/preferences.md
```

This gives you a real `.gsd/` directory (not a symlink) with all milestones, decisions, database, and activity logs — fully git-trackable. Skills and agents are also synced so GSD has the same capabilities as your local setup.

## What's in the Image

| Category | Tools |
|----------|-------|
| **Languages** | Node 22, Go 1.24, Rust stable, Python 3 |
| **AI Agent** | GSD v2 (gsd-pi 2.77.0) |
| **Cloud CLIs** | gcloud (+ GKE auth plugin), aws, kubectl, helm, terraform, docker, gh |
| **Language Servers** | gopls, typescript-language-server, pyright, ruff-lsp, yaml-language-server, bash-language-server, dockerfile-language-server, tailwindcss-language-server, vscode-langservers-extracted |
| **Go tools** | dlv, goimports, golangci-lint, gofumpt |
| **Python tools** | uv, poetry, black, ruff, mypy, pytest, pre-commit, ipython |
| **Search/Nav** | ripgrep, fd, fzf, tree |
| **DB clients** | psql, mysql, redis-cli |
| **Shell** | Oh My Zsh + autosuggestions + syntax-highlighting |
| **Editors** | vim, nano |
| **VS Code** | `vscode-tunnel` command (tunnel to pod from VS Code or browser) |

## Docker Image Layers

The Dockerfile uses 7 layers ordered by change frequency (rarest first):

```
Layer 1: System packages (apt)          ← changes rarely
Layer 2: Cloud CLIs (kubectl, gcloud…)  ← changes on CLI upgrades
Layer 3: Languages (Go, Rust)           ← changes on version bumps
Layer 4: Language servers & dev tools   ← changes on LSP upgrades
Layer 5: GSD + Python tools             ← changes on gsd-pi upgrades
Layer 6: User, dotfiles, VS Code CLI    ← changes on config tweaks
Layer 7: entrypoint.sh, scripts         ← changes often, rebuilds in seconds
```

CI uses GitHub Actions with BuildKit + registry-backed layer caching. Entrypoint-only changes rebuild in ~30s.

## Upgrading

```bash
# Update secrets/config
helm upgrade my-project ./chart/gsd-remote \
  -f my-project.yaml \
  --set githubPAT="..." \
  --set kimchiToken="..."

# Roll out a new image after a git push (CI builds automatically)
kubectl rollout restart deployment/gsd-my-project -n gsd-remote
```

## Teardown

```bash
helm uninstall my-project
# PVCs are retained — delete manually if you want to wipe the workspace:
kubectl delete pvc gsd-my-project-workspace gsd-my-project-gsd-home -n gsd-remote
```
