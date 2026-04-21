# ─── Remote GSD v2 Agent Container ───────────────────────────────────────────
# Runs gsd-pi in web mode (Next.js UI + RPC) inside a persistent pod.
# The agent session survives client disconnects.
#
# Build:  docker build -t gsd-remote:latest .
# Run:    docker run -p 3000:3000 -v gsd-workspace:/workspace gsd-remote:latest
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS base

# ── System dependencies ──────────────────────────────────────────────────────
# build-essential + python3: native Node modules (better-sqlite3, sharp, @gsd/native)
# git: gsd requires git for worktree, diff, commit operations
# tmux: session persistence — agent keeps running if client disconnects
# curl: health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    tmux \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

# ── Install GSD v2 globally ─────────────────────────────────────────────────
RUN npm install -g gsd-pi@2.77.0

# ── Create non-root user ────────────────────────────────────────────────────
RUN useradd -m -s /bin/bash gsd && \
    mkdir -p /workspace /home/gsd/.gsd/agent && \
    chown -R gsd:gsd /workspace /home/gsd

# ── Prepare directory structure ──────────────────────────────────────────────
WORKDIR /workspace

# ── Entrypoint ───────────────────────────────────────────────────────────────
COPY --chown=gsd:gsd entrypoint.sh /home/gsd/entrypoint.sh
RUN chmod +x /home/gsd/entrypoint.sh

USER gsd
ENV HOME=/home/gsd
ENV NODE_ENV=production

# Web UI port
EXPOSE 3000

ENTRYPOINT ["/home/gsd/entrypoint.sh"]
