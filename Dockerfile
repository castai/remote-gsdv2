# ─── Remote GSD v2 Agent Container ───────────────────────────────────────────
# Full development environment for a cloud-hosted AI coding agent.
# Runs gsd-pi inside a tmux session. Attach via kubectl exec.
#
# Build:  docker build -t gsd-remote:latest .
# Connect: ./connect.sh
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS base

# ── Core system packages ─────────────────────────────────────────────────────
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
    # SSH & remote
    openssh-client \
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
    # Needed by some language servers
    libicu-dev \
  && rm -rf /var/lib/apt/lists/* \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

# ── Go 1.24 ──────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://go.dev/dl/go1.24.2.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"
ENV GOPATH="/home/gsd/go"

# ── Rust (for tools that need it) ────────────────────────────────────────────
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# ── kubectl ──────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

# ── GitHub CLI ───────────────────────────────────────────────────────────────
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# ── Google Cloud SDK ─────────────────────────────────────────────────────────
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list && \
    apt-get update && apt-get install -y google-cloud-cli && rm -rf /var/lib/apt/lists/*

# ── AWS CLI v2 ───────────────────────────────────────────────────────────────
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/aws /tmp/awscliv2.zip

# ── Docker CLI ───────────────────────────────────────────────────────────────
RUN curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y docker-ce-cli && rm -rf /var/lib/apt/lists/*

# ── Helm ─────────────────────────────────────────────────────────────────────
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# ── Terraform ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://releases.hashicorp.com/terraform/1.12.0/terraform_1.12.0_linux_amd64.zip \
      -o /tmp/terraform.zip && \
    unzip -q /tmp/terraform.zip -d /usr/local/bin && \
    rm /tmp/terraform.zip

# ── Language servers & dev tools (Go) ────────────────────────────────────────
RUN GOBIN=/usr/local/bin go install golang.org/x/tools/gopls@latest && \
    GOBIN=/usr/local/bin go install github.com/go-delve/delve/cmd/dlv@latest && \
    GOBIN=/usr/local/bin go install golang.org/x/tools/cmd/goimports@latest && \
    GOBIN=/usr/local/bin go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest && \
    GOBIN=/usr/local/bin go install mvdan.cc/gofumpt@latest && \
    rm -rf /root/go/pkg /root/go/src

# ── Install GSD v2 globally ─────────────────────────────────────────────────
RUN npm install -g gsd-pi@2.77.0

# ── Node.js language servers & tools ─────────────────────────────────────────
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

# ── Python global tools ──────────────────────────────────────────────────────
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

# ── Create non-root user with zsh + sudo ─────────────────────────────────────
RUN useradd -m -s /bin/zsh gsd && \
    echo "gsd ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/gsd && \
    mkdir -p /workspace /home/gsd/.gsd/agent /home/gsd/go && \
    chown -R gsd:gsd /workspace /home/gsd && \
    ln -sf /usr/bin/fd-find /usr/local/bin/fd && \
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

# ── Oh My Zsh + plugins ─────────────────────────────────────────────────────
RUN sh -c "$(wget -qO- https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended && \
    git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions \
      ${HOME}/.oh-my-zsh/custom/plugins/zsh-autosuggestions && \
    git clone --depth=1 https://github.com/zsh-users/zsh-syntax-highlighting \
      ${HOME}/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting

# ── Zsh config ───────────────────────────────────────────────────────────────
RUN sed -i 's/^ZSH_THEME=.*/ZSH_THEME="agnoster"/' ~/.zshrc && \
    sed -i 's/^plugins=.*/plugins=(git kubectl aws gcloud docker helm terraform python pip golang rust fzf zsh-autosuggestions zsh-syntax-highlighting)/' ~/.zshrc && \
    echo '' >> ~/.zshrc && \
    echo '# GSD Remote Agent' >> ~/.zshrc && \
    echo 'export GOPATH="$HOME/go"' >> ~/.zshrc && \
    echo 'export PATH="/usr/local/go/bin:$GOPATH/bin:$HOME/.cargo/bin:$HOME/.local/bin:$PATH"' >> ~/.zshrc && \
    echo 'export WORKSPACE="${WORKSPACE:-/workspace/dev_root/oc-salesanalyzer-control}"' >> ~/.zshrc && \
    echo '[ -d "$WORKSPACE" ] && cd "$WORKSPACE"' >> ~/.zshrc && \
    echo '' >> ~/.zshrc && \
    echo '# Aliases' >> ~/.zshrc && \
    echo 'alias k=kubectl' >> ~/.zshrc && \
    echo 'alias g=git' >> ~/.zshrc && \
    echo 'alias tf=terraform' >> ~/.zshrc && \
    echo 'alias py=python3' >> ~/.zshrc && \
    echo 'alias ll="ls -lah"' >> ~/.zshrc

# ── tmux config ──────────────────────────────────────────────────────────────
RUN echo 'set -g extended-keys on' > ~/.tmux.conf && \
    echo 'set -g default-terminal "xterm-256color"' >> ~/.tmux.conf && \
    echo 'set -ga terminal-overrides ",xterm-256color:Tc"' >> ~/.tmux.conf && \
    echo 'set -g default-shell /bin/zsh' >> ~/.tmux.conf && \
    echo 'set -g mouse on' >> ~/.tmux.conf && \
    echo 'set -g history-limit 50000' >> ~/.tmux.conf && \
    echo 'set -g status-style "bg=#1e1e2e,fg=#cdd6f4"' >> ~/.tmux.conf && \
    echo 'set -g status-left "#[fg=#89b4fa,bold] GSD #[fg=#6c7086]│ "' >> ~/.tmux.conf && \
    echo 'set -g status-right "#[fg=#6c7086]%H:%M "' >> ~/.tmux.conf

# ── Git config defaults ──────────────────────────────────────────────────────
RUN git config --global init.defaultBranch main && \
    git config --global pull.rebase true && \
    git config --global push.autoSetupRemote true && \
    git config --global core.editor vim

ENV NODE_ENV=production
WORKDIR /workspace

# ── Entrypoint ───────────────────────────────────────────────────────────────
COPY --chown=gsd:gsd entrypoint.sh /home/gsd/entrypoint.sh
RUN chmod +x /home/gsd/entrypoint.sh

ENTRYPOINT ["/home/gsd/entrypoint.sh"]
