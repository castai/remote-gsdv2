# ─── Remote GSD v2 Agent Container ───────────────────────────────────────────
# Full development environment for a cloud-hosted AI coding agent.
# Runs gsd-pi inside a tmux session. Attach via kubectl exec.
#
# Build:  docker build -t gsd-remote:latest .
# Connect: ./connect.sh  (tmux)  or  VS Code Remote-SSH / Dev Containers
#
# Layer strategy (ordered by change frequency — rarest first):
#   1. system    — apt packages, locale
#   2. cloud     — kubectl, gh, gcloud, aws, docker, helm, terraform
#   3. languages — Go, Rust
#   4. lsp       — language servers, Go tools, Node tools
#   5. gsd       — gsd-pi + Python tools
#   6. user      — non-root user, oh-my-zsh, dotfiles, vscode server
#   7. app       — entrypoint.sh + connect.sh (changes most, rebuilds in seconds)
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS base

# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 1: System packages (changes rarely)
# ═══════════════════════════════════════════════════════════════════════════════
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Shell & terminal
    zsh \
    tmux \
    locales \
    # Version control
    git \
    git-lfs \
    # Build tools
    build-essential \
    cmake \
    pkg-config \
    autoconf \
    automake \
    libtool \
    # Python ecosystem
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # Networking & debugging
    curl \
    wget \
    httpie \
    jq \
    yq \
    dnsutils \
    net-tools \
    iputils-ping \
    netcat-openbsd \
    socat \
    # TLS & certs
    ca-certificates \
    openssl \
    # SSH & remote access
    openssh-client \
    openssh-server \
    rsync \
    # Editors
    vim \
    nano \
    # File tools
    tree \
    ripgrep \
    fd-find \
    fzf \
    less \
    unzip \
    zip \
    tar \
    gzip \
    bzip2 \
    xz-utils \
    # Process management
    procps \
    htop \
    strace \
    # Database clients
    postgresql-client \
    default-mysql-client \
    redis-tools \
    # Misc dev
    gnupg \
    lsb-release \
    software-properties-common \
    apt-transport-https \
    sudo \
    man-db \
    shellcheck \
    libicu-dev \
  && rm -rf /var/lib/apt/lists/* \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen \
  && ln -sf /usr/bin/fd-find /usr/local/bin/fd \
  # SSH server config for VS Code Remote-SSH
  && mkdir -p /run/sshd \
  && sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
  && sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
  && sed -i 's/#PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
  && echo "AllowUsers gsd" >> /etc/ssh/sshd_config

# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 2: Cloud CLIs (changes when upgrading CLI versions)
# ═══════════════════════════════════════════════════════════════════════════════

# kubectl
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Google Cloud SDK
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list && \
    apt-get update && apt-get install -y google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin && rm -rf /var/lib/apt/lists/*

# AWS CLI v2
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip

# Docker CLI
RUN curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli && rm -rf /var/lib/apt/lists/*

# Helm
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Terraform
RUN curl -fsSL https://releases.hashicorp.com/terraform/1.12.0/terraform_1.12.0_linux_amd64.zip \
      -o /tmp/terraform.zip && unzip -q /tmp/terraform.zip -d /usr/local/bin && rm /tmp/terraform.zip

# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 3: Language runtimes (changes when upgrading Go/Rust versions)
# ═══════════════════════════════════════════════════════════════════════════════

# Go 1.24
RUN curl -fsSL "https://go.dev/dl/go1.24.2.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

# Rust (minimal — for tools that need compilation)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 4: Language servers & dev tools (changes when adding/upgrading LSPs)
# ═══════════════════════════════════════════════════════════════════════════════

# Go tools
RUN GOBIN=/usr/local/bin go install golang.org/x/tools/gopls@latest && \
    GOBIN=/usr/local/bin go install github.com/go-delve/delve/cmd/dlv@latest && \
    GOBIN=/usr/local/bin go install golang.org/x/tools/cmd/goimports@latest && \
    GOBIN=/usr/local/bin go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest && \
    GOBIN=/usr/local/bin go install mvdan.cc/gofumpt@latest && \
    rm -rf /root/go/pkg /root/go/src

# Node.js language servers & formatters
RUN npm install -g \
    typescript \
    typescript-language-server \
    @biomejs/biome \
    prettier \
    eslint \
    vscode-langservers-extracted \
    yaml-language-server \
    bash-language-server \
    dockerfile-language-server-nodejs \
    @tailwindcss/language-server \
    pyright

# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 5: GSD + Python tools (changes when upgrading gsd-pi or Python deps)
# ═══════════════════════════════════════════════════════════════════════════════

RUN npm install -g gsd-pi@2.77.0

RUN pip3 install --break-system-packages --no-cache-dir \
    pipx \
    poetry \
    uv \
    black \
    ruff \
    ruff-lsp \
    mypy \
    pytest \
    pytest-cov \
    pre-commit \
    ipython \
    httpx \
    rich

# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 6: User setup, dotfiles, VS Code server (changes when tweaking config)
# ═══════════════════════════════════════════════════════════════════════════════

# Rename the existing 'node' user (UID 1000) to 'gsd' to match init container expectations
# The node:22-slim base image has UID 1000 assigned to 'node'; we need it to be 'gsd'
RUN usermod -l gsd node && \
    groupmod -n gsd node && \
    usermod -d /home/gsd -m gsd && \
    mkdir -p /workspace /home/gsd/.gsd/agent /home/gsd/go \
             /home/gsd/.ssh /home/gsd/.vscode-server && \
    chown -R gsd:gsd /workspace /home/gsd && \
    chmod 700 /home/gsd/.ssh && \
    echo "gsd ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/gsd && \
    # Move rust to gsd user
    cp -r /root/.cargo /home/gsd/.cargo && \
    cp -r /root/.rustup /home/gsd/.rustup && \
    chown -R gsd:gsd /home/gsd/.cargo /home/gsd/.rustup

USER gsd
ENV HOME=/home/gsd
ENV TERM=xterm-256color
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV GOPATH=/home/gsd/go
ENV PATH="/usr/local/go/bin:/home/gsd/go/bin:/home/gsd/.cargo/bin:/home/gsd/.local/bin:/usr/local/bin:${PATH}"

# Pre-install VS Code CLI (code-server bootstraps extensions on first connect)
RUN mkdir -p /home/gsd/.local/bin && \
    curl -fsSL "https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64" \
      -o /tmp/vscode-cli.tar.gz && \
    tar -xzf /tmp/vscode-cli.tar.gz -C /home/gsd/.local/bin && \
    rm /tmp/vscode-cli.tar.gz

# Oh My Zsh + plugins
RUN sh -c "$(wget -qO- https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended && \
    git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions \
      ${HOME}/.oh-my-zsh/custom/plugins/zsh-autosuggestions && \
    git clone --depth=1 https://github.com/zsh-users/zsh-syntax-highlighting \
      ${HOME}/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting

# .zshrc — use robbyrussell (no powerline fonts needed over kubectl exec)
RUN sed -i 's/^ZSH_THEME=.*/ZSH_THEME="robbyrussell"/' ~/.zshrc && \
    sed -i 's/^plugins=.*/plugins=(kubectl aws gcloud docker helm terraform python pip golang rust zsh-autosuggestions zsh-syntax-highlighting)/' ~/.zshrc && \
    echo '' >> ~/.zshrc && \
    echo '# GSD Remote Agent' >> ~/.zshrc && \
    echo 'export GOPATH="$HOME/go"' >> ~/.zshrc && \
    echo 'export PATH="/usr/local/go/bin:$GOPATH/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"' >> ~/.zshrc && \
    echo 'export WORKSPACE="${WORKSPACE:-/workspace/dev_root/oc-salesanalyzer-control}"' >> ~/.zshrc && \
    echo '[ -d "$WORKSPACE" ] && cd "$WORKSPACE"' >> ~/.zshrc && \
    echo '' >> ~/.zshrc && \
    echo 'alias k=kubectl' >> ~/.zshrc && \
    echo 'alias g=git' >> ~/.zshrc && \
    echo 'alias tf=terraform' >> ~/.zshrc && \
    echo 'alias py=python3' >> ~/.zshrc && \
    echo 'alias ll="ls -lah"' >> ~/.zshrc

# .tmux.conf — compatible with tmux 3.3a (Debian bookworm)
RUN printf '%s\n' \
    'set -g default-terminal "xterm-256color"' \
    'set -ga terminal-overrides ",xterm-256color:Tc"' \
    'set -g default-shell /bin/zsh' \
    'set -g mouse on' \
    'set -g history-limit 50000' \
    '' \
    '# Clipboard: OSC 52 propagates copies to local clipboard' \
    '# Works over kubectl exec with iTerm2, Kitty, Alacritty, WezTerm' \
    'set -g set-clipboard on' \
    '' \
    '# Copy mode: vi keys' \
    'setw -g mode-keys vi' \
    'bind -T copy-mode-vi v send-keys -X begin-selection' \
    'bind -T copy-mode-vi y send-keys -X copy-pipe-and-cancel' \
    '' \
    '# Status bar' \
    'set -g status-style "bg=#1e1e2e,fg=#cdd6f4"' \
    'set -g status-left "#[fg=#89b4fa,bold] GSD #[fg=#6c7086]| "' \
    'set -g status-right "#[fg=#6c7086]%H:%M "' \
    > ~/.tmux.conf

# Git defaults
RUN git config --global init.defaultBranch main && \
    git config --global pull.rebase true && \
    git config --global push.autoSetupRemote true && \
    git config --global core.editor vim

# VS Code recommended extensions list (auto-installed on first connect)
RUN mkdir -p /home/gsd/.vscode-server/data/Machine && \
    echo '{\n\
  "remote.extensionKind": {\n\
    "ms-python.python": ["workspace"],\n\
    "golang.go": ["workspace"],\n\
    "rust-lang.rust-analyzer": ["workspace"],\n\
    "dbaeumer.vscode-eslint": ["workspace"],\n\
    "esbenp.prettier-vscode": ["workspace"]\n\
  }\n\
}' > /home/gsd/.vscode-server/data/Machine/settings.json

# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 7: Entrypoint + scripts (changes most often — rebuilds in seconds)
# ═══════════════════════════════════════════════════════════════════════════════

ENV NODE_ENV=production
WORKDIR /workspace

COPY --chown=gsd:gsd entrypoint.sh /home/gsd/entrypoint.sh
COPY --chown=gsd:gsd connect.sh /home/gsd/connect.sh
COPY --chown=gsd:gsd vscode-tunnel.sh /usr/local/bin/vscode-tunnel
RUN chmod +x /home/gsd/entrypoint.sh /home/gsd/connect.sh /usr/local/bin/vscode-tunnel

ENTRYPOINT ["/home/gsd/entrypoint.sh"]
