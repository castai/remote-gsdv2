#!/bin/bash
set -uo pipefail

# ─── Remote GSD v2 Entrypoint ───────────────────────────────────────────────
# Clones the project repo (if not already present), configures git credentials,
# copies the project .env, then starts a tmux session with zsh.
#
# Attach: kubectl exec -it <pod> -- tmux attach -t gsd
# Detach: Ctrl+B, D
# ─────────────────────────────────────────────────────────────────────────────

WORKSPACE="${WORKSPACE:-/workspace/project}"
GIT_REPO="${GIT_REPO:-}"
GIT_BRANCH="${GIT_BRANCH:-}"
PROJECT_NAME="${PROJECT_NAME:-gsd}"
TMUX_SESSION="gsd"

echo "═══════════════════════════════════════════════════════════════"
echo "  GSD v2 Remote Agent"
echo "  Project:   ${PROJECT_NAME}"
echo "  Workspace: ${WORKSPACE}"
echo "  Repo:      ${GIT_REPO:-<none>}"
echo ""
echo "  Attach:  kubectl exec -it <pod> -- tmux attach -t gsd"
echo "  Detach:  Ctrl+B, D"
echo "═══════════════════════════════════════════════════════════════"

# ── Git config ───────────────────────────────────────────────────────────────
git config --global --get user.email >/dev/null 2>&1 || \
  git config --global user.email "gsd-agent@remote"
git config --global --get user.name >/dev/null 2>&1 || \
  git config --global user.name "GSD Remote Agent"
git config --global init.defaultBranch main
git config --global credential.helper store
git config --global --add safe.directory '*'

# Pick up credentials from shared volume (written by init container)
if [ -f /home/gsd/.shared/.git-credentials ]; then
  cp /home/gsd/.shared/.git-credentials /home/gsd/.git-credentials 2>/dev/null && \
    chmod 600 /home/gsd/.git-credentials || \
    echo "[entrypoint] WARN: Could not copy git credentials"
fi

# ── Clone repo if workspace is empty ─────────────────────────────────────────
if [ -n "${GIT_REPO}" ] && [ ! -d "${WORKSPACE}/.git" ]; then
  echo "[entrypoint] Cloning ${GIT_REPO}..."
  mkdir -p "$(dirname "${WORKSPACE}")"
  if [ -n "${GIT_BRANCH}" ]; then
    git clone --branch "${GIT_BRANCH}" "${GIT_REPO}" "${WORKSPACE}" 2>&1 || \
      echo "[entrypoint] WARN: Clone failed — you can clone manually from the shell"
  else
    git clone "${GIT_REPO}" "${WORKSPACE}" 2>&1 || \
      echo "[entrypoint] WARN: Clone failed — you can clone manually from the shell"
  fi
  echo "[entrypoint] ✓ Clone complete"
elif [ ! -d "${WORKSPACE}" ]; then
  echo "[entrypoint] Creating workspace at ${WORKSPACE}..."
  mkdir -p "${WORKSPACE}"
  cd "${WORKSPACE}" && git init
fi

cd "${WORKSPACE}"

# ── Copy project .env if staged by init container ────────────────────────────
if [ -f /home/gsd/.shared/.project-env ]; then
  echo "[entrypoint] Copying project .env..."
  cp /home/gsd/.shared/.project-env "${WORKSPACE}/.env"
  echo "[entrypoint] ✓ .env installed"
fi

# ── GitHub CLI auth (if PAT available) ───────────────────────────────────────
if [ -f /home/gsd/.git-credentials ]; then
  # Extract token from credentials file for gh CLI
  GH_TOKEN=$(grep -oP 'x-access-token:\K[^@]+' /home/gsd/.git-credentials 2>/dev/null || true)
  if [ -n "${GH_TOKEN}" ]; then
    echo "[entrypoint] Configuring GitHub CLI..."
    echo "${GH_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  fi
fi

# ── Start tmux session ──────────────────────────────────────────────────────
if tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
  echo "[entrypoint] Existing tmux session found. Keeping it alive."
else
  echo "[entrypoint] Starting tmux session '${TMUX_SESSION}' (shell)..."
  tmux new-session -d -s "${TMUX_SESSION}" -c "${WORKSPACE}"
fi

echo "[entrypoint] ✓ tmux session '${TMUX_SESSION}' is running."
echo "[entrypoint] Container will stay alive. Run 'gsd' inside the session to start the agent."
echo ""

# ── Keep container alive ────────────────────────────────────────────────────
while true; do
  if ! tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
    echo "[entrypoint] tmux session ended — restarting shell..."
    sleep 2
    tmux new-session -d -s "${TMUX_SESSION}" -c "${WORKSPACE}"
  fi
  sleep 10
done
