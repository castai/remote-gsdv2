#!/bin/bash
set -uo pipefail

# ─── Remote GSD v2 Entrypoint ───────────────────────────────────────────────
# Configures git credentials from the PVC, clones the project repo (if not
# already present), copies the project .env, then starts a tmux session.
#
# /home/gsd is PVC-backed — everything here survives pod restarts.
# /workspace is PVC-backed — repo clone persists across restarts.
#
# Attach: kubectl exec -it <pod> -- tmux attach -t gsd
# Detach: Ctrl+B, D
# ─────────────────────────────────────────────────────────────────────────────

WORKSPACE="${WORKSPACE:-/home/gsd/workspace/project}"
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
# These write to ~/.gitconfig on the PVC — persists across restarts.
git config --global --get user.email >/dev/null 2>&1 || \
  git config --global user.email "gsd-agent@remote"
git config --global --get user.name >/dev/null 2>&1 || \
  git config --global user.name "GSD Remote Agent"
git config --global init.defaultBranch main
git config --global --add safe.directory '*'

# Point credential store at ~/.git-credentials (PVC-backed, written by init container)
if [ -f "${HOME}/.git-credentials" ]; then
  git config --global credential.helper "store --file=${HOME}/.git-credentials"
  echo "[entrypoint] ✓ Git credentials loaded from PVC"
else
  git config --global credential.helper store
  echo "[entrypoint] WARN: No git credentials found — clone/push may prompt for auth"
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
if [ -f "${HOME}/.staged-project-env" ]; then
  echo "[entrypoint] Copying project .env..."
  cp "${HOME}/.staged-project-env" "${WORKSPACE}/.env"
  echo "[entrypoint] ✓ .env installed"
fi

# ── GitHub CLI auth (if PAT available) ───────────────────────────────────────
if [ -f "${HOME}/.git-credentials" ]; then
  GH_TOKEN=$(grep -oP 'x-access-token:\K[^@]+' "${HOME}/.git-credentials" 2>/dev/null || true)
  if [ -n "${GH_TOKEN}" ]; then
    echo "[entrypoint] Configuring GitHub CLI..."
    echo "${GH_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  fi
fi

# ── Refresh shell config from image skeleton ────────────────────────────────
# .tmux.conf and .zshrc are baked into the image via /home/gsd.skel but
# the PVC seed only happens on first boot. Refresh them every boot so config
# fixes (e.g. tmux paste handling) roll out without a nuke. User-edited
# versions are preserved if they have a `# gsd-keep` marker on line 1.
for cfg in .tmux.conf; do
  src="/home/gsd.skel/${cfg}"
  dst="${HOME}/${cfg}"
  if [ -f "${src}" ]; then
    if [ -f "${dst}" ] && head -n 1 "${dst}" | grep -q '^# gsd-keep'; then
      echo "[entrypoint] Keeping user-customized ${cfg} (gsd-keep marker)"
    elif ! cmp -s "${src}" "${dst}" 2>/dev/null; then
      cp "${src}" "${dst}"
      echo "[entrypoint] ✓ Refreshed ${cfg} from image"
    fi
  fi
done

# Reload running tmux server config so the refresh takes effect for any
# already-attached session without forcing a detach/reattach.
if tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
  tmux source-file "${HOME}/.tmux.conf" 2>/dev/null && \
    echo "[entrypoint] ✓ Reloaded tmux config in running session"
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
