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

# ── Bootstrap: PVC-local OpenGSD GSD Pi and Kimchi harness ──────────────────
# These tools are installed into /home/gsd (PVC-backed) so they survive pod
# restarts and can be updated without rebuilding the image.
#
# Old shadowing cleanup: removes unscoped legacy npm packages (`gsd-pi` or
# `gsd`) that could shadow the new @opengsd/gsd-pi under the PVC npm prefix.

# Ensure PVC-local npm prefix and PATH are set for this script
export NPM_CONFIG_PREFIX="${HOME}/.npm-global"
export npm_config_prefix="${HOME}/.npm-global"
NPM_BIN="${HOME}/.npm-global/bin"
mkdir -p "${NPM_BIN}" "${HOME}/.npm-global/lib/node_modules" "${HOME}/.local/bin"

# Prefer PVC-local binaries over image-wide ones
if [[ ":${PATH}:" != *":${NPM_BIN}:"* ]]; then
  export PATH="${NPM_BIN}:${PATH}"
fi

GSD_PI_INSTALLED=false
KIMCHI_INSTALLED=false

# ── Cleanup: Remove old package shadowing ───────────────────────────────────
# Remove old unscoped packages from the PVC npm prefix. The legacy image-level
# install is gone from the Dockerfile; PVC-local cleanup avoids stale binaries
# when reusing an existing volume.
export NODE_PATH="${HOME}/.npm-global/lib/node_modules"
for old_pkg in gsd-pi gsd; do
  if [ -d "${HOME}/.npm-global/lib/node_modules/${old_pkg}" ]; then
    echo "[entrypoint] Removing deprecated unscoped package '${old_pkg}' from PVC npm prefix..."
    npm uninstall -g "${old_pkg}" 2>/dev/null && echo "[entrypoint] ✓ Removed deprecated ${old_pkg} shadow" \
      || rm -rf "${HOME}/.npm-global/lib/node_modules/${old_pkg}" "${NPM_BIN}/${old_pkg}" "${NPM_BIN}/gsd" 2>/dev/null \
      || echo "[entrypoint] WARN: Could not remove deprecated ${old_pkg} shadow (continuing)"
  fi
done

# ── Bootstrap: Install @opengsd/gsd-pi@latest if missing ────────────────────
# Check for 'gsd' CLI in PVC-local npm bin (installed by @opengsd/gsd-pi)
if command -v gsd &>/dev/null && [ -d "${HOME}/.npm-global/lib/node_modules/@opengsd/gsd-pi" ]; then
  GSD_PI_INSTALLED=true
  GSD_PI_VERSION=$(npm list -g @opengsd/gsd-pi --depth=0 2>/dev/null | grep -oP '@opengsd/gsd-pi@\K[^\s]+' || echo "unknown")
  echo "[entrypoint] ✓ @opengsd/gsd-pi@${GSD_PI_VERSION} found in ${NPM_BIN} (PVC-local, up-to-date)"
elif [ -f "${NPM_BIN}/gsd" ]; then
  # Binary exists but module dir is missing/mangled — reinstall
  echo "[entrypoint] gsd binary found but @opengsd/gsd-pi module missing — reinstalling..."
  npm install -g "@opengsd/gsd-pi@latest" 2>&1 && GSD_PI_INSTALLED=true \
    || echo "[entrypoint] WARN: @opengsd/gsd-pi install failed (pod can still run)"
else
  echo "[entrypoint] @opengsd/gsd-pi not found — installing @opengsd/gsd-pi@latest into ${NPM_BIN}..."
  npm install -g "@opengsd/gsd-pi@latest" 2>&1 && GSD_PI_INSTALLED=true \
    || echo "[entrypoint] WARN: @opengsd/gsd-pi install failed (pod can still run)"
fi

# Verify gsd command is now available
gsd_version_output=""
if command -v gsd &>/dev/null; then
  gsd_version_output=$(gsd --version 2>&1 || echo "")
  echo "[entrypoint] ✓ gsd CLI available: ${gsd_version_output:-(version check unavailable)}"
else
  echo "[entrypoint] WARN: gsd CLI not in PATH after bootstrap — check npm prefix configuration"
fi

# ── Bootstrap: Install Kimchi harness if missing ────────────────────────────
# Kimchi harness is installed to ~/.local/bin/kimchi (via install.sh script)
KIMCHI_BIN="${HOME}/.local/bin/kimchi"
if command -v kimchi &>/dev/null; then
  KIMCHI_INSTALLED=true
  echo "[entrypoint] ✓ Kimchi harness found at $(command -v kimchi)"
elif [ -f "${KIMCHI_BIN}" ]; then
  KIMCHI_INSTALLED=true
  export PATH="${HOME}/.local/bin:${PATH}"
  echo "[entrypoint] ✓ Kimchi harness found at ${KIMCHI_BIN} (added to PATH)"
else
  echo "[entrypoint] Kimchi harness not found — installing via official installer..."
  echo "[entrypoint]   URL: https://github.com/getkimchi/kimchi/releases/latest/download/install.sh"
  if curl -fsSL "https://github.com/getkimchi/kimchi/releases/latest/download/install.sh" | bash 2>&1; then
    KIMCHI_INSTALLED=true
    export PATH="${HOME}/.local/bin:${PATH}"
    echo "[entrypoint] ✓ Kimchi harness installed successfully"
  else
    echo "[entrypoint] WARN: Kimchi harness install failed (pod can still run)"
    echo "[entrypoint]   To retry manually: curl -fsSL https://github.com/getkimchi/kimchi/releases/latest/download/install.sh | bash"
  fi
fi

# ── Bootstrap summary ───────────────────────────────────────────────────────
echo "[entrypoint] Bootstrap complete: gsd-pi=${GSD_PI_INSTALLED}, kimchi=${KIMCHI_INSTALLED}"

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

# ── Refresh VS Code CLI binary from image ───────────────────────────────────
# The CLI is baked in the image and must survive PVC shadowing.  Unlike config
# files, it won't be seeded by the init container (which only copies /home/gsd.skel).
# Refresh on every boot so a new image (correct glibc build) replaces an old
# one (Alpine/musl build) without needing a PVC wipe.
CLI_SRC="/home/gsd.skel/.local/bin/code"
CLI_DST="${HOME}/.local/bin/code"
if [ -f "${CLI_SRC}" ]; then
  if [ -f "${CLI_DST}" ] && cmp -s "${CLI_SRC}" "${CLI_DST}" 2>/dev/null; then
    : # already identical
  else
    cp "${CLI_SRC}" "${CLI_DST}"
    echo "[entrypoint] ✓ Refreshed VS Code CLI from image ($(file -b ${CLI_DST} | cut -d, -f1))"
  fi
fi

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

# ── Start ttyd (web terminal) ────────────────────────────────────────────────
# ttyd serves the tmux session over WebSocket on port 7681.
# The dashboard port-forwards to this port — it must be running before any
# terminal page is opened. Restart on exit so a crash doesn't leave the
# dashboard with a blank terminal.
TTYD_LOG="/tmp/ttyd.log"
TMUX_ATTACH_SCRIPT="/tmp/tmux-attach.sh"

# Write the attach script (dashboard may have already created it, but be safe)
if [ ! -f "${TMUX_ATTACH_SCRIPT}" ]; then
  cat > "${TMUX_ATTACH_SCRIPT}" <<'EOF'
#!/bin/bash
SESSION="${1:-gsd}"
exec tmux attach -t "${SESSION}" 2>/dev/null || exec tmux new-session -A -s "${SESSION}"
EOF
  chmod +x "${TMUX_ATTACH_SCRIPT}"
fi

start_ttyd() {
  local bin
  bin=$(command -v ttyd 2>/dev/null || echo "${HOME}/.local/bin/ttyd")
  echo "[entrypoint] Starting ttyd on port 7681 (${bin})..."
  nohup "${bin}" -p 7681 -W -a \
    -t "fontSize=16" \
    -t "fontFamily=Menlo, monospace" \
    -t "allowProposedApi=true" \
    "${TMUX_ATTACH_SCRIPT}" \
    > "${TTYD_LOG}" 2>&1 &
  echo "[entrypoint] ✓ ttyd started (pid $!)"
}

if pgrep -x ttyd > /dev/null 2>&1; then
  echo "[entrypoint] ttyd already running — keeping it."
else
  start_ttyd
fi

echo "[entrypoint] Container will stay alive. Run 'gsd' inside the session to start the agent."
echo ""

# ── Keep container alive ────────────────────────────────────────────────────
while true; do
  if ! tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
    echo "[entrypoint] tmux session ended — restarting shell..."
    sleep 2
    tmux new-session -d -s "${TMUX_SESSION}" -c "${WORKSPACE}"
  fi
  if ! pgrep -x ttyd > /dev/null 2>&1; then
    echo "[entrypoint] ttyd exited — restarting..."
    start_ttyd
  fi
  sleep 10
done
