#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw curl-pipe-bash installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/install.sh | bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[install]${NC} $1"; }
warn() { echo -e "${YELLOW}[install]${NC} $1"; }
fail() {
  echo -e "${RED}[install]${NC} $1"
  exit 1
}

define_runtime_helpers() {
  socket_exists() {
    local socket_path="$1"

    if [ -n "${NEMOCLAW_TEST_SOCKET_PATHS:-}" ]; then
      case ":$NEMOCLAW_TEST_SOCKET_PATHS:" in
        *":$socket_path:"*) return 0 ;;
      esac
    fi

    [ -S "$socket_path" ]
  }

  find_colima_docker_socket() {
    local home_dir="${1:-${HOME:-/tmp}}"
    local socket_path

    for socket_path in \
      "$home_dir/.colima/default/docker.sock" \
      "$home_dir/.config/colima/default/docker.sock"; do
      if socket_exists "$socket_path"; then
        printf '%s\n' "$socket_path"
        return 0
      fi
    done

    return 1
  }

  find_docker_desktop_socket() {
    local home_dir="${1:-${HOME:-/tmp}}"
    local socket_path="$home_dir/.docker/run/docker.sock"

    if socket_exists "$socket_path"; then
      printf '%s\n' "$socket_path"
      return 0
    fi

    return 1
  }

  detect_docker_host() {
    if [ -n "${DOCKER_HOST:-}" ]; then
      printf '%s\n' "$DOCKER_HOST"
      return 0
    fi

    local home_dir="${1:-${HOME:-/tmp}}"
    local socket_path

    if socket_path="$(find_colima_docker_socket "$home_dir")"; then
      printf 'unix://%s\n' "$socket_path"
      return 0
    fi

    if socket_path="$(find_docker_desktop_socket "$home_dir")"; then
      printf 'unix://%s\n' "$socket_path"
      return 0
    fi

    return 1
  }
}

SCRIPT_PATH="${BASH_SOURCE[0]-}"
SCRIPT_DIR=""
if [ -n "$SCRIPT_PATH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/lib/runtime.sh" ]; then
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/lib/runtime.sh"
else
  define_runtime_helpers
fi

# Ensure nvm environment is loaded in the current shell.
# Skip if node is already on PATH — sourcing nvm.sh can reset PATH and
# override the caller's node/npm (e.g. in test environments with stubs).
ensure_nvm_loaded() {
  command -v node &>/dev/null && return 0
  if [ -z "${NVM_DIR:-}" ]; then
    export NVM_DIR="$HOME/.nvm"
  fi
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
}

# Refresh PATH so that npm global bin is discoverable.
refresh_path() {
  ensure_nvm_loaded

  local npm_bin
  npm_bin="$(npm config get prefix 2>/dev/null)/bin" || true
  if [ -n "$npm_bin" ] && [ -d "$npm_bin" ]; then
    case ":$PATH:" in
      *":$npm_bin:"*) ;; # already on PATH
      *) export PATH="$npm_bin:$PATH" ;;
    esac
  fi
}

MIN_NODE_MAJOR=20
MIN_NPM_MAJOR=10
RECOMMENDED_NODE_MAJOR=22
RUNTIME_REQUIREMENT_MSG="NemoClaw requires Node.js >=${MIN_NODE_MAJOR} and npm >=${MIN_NPM_MAJOR} (recommended Node.js ${RECOMMENDED_NODE_MAJOR})."

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_LABEL="macOS" ;;
  Linux) OS_LABEL="Linux" ;;
  *) fail "Unsupported OS: $OS" ;;
esac

case "$ARCH" in
  x86_64 | amd64) ARCH_LABEL="x86_64" ;;
  aarch64 | arm64) ARCH_LABEL="aarch64" ;;
  *) fail "Unsupported architecture: $ARCH" ;;
esac

info "Detected $OS_LABEL ($ARCH_LABEL)"

# ── Detect Node.js version manager ──────────────────────────────

NODE_MGR="none"
NEED_RESHIM=false

if command -v asdf >/dev/null 2>&1 && asdf plugin list 2>/dev/null | grep -q nodejs; then
  NODE_MGR="asdf"
elif [ -n "${NVM_DIR:-}" ] && [ -s "${NVM_DIR}/nvm.sh" ]; then
  NODE_MGR="nvm"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  NODE_MGR="nvm"
elif command -v fnm >/dev/null 2>&1; then
  NODE_MGR="fnm"
elif command -v brew >/dev/null 2>&1 && [ "$OS" = "Darwin" ]; then
  NODE_MGR="brew"
elif [ "$OS" = "Linux" ]; then
  NODE_MGR="nodesource"
fi

info "Node.js manager: $NODE_MGR"

version_major() {
  printf '%s\n' "${1#v}" | cut -d. -f1
}

ensure_supported_runtime() {
  command -v node >/dev/null 2>&1 || fail "${RUNTIME_REQUIREMENT_MSG} Node.js was not found on PATH."
  command -v npm >/dev/null 2>&1 || fail "${RUNTIME_REQUIREMENT_MSG} npm was not found on PATH."

  local node_version npm_version node_major npm_major
  node_version="$(node -v 2>/dev/null || true)"
  npm_version="$(npm --version 2>/dev/null || true)"
  node_major="$(version_major "$node_version")"
  npm_major="$(version_major "$npm_version")"

  [[ "$node_major" =~ ^[0-9]+$ ]] || fail "Could not determine Node.js version from '${node_version}'. ${RUNTIME_REQUIREMENT_MSG}"
  [[ "$npm_major" =~ ^[0-9]+$ ]] || fail "Could not determine npm version from '${npm_version}'. ${RUNTIME_REQUIREMENT_MSG}"

  if ((node_major < MIN_NODE_MAJOR || npm_major < MIN_NPM_MAJOR)); then
    fail "Unsupported runtime detected: Node.js ${node_version:-unknown}, npm ${npm_version:-unknown}. ${RUNTIME_REQUIREMENT_MSG} Upgrade Node.js and rerun the installer."
  fi

  info "Runtime OK: Node.js ${node_version}, npm ${npm_version}"
}

# ── Install Node.js 22 if needed ────────────────────────────────

install_node() {
  local current_major=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  fi

  if [ "$current_major" = "22" ]; then
    info "Node.js 22 already installed: $(node -v)"
    return 0
  fi

  info "Installing Node.js 22..."

  case "$NODE_MGR" in
    asdf)
      local latest_22
      latest_22="$(asdf list all nodejs 2>/dev/null | grep '^22\.' | tail -1)"
      [ -n "$latest_22" ] || fail "Could not find Node.js 22 in asdf"
      asdf install nodejs "$latest_22"
      asdf global nodejs "$latest_22"
      NEED_RESHIM=true
      ;;
    nvm)
      # shellcheck source=/dev/null
      . "${NVM_DIR}/nvm.sh"
      nvm install 22
      nvm use 22
      nvm alias default 22
      ;;
    fnm)
      fnm install 22
      fnm use 22
      fnm default 22
      ;;
    brew)
      brew install node@22
      brew link --overwrite node@22 2>/dev/null || true
      ;;
    nodesource)
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
      sudo apt-get install -y -qq nodejs >/dev/null 2>&1
      ;;
    none)
      fail "No Node.js version manager found. Install Node.js 22 manually, then re-run."
      ;;
  esac

  info "Node.js $(node -v) installed"
}

install_node
ensure_supported_runtime

# ── Install Docker ───────────────────────────────────────────────

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    info "Docker already running"
    return 0
  fi

  if command -v docker >/dev/null 2>&1; then
    # Docker installed but not running
    if [ "$OS" = "Darwin" ]; then
      local colima_socket=""
      local docker_desktop_socket=""
      colima_socket="$(find_colima_docker_socket || true)"
      docker_desktop_socket="$(find_docker_desktop_socket || true)"

      if [ -n "${DOCKER_HOST:-}" ]; then
        fail "Docker is installed but the selected runtime is not running. Start the runtime behind DOCKER_HOST (${DOCKER_HOST}) and re-run."
      fi

      if [ -n "$colima_socket" ] && [ -n "$docker_desktop_socket" ]; then
        fail "Both Colima and Docker Desktop are available on this Mac. Start the runtime you want explicitly and re-run, or set DOCKER_HOST to select one."
      fi

      if [ -n "$docker_desktop_socket" ]; then
        fail "Docker Desktop appears to be installed but is not running. Start Docker Desktop and re-run."
      fi

      if command -v colima >/dev/null 2>&1; then
        info "Starting Colima..."
        colima start
        return 0
      fi
    fi
    fail "Docker is installed but not running. Please start Docker and re-run."
  fi

  info "Installing Docker..."

  case "$OS" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        fail "Homebrew required to install Docker on macOS. Install from https://brew.sh"
      fi
      info "Installing Colima + Docker CLI via Homebrew..."
      brew install colima docker
      info "Starting Colima..."
      colima start
      ;;
    Linux)
      sudo apt-get update -qq >/dev/null 2>&1
      sudo apt-get install -y -qq docker.io >/dev/null 2>&1
      sudo usermod -aG docker "$(whoami)"
      info "Docker installed. You may need to log out and back in for group changes."
      ;;
  esac

  if ! docker info >/dev/null 2>&1; then
    fail "Docker installed but not running. Start Docker and re-run."
  fi

  info "Docker is running"
}

install_docker

# ── Install OpenShell CLI binary ─────────────────────────────────

install_openshell() {
  if command -v openshell >/dev/null 2>&1; then
    info "openshell already installed: $(openshell --version 2>&1 || echo 'unknown')"
    return 0
  fi

  info "Installing openshell CLI..."

  case "$OS" in
    Darwin)
      case "$ARCH_LABEL" in
        x86_64) ASSET="openshell-x86_64-apple-darwin.tar.gz" ;;
        aarch64) ASSET="openshell-aarch64-apple-darwin.tar.gz" ;;
      esac
      ;;
    Linux)
      case "$ARCH_LABEL" in
        x86_64) ASSET="openshell-x86_64-unknown-linux-musl.tar.gz" ;;
        aarch64) ASSET="openshell-aarch64-unknown-linux-musl.tar.gz" ;;
      esac
      ;;
  esac

  tmpdir="$(mktemp -d)"
  if command -v gh >/dev/null 2>&1; then
    GH_TOKEN="${GITHUB_TOKEN:-}" gh release download --repo NVIDIA/OpenShell \
      --pattern "$ASSET" --dir "$tmpdir"
  else
    # Fallback: curl latest release
    curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/latest/download/$ASSET" \
      -o "$tmpdir/$ASSET"
  fi

  tar xzf "$tmpdir/$ASSET" -C "$tmpdir"

  if [ -w /usr/local/bin ]; then
    install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  else
    sudo install -m 755 "$tmpdir/openshell" /usr/local/bin/openshell
  fi

  rm -rf "$tmpdir"
  info "openshell $(openshell --version 2>&1 || echo '') installed"
}

install_openshell

# ── Pre-extract openclaw workaround (GH-503) ────────────────────
# The openclaw npm tarball is missing directory entries for extensions/,
# skills/, and dist/plugin-sdk/config/. npm's tar extractor hard-fails on
# these but system tar handles them fine. We pre-extract openclaw into
# node_modules BEFORE npm install so npm sees the dep is already satisfied.
pre_extract_openclaw() {
  local install_dir="$1"
  local openclaw_version
  openclaw_version=$(node -e "console.log(require('${install_dir}/package.json').dependencies.openclaw)" 2>/dev/null) || openclaw_version=""

  if [ -z "$openclaw_version" ]; then
    warn "Could not determine openclaw version — skipping pre-extraction"
    return 1
  fi

  info "Pre-extracting openclaw@${openclaw_version} with system tar (GH-503 workaround)…"
  local tmpdir
  tmpdir="$(mktemp -d)"
  if npm pack "openclaw@${openclaw_version}" --pack-destination "$tmpdir" >/dev/null 2>&1; then
    local tgz
    tgz="$(find "$tmpdir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit)"
    if [ -n "$tgz" ] && [ -f "$tgz" ]; then
      if mkdir -p "${install_dir}/node_modules/openclaw" \
        && tar xzf "$tgz" -C "${install_dir}/node_modules/openclaw" --strip-components=1; then
        info "openclaw pre-extracted successfully"
      else
        warn "Failed to extract openclaw tarball"
        rm -rf "$tmpdir"
        return 1
      fi
    else
      warn "npm pack succeeded but tarball not found"
      rm -rf "$tmpdir"
      return 1
    fi
  else
    warn "Failed to download openclaw tarball"
    rm -rf "$tmpdir"
    return 1
  fi
  rm -rf "$tmpdir"
}

# ── Resolve release tag ──────────────────────────────────────────
# Priority: NEMOCLAW_INSTALL_TAG env var > GitHub releases API > "main" fallback.
resolve_release_tag() {
  if [ -n "${NEMOCLAW_INSTALL_TAG:-}" ]; then
    printf "%s" "$NEMOCLAW_INSTALL_TAG"
    return 0
  fi

  local response tag
  response="$(curl -fsSL --max-time 10 \
    https://api.github.com/repos/NVIDIA/NemoClaw/releases/latest 2>/dev/null)" || true
  tag="$(printf '%s' "$response" \
    | grep '"tag_name"' \
    | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/' \
    | head -1 || true)"

  if [ -n "$tag" ] && printf '%s' "$tag" | grep -qE '^v[0-9]'; then
    printf "%s" "$tag"
  else
    printf "main"
  fi
}

# ── Install NemoClaw CLI ─────────────────────────────────────────

info "Installing nemoclaw CLI..."
# Resolve the latest release tag so we never install raw main.
NEMOCLAW_RELEASE_REF="$(resolve_release_tag)"
info "Resolved install ref: ${NEMOCLAW_RELEASE_REF}"
# Clone first so we can pre-extract openclaw before npm install (GH-503).
# npm install -g git+https://... does this internally but we can't hook
# into its extraction pipeline, so we do it ourselves.
NEMOCLAW_SRC="${HOME}/.nemoclaw/source"
rm -rf "$NEMOCLAW_SRC"
mkdir -p "$(dirname "$NEMOCLAW_SRC")"
git clone --depth 1 --branch "$NEMOCLAW_RELEASE_REF" https://github.com/NVIDIA/NemoClaw.git "$NEMOCLAW_SRC"
pre_extract_openclaw "$NEMOCLAW_SRC" || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
# Use sudo for npm link only when the global prefix directory is not writable
# by the current user (e.g., system-managed nodesource installs to /usr).
SUDO=""
NPM_GLOBAL_PREFIX="$(npm config get prefix 2>/dev/null)" || true
if [ -n "$NPM_GLOBAL_PREFIX" ] && [ ! -w "$NPM_GLOBAL_PREFIX" ] && [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi
(cd "$NEMOCLAW_SRC" && npm install --ignore-scripts && cd nemoclaw && npm install --ignore-scripts && npm run build && cd .. && $SUDO npm link)

if [ "$NEED_RESHIM" = true ]; then
  info "Reshimming asdf..."
  asdf reshim nodejs
fi

refresh_path

# ── Verify ───────────────────────────────────────────────────────

if ! command -v nemoclaw >/dev/null 2>&1; then
  # Try refreshing PATH one more time
  refresh_path
fi

if ! command -v nemoclaw >/dev/null 2>&1; then
  npm_bin="$(npm config get prefix 2>/dev/null)/bin" || true
  if [ -n "$npm_bin" ] && [ -x "$npm_bin/nemoclaw" ]; then
    warn "nemoclaw installed at $npm_bin/nemoclaw but not on current PATH."
    warn ""
    warn "Add it to your shell profile:"
    warn "  echo 'export PATH=\"$npm_bin:\$PATH\"' >> ~/.bashrc"
    warn "  source ~/.bashrc"
    warn ""
    warn "Or for zsh:"
    warn "  echo 'export PATH=\"$npm_bin:\$PATH\"' >> ~/.zshrc"
    warn "  source ~/.zshrc"
  else
    fail "nemoclaw installation failed. Binary not found."
  fi
fi

echo ""
info "Installation complete!"
info "nemoclaw $(nemoclaw --version 2>/dev/null || echo 'v0.1.0') is ready."
echo ""
echo "  Run \`nemoclaw onboard\` to get started"
echo ""

# ── Post-install: shell reload instructions ──────────────────

if [ "$NODE_MGR" = "nvm" ] || [ "$NODE_MGR" = "fnm" ]; then
  profile="$HOME/.bashrc"
  if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then
    profile="$HOME/.zshrc"
  elif [ ! -f "$HOME/.bashrc" ] && [ -f "$HOME/.profile" ]; then
    profile="$HOME/.profile"
  fi
  echo "  ──────────────────────────────────────────────────"
  warn "Your current shell may not have the updated PATH."
  echo ""
  echo "  To use nemoclaw now, run:"
  echo ""
  echo "    source $profile"
  echo ""
  echo "  Or open a new terminal window."
  echo "  ──────────────────────────────────────────────────"
  echo ""
fi
