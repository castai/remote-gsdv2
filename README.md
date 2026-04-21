# Remote GSD v2

Cloud-hosted persistent coding agent on Kubernetes. Run GSD v2 in a pod — attach from any terminal or VS Code, disconnect without killing the session.

## Architecture

```
┌─────────────────────┐     kubectl port-forward     ┌──────────────────────────────┐
│  Your Laptop        │ ◄──────────────────────────► │  GKE Pod (gsd-remote)        │
│  Browser / VS Code  │        :3000 → :3000         │  ┌──────────────────────┐    │
│                     │                               │  │ tmux session         │    │
└─────────────────────┘                               │  │  └─ gsd --web       │    │
                                                      │  │     (Next.js UI +   │    │
       Disconnect? No problem.                        │  │      RPC server)    │    │
       Agent keeps running.                           │  └──────────────────────┘    │
                                                      │  PVC: /workspace (20Gi)     │
                                                      │  PVC: ~/.gsd (5Gi)          │
                                                      └──────────────────────────────┘
```

## Quick Start

### 1. Push to build the image
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

### 4. Connect
```bash
kubectl port-forward -n gsd-remote svc/gsd-agent 3000:3000
# Open http://localhost:3000
```

Close the terminal. Reopen. Re-run port-forward. Your session is still there.

## Image

- **Registry:** `us-central1-docker.pkg.dev/demos-321800/agents/gsd-remote`
- **Base:** `node:22-slim` + git + tmux
- **Entrypoint:** tmux → `gsd --web --host 0.0.0.0`
