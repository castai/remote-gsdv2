# Remote GSD v2

Cloud-hosted persistent coding agent on Kubernetes. Run GSD v2 in a pod — attach from any terminal or VS Code, disconnect without killing the session.

## Architecture

```
┌─────────────────────┐                              ┌──────────────────────────────┐
│  Your Machine       │      kubectl exec -it         │  GKE Pod (gsd-remote)        │
│                     │ ◄──────────────────────────► │  ┌──────────────────────┐    │
│  Terminal           │     attach tmux session       │  │ tmux session         │    │
│  VS Code            │                               │  │  └─ zsh (oh-my-zsh) │    │
│                     │                               │  │     └─ gsd          │    │
└─────────────────────┘                               │  └──────────────────────┘    │
                                                      │                              │
       Disconnect? No problem.                        │  PVC: /workspace (20Gi)     │
       Agent keeps running.                           │  PVC: ~/.gsd (5Gi)          │
                                                      └──────────────────────────────┘
```

## Quick Start

### 1. Build the image
```bash
git push origin main   # GitHub Actions builds & pushes to Artifact Registry
```

### 2. Create the auth secret
```bash
kubectl create namespace gsd-remote

kubectl create secret generic gsd-auth \
  --namespace=gsd-remote \
  --from-file=auth.json=$HOME/.gsd/agent/auth.json
```

### 3. Deploy
```bash
kubectl apply -f k8s/
```

### 4. Connect (Terminal)
```bash
./connect.sh
# or directly:
kubectl exec -it -n gsd-remote gsd-agent-0 -- tmux attach -t gsd
```

Detach: `Ctrl+B, D` — agent keeps running.

### 5. Connect (VS Code)

#### Option A: Kubernetes extension (recommended)
1. Install the [Kubernetes extension](https://marketplace.visualstudio.com/items?itemName=ms-kubernetes-tools.vscode-kubernetes-tools)
2. In the Kubernetes sidebar, find `gsd-remote` → `gsd-agent-0`
3. Right-click → **Attach Visual Studio Code**
4. VS Code opens with full editor access to `/workspace`

#### Option B: VS Code tunnel from inside the pod
```bash
# From inside the pod (after ./connect.sh):
code tunnel --accept-server-license-terms
# Follow the GitHub auth link, then connect from VS Code:
# Cmd+Shift+P → "Remote-Tunnels: Connect to Tunnel"
```

#### Option C: Remote-SSH via port-forward
```bash
# Terminal 1: forward SSH
kubectl port-forward -n gsd-remote svc/gsd-agent 2222:22

# VS Code: Cmd+Shift+P → "Remote-SSH: Connect to Host"
# Enter: ssh -p 2222 gsd@localhost
```

## What's Inside

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
| **Shell** | Oh My Zsh (agnoster) + autosuggestions + syntax-highlighting |
| **VS Code** | CLI pre-installed, tunnel-ready |

## Image

- **Registry:** `us-central1-docker.pkg.dev/demos-321800/agents/gsd-remote`
- **Base:** `node:22-slim` + full dev toolchain
- **Layers:** 7 layers ordered by change frequency (entrypoint changes rebuild in seconds)
