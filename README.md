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
# Terminal — auto-discovers your pod
./connect.sh

# Terminal — specific project
./connect.sh -p my-project

# iTerm2 native mode (best clipboard support)
./connect.sh --iterm

# VS Code tunnel — opens GitHub auth, then drops into tmux
./connect.sh --vscode
```

### 5. Start GSD

Once attached to the shell:

```bash
gsd
```

## Connection Methods

| Method | Command | Clipboard | Best For |
|--------|---------|-----------|----------|
| **tmux** | `./connect.sh` | OSC 52 | Quick terminal access |
| **iTerm2 native** | `./connect.sh --iterm` | Native Cmd+C/V | Daily driver on macOS |
| **VS Code tunnel** | `./connect.sh --vscode` | Native | Full IDE with extensions |
| **VS Code browser** | `https://vscode.dev/tunnel/<name>` | Native | Any machine, no install |

### iTerm2 Setup

Enable "Applications in terminal may access clipboard" in iTerm2 → Preferences → General → Selection.

### VS Code Setup

Install the **Remote - Tunnels** extension (`ms-vscode.remote-server`), then Cmd+Shift+P → **Remote-Tunnels: Connect to Tunnel**.

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
| `image.repository` | Container image | Default: AR |
| `image.tag` | Image tag | Default: `latest` |
| `resources.requests.cpu` | CPU request | Default: `4` |
| `resources.requests.memory` | Memory request | Default: `32Gi` |
| `resources.limits.cpu` | CPU limit | Default: `8` |
| `resources.limits.memory` | Memory limit | Default: `64Gi` |
| `persistence.workspace.size` | Workspace PVC size | Default: `50Gi` |
| `persistence.gsdHome.size` | ~/.gsd PVC size | Default: `10Gi` |
| `namespace` | Kubernetes namespace | Default: `gsd-remote` |

## Migrating an Existing Project

If your project has a `.gsd` symlink (default GSD behavior), copy the real directory into the remote workspace:

```bash
# Connect to the pod
./connect.sh

# Inside the pod — remove the empty .gsd and copy your local one:
# (from your local machine)
GSD_REAL=$(readlink -f /path/to/project/.gsd)
POD=$(kubectl get pods -n gsd-remote -l gsd/project=<name> -o jsonpath='{.items[0].metadata.name}')
kubectl cp "${GSD_REAL}/" gsd-remote/"${POD}":/workspace/<name>/.gsd/
```

This gives you a real `.gsd/` directory (not a symlink) that can be git-tracked — all milestones, decisions, database, activity logs persist with the repo.

## What's in the Image

| Category | Tools |
|----------|-------|
| **Languages** | Node 22, Go 1.24, Rust stable, Python 3 |
| **AI Agent** | GSD v2 (gsd-pi 2.77.0) |
| **Cloud CLIs** | gcloud, aws, kubectl, helm, terraform, docker, gh |
| **Language Servers** | gopls, typescript-language-server, pyright, ruff-lsp, yaml-language-server, bash-language-server, dockerfile-language-server, tailwindcss-language-server, vscode-langservers-extracted |
| **Go tools** | dlv, goimports, golangci-lint, gofumpt |
| **Python tools** | uv, poetry, black, ruff, mypy, pytest, pre-commit, ipython |
| **Search/Nav** | ripgrep, fd, fzf, tree |
| **DB clients** | psql, mysql, redis-cli |
| **Shell** | Oh My Zsh + autosuggestions + syntax-highlighting |
| **Editors** | vim, nano |

## Docker Image Layers

The Dockerfile uses 7 layers ordered by change frequency (rarest first):

```
Layer 1: System packages (apt)          ← changes rarely
Layer 2: Cloud CLIs (kubectl, gcloud…)  ← changes on CLI upgrades
Layer 3: Languages (Go, Rust)           ← changes on version bumps
Layer 4: Language servers & dev tools   ← changes on LSP upgrades
Layer 5: GSD + Python tools             ← changes on gsd-pi upgrades
Layer 6: User, dotfiles, VS Code CLI    ← changes on config tweaks
Layer 7: entrypoint.sh, connect.sh      ← changes often, rebuilds in seconds
```

CI uses BuildKit with registry-backed layer caching. Entrypoint-only changes rebuild in ~30s.

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
