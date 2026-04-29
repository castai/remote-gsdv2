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
                                                      │  PVC: /home/gsd (50Gi)      │
       Disconnect? No problem.                        │  8 CPU / 64GB RAM           │
       Agent keeps coding.                            │                              │
                                                      └──────────────────────────────┘
```

### Persistence Model

Everything lives on a single PVC mounted at `/home/gsd` and survives pod restarts:

```
/home/gsd/                 ← PVC (50Gi)
  .gsd/                    ← GSD agent state, models, auth
  .git-credentials         ← written by init container from K8s Secret
  .oh-my-zsh/              ← shell config
  .cargo/, .rustup/        ← Rust toolchain
  workspace/
    salesanalyzer/          ← repo clone + project .env
```

On **first boot**, the init container seeds `/home/gsd` from a skeleton snapshot baked into the image. On subsequent restarts, the PVC already has everything — only secrets are re-written from the K8s Secret (source of truth).

The entrypoint then clones the repo (if not already present), installs the project `.env`, and configures git/gh credentials from the PVC-backed files.

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

### 2. Create a local secrets file

Secrets are stored locally in `secrets/` (gitignored, never committed):

```bash
mkdir -p secrets

cat > secrets/my-project.env << 'EOF'
GITHUB_PAT=github_pat_...
KIMCHI_TOKEN=your-kimchi-token-here
EOF

chmod 600 secrets/my-project.env
```

### 3. Create a values file for your project

```yaml
# chart/examples/my-project.yaml
projectName: my-project
gitRepo: "https://github.com/org/my-project.git"
rbac:
  enabled: true  # only for dev clusters
```

See `chart/examples/salesanalyzer.yaml` for a reference.

### 4. Deploy

```bash
# Source secrets and deploy
source secrets/my-project.env

# Namespace is intentionally NOT helm-managed — bootstrap it once.
# This is what makes `helm uninstall` safe (it can't cascade-delete the PVC).
kubectl create namespace lk-gsd 2>/dev/null || true

helm install my-project ./chart/gsd-remote \
  -f chart/examples/my-project.yaml \
  --namespace lk-gsd \
  --set "githubPAT=${GITHUB_PAT}" \
  --set "kimchiToken=${KIMCHI_TOKEN}" \
  --set-file modelsJSON=~/.gsd/agent/models.json \
  --set-file projectEnv=../my-project/.env
```

### 5. Connect

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

### 6. Start GSD

Once attached to the shell:

```bash
gsd
```

### 7. VS Code (optional)

From inside the tmux session, run:

```bash
vscode-tunnel
```

First time requires GitHub device auth — follow the URL it prints. After that, connect from:
- **VS Code desktop**: Install [Remote - Tunnels](https://marketplace.visualstudio.com/items?itemName=ms-vscode.remote-server) extension → Cmd+Shift+P → Remote-Tunnels: Connect to Tunnel
- **Browser**: `https://vscode.dev/tunnel/<project-name>`

## Secrets Management

**Never commit secrets.** The `secrets/` directory is gitignored.

```
secrets/
  salesanalyzer.env    # GITHUB_PAT, KIMCHI_TOKEN for the salesanalyzer project
  another-project.env  # separate secrets per project
```

Each `.env` file contains the helm `--set` values:

```bash
GITHUB_PAT=github_pat_...
KIMCHI_TOKEN=04f606...
```

### GitHub PAT Requirements

The PAT needs access to the repo you're cloning. Fine-grained PATs must explicitly include the target repository.

| Use case | Required scope |
|----------|---------------|
| Clone private repo | Contents: Read |
| Push commits (GSD auto-mode) | Contents: Read & Write |
| Create issues/PRs | Issues/PRs: Read & Write |
| Full dev workflow | Contents, Issues, PRs, Workflows: Read & Write |

**Gotcha:** Fine-grained PATs are scoped to specific repos. If the clone fails with `403 Write access to repository not granted`, the PAT doesn't include that repo — edit it at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens) and add the repo.

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
| `--namespace, -n <ns>` | Kubernetes namespace (default: `lk-gsd`) |

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
| `githubPAT` | GitHub PAT for git + gh CLI (store in `secrets/`) | Recommended |
| `kimchiToken` | Kimchi / AI Enabler API key — the `aie` provider (store in `secrets/`) | Recommended |
| `tavilyAPIKey` | Tavily search API key | No |
| `braveAPIKey` | Brave search API key | No |
| `modelsJSON` | Full `models.json` contents (`--set-file`) | Recommended |
| `preferencesMD` | GSD `PREFERENCES.md` contents (`--set-file`) | No |
| `projectEnv` | Project `.env` file contents (`--set-file`) | No |
| `extraEnv` | Additional env vars as key-value map | No |
| `rbac.enabled` | Grant pod cluster-admin access (dev only) | No |
| `image.repository` | Container image | Default: Artifact Registry |
| `image.tag` | Image tag | Default: `latest` |
| `resources.requests.cpu` | CPU request | Default: `4` |
| `resources.requests.memory` | Memory request | Default: `32Gi` |
| `resources.limits.cpu` | CPU limit | Default: `8` |
| `resources.limits.memory` | Memory limit | Default: `64Gi` |
| `persistence.size` | PVC size for home + workspace | Default: `50Gi` |
| `persistence.storageClass` | Storage class | Default: `standard-rwo` |
| `namespace` | Kubernetes namespace | Default: `lk-gsd` |

## Upgrading

```bash
# Source secrets, then upgrade
source secrets/my-project.env

helm upgrade my-project ./chart/gsd-remote \
  -f chart/examples/my-project.yaml \
  --set "githubPAT=${GITHUB_PAT}" \
  --set "kimchiToken=${KIMCHI_TOKEN}" \
  --set-file modelsJSON=~/.gsd/agent/models.json \
  --set-file projectEnv=../my-project/.env
```

When secrets or config change, `helm upgrade` recreates the pod (the deployment has a `checksum/secrets` annotation). The home dir PVC persists — only secrets are overwritten by the init container.

When only the Docker image changes (pushed by CI on merge to main):

```bash
kubectl rollout restart deployment/gsd-my-project -n lk-gsd
```

### Resetting the Home Directory

If dotfiles or tooling get corrupted on the PVC, delete the sentinel to force a re-seed from the image skeleton on next restart:

```bash
kubectl exec -n lk-gsd <pod> -- rm /home/gsd/.home-initialized
kubectl rollout restart deployment/gsd-my-project -n lk-gsd
```

## Lifecycle: stop, restart, destroy

The chart is structured so `helm uninstall` is **safe** — it removes the workload but preserves your home directory. The namespace is bootstrapped outside helm and the PVC carries `helm.sh/resource-policy: keep`, so neither is touched by an uninstall. Data destruction requires an explicit `nuke`.

```bash
# Stop the agent — keeps PVC, namespace, and /home/gsd intact.
# Re-running `up` reattaches the same disk and you're back where you left off.
./deploy-salesanalyzer.sh down

# Bring it back later
./deploy-salesanalyzer.sh up

# Show current state
./deploy-salesanalyzer.sh status

# Permanently destroy (deletes PVC, GCE disk, namespace).
# Requires typing the project name to confirm.
./deploy-salesanalyzer.sh nuke
```

If you ever uninstall directly with `helm uninstall my-project -n lk-gsd`, the PVC and namespace still survive. To wipe data after a manual uninstall:

```bash
kubectl delete pvc gsd-my-project-home -n lk-gsd
```

## Migrating an Existing Project

If your local project has a `.gsd` symlink (default GSD behavior), copy the real directory into the remote workspace:

```bash
POD=$(kubectl get pods -n lk-gsd -l gsd/project=<name> -o jsonpath='{.items[0].metadata.name}')

# Copy project .gsd (milestones, decisions, database)
GSD_REAL=$(readlink -f /path/to/project/.gsd)
kubectl cp "${GSD_REAL}/" lk-gsd/"${POD}":/home/gsd/workspace/<name>/.gsd/

# Copy skills and agents into the pod's ~/.gsd
kubectl cp ~/.gsd/agent/skills/ lk-gsd/"${POD}":/home/gsd/.gsd/agent/skills/
kubectl cp ~/.gsd/agent/agents/ lk-gsd/"${POD}":/home/gsd/.gsd/agent/agents/
```

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
       + skeleton snapshot (cp -a /home/gsd → /home/gsd.skel)
Layer 7: entrypoint.sh, scripts         ← changes often, rebuilds in seconds
       (lives in /opt/gsd/, not /home/gsd which is PVC-mounted)
```

CI uses GitHub Actions with BuildKit + registry-backed layer caching. Entrypoint-only changes rebuild in ~30s.
