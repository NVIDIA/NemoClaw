#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw installer — installs Node.js, Ollama (if GPU present), and NemoClaw.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

command_exists() { command -v "$1" &>/dev/null; }

MIN_NODE_MAJOR=20
MIN_NPM_MAJOR=10
RECOMMENDED_NODE_MAJOR=22
RUNTIME_REQUIREMENT_MSG="NemoClaw requires Node.js >=${MIN_NODE_MAJOR} and npm >=${MIN_NPM_MAJOR} (recommended Node.js ${RECOMMENDED_NODE_MAJOR})."

# Compare two semver strings (major.minor.patch). Returns 0 if $1 >= $2.
version_gte() {
  local IFS=.
  local -a a=($1) b=($2)
  for i in 0 1 2; do
    local ai=${a[$i]:-0} bi=${b[$i]:-0}
    if (( ai > bi )); then return 0; fi
    if (( ai < bi )); then return 1; fi
  done
  return 0
}

# Ensure nvm environment is loaded in the current shell.
ensure_nvm_loaded() {
  if [[ -z "${NVM_DIR:-}" ]]; then
    export NVM_DIR="$HOME/.nvm"
  fi
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    \. "$NVM_DIR/nvm.sh"
  fi
}

# Refresh PATH so that npm global bin is discoverable.
# After nvm installs Node.js the global bin lives under the nvm prefix,
# which may not yet be on PATH in the current session.
refresh_path() {
  ensure_nvm_loaded

  local npm_bin
  npm_bin="$(npm config get prefix 2>/dev/null)/bin" || true
  if [[ -n "$npm_bin" && -d "$npm_bin" && ":$PATH:" != *":$npm_bin:"* ]]; then
    export PATH="$npm_bin:$PATH"
  fi
}

version_major() {
  printf '%s\n' "${1#v}" | cut -d. -f1
}

ensure_supported_runtime() {
  command_exists node || error "${RUNTIME_REQUIREMENT_MSG} Node.js was not found on PATH."
  command_exists npm || error "${RUNTIME_REQUIREMENT_MSG} npm was not found on PATH."

  local node_version npm_version node_major npm_major
  node_version="$(node --version 2>/dev/null || true)"
  npm_version="$(npm --version 2>/dev/null || true)"
  node_major="$(version_major "$node_version")"
  npm_major="$(version_major "$npm_version")"

  [[ "$node_major" =~ ^[0-9]+$ ]] || error "Could not determine Node.js version from '${node_version}'. ${RUNTIME_REQUIREMENT_MSG}"
  [[ "$npm_major" =~ ^[0-9]+$ ]] || error "Could not determine npm version from '${npm_version}'. ${RUNTIME_REQUIREMENT_MSG}"

  if (( node_major < MIN_NODE_MAJOR || npm_major < MIN_NPM_MAJOR )); then
    error "Unsupported runtime detected: Node.js ${node_version:-unknown}, npm ${npm_version:-unknown}. ${RUNTIME_REQUIREMENT_MSG} Upgrade Node.js and rerun the installer."
  fi

  info "Runtime OK: Node.js ${node_version}, npm ${npm_version}"
}

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
install_nodejs() {
  if command_exists node; then
    info "Node.js found: $(node --version)"
    return
  fi

  info "Node.js not found — installing via nvm…"
  # IMPORTANT: update NVM_SHA256 when changing NVM_VERSION
  local NVM_VERSION="v0.40.4"
  local NVM_SHA256="4b7412c49960c7d31e8df72da90c1fb5b8cccb419ac99537b737028d497aba4f"
  local nvm_tmp
  nvm_tmp="$(mktemp)"
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" -o "$nvm_tmp" \
    || { rm -f "$nvm_tmp"; error "Failed to download nvm installer"; }
  local actual_hash
  if command_exists sha256sum; then
    actual_hash="$(sha256sum "$nvm_tmp" | awk '{print $1}')"
  elif command_exists shasum; then
    actual_hash="$(shasum -a 256 "$nvm_tmp" | awk '{print $1}')"
  else
    warn "No SHA-256 tool found — skipping nvm integrity check"
    actual_hash="$NVM_SHA256"  # allow execution
  fi
  if [[ "$actual_hash" != "$NVM_SHA256" ]]; then
    rm -f "$nvm_tmp"
    error "nvm installer integrity check failed\n  Expected: $NVM_SHA256\n  Actual:   $actual_hash"
  fi
  info "nvm installer integrity verified"
  bash "$nvm_tmp"
  rm -f "$nvm_tmp"
  ensure_nvm_loaded
  nvm install 22
  info "Node.js installed: $(node --version)"
}

# ---------------------------------------------------------------------------
# 2. Ollama
# ---------------------------------------------------------------------------
OLLAMA_MIN_VERSION="0.18.0"

get_ollama_version() {
  # `ollama --version` outputs something like "ollama version 0.18.0"
  ollama --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

detect_gpu() {
  # Returns 0 if a GPU is detected
  if command_exists nvidia-smi; then
    nvidia-smi &>/dev/null && return 0
  fi
  return 1
}

get_vram_mb() {
  # Returns total VRAM in MiB (NVIDIA only). Falls back to 0.
  if command_exists nvidia-smi; then
    nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
      | awk '{s += $1} END {print s+0}'
    return
  fi
  # macOS — report unified memory as VRAM
  if [[ "$(uname -s)" == "Darwin" ]] && command_exists sysctl; then
    local bytes
    bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    echo $(( bytes / 1024 / 1024 ))
    return
  fi
  echo 0
}

install_or_upgrade_ollama() {
  if detect_gpu && command_exists ollama; then
    local current
    current=$(get_ollama_version)
    if [[ -n "$current" ]] && version_gte "$current" "$OLLAMA_MIN_VERSION"; then
      info "Ollama v${current} meets minimum requirement (>= v${OLLAMA_MIN_VERSION})"
    else
      info "Ollama v${current:-unknown} is below v${OLLAMA_MIN_VERSION} — upgrading…"
      curl -fsSL https://ollama.com/install.sh | sh
      info "Ollama upgraded to $(get_ollama_version)"
    fi
  else
    # No ollama — only install if a GPU is present
    if detect_gpu; then
      info "GPU detected — installing Ollama…"
      curl -fsSL https://ollama.com/install.sh | sh
      info "Ollama installed: v$(get_ollama_version)"
    else
      warn "No GPU detected — skipping Ollama installation."
      return
    fi
  fi

  # Pull the appropriate model based on VRAM
  local vram_mb
  vram_mb=$(get_vram_mb)
  local vram_gb=$(( vram_mb / 1024 ))
  info "Detected ${vram_gb} GB VRAM"

  if (( vram_gb >= 120 )); then
    info "Pulling nemotron-3-super:120b…"
    ollama pull nemotron-3-super:120b
  else
    info "Pulling nemotron-3-nano:30b…"
    ollama pull nemotron-3-nano:30b
  fi
}

# ---------------------------------------------------------------------------
# 3. NemoClaw
# ---------------------------------------------------------------------------
install_nemoclaw() {
  if [[ -f "./package.json" ]] && grep -q '"name": "nemoclaw"' ./package.json 2>/dev/null; then
    info "NemoClaw package.json found in current directory — installing from source…"
    npm install && npm link
  else
    info "Installing NemoClaw from npm…"
    # Revert once https://github.com/NVIDIA/NemoClaw/issues/71 is complete and the package is published
    npm install -g git+ssh://git@github.com/nvidia/NemoClaw.git
  fi

  refresh_path
}

# ---------------------------------------------------------------------------
# 4. Verify
# ---------------------------------------------------------------------------
verify_nemoclaw() {
  if command_exists nemoclaw; then
    info "Verified: nemoclaw is available at $(command -v nemoclaw)"
    return 0
  fi

  # nemoclaw not on PATH — try to diagnose and suggest a fix
  warn "nemoclaw is not on PATH after installation."

  local npm_bin
  npm_bin="$(npm config get prefix 2>/dev/null)/bin" || true

  if [[ -n "$npm_bin" && -x "$npm_bin/nemoclaw" ]]; then
    warn "Found nemoclaw at $npm_bin/nemoclaw but that directory is not on PATH."
    warn ""
    warn "Add it to your shell profile:"
    warn "  echo 'export PATH=\"$npm_bin:\$PATH\"' >> ~/.bashrc"
    warn "  source ~/.bashrc"
    warn ""
    warn "Or for zsh:"
    warn "  echo 'export PATH=\"$npm_bin:\$PATH\"' >> ~/.zshrc"
    warn "  source ~/.zshrc"
    warn ""
    warn "Continuing — nemoclaw is installed but requires a PATH update."
    return 0
  else
    warn "Could not locate the nemoclaw executable."
    warn "Try running:  npm install -g nemoclaw"
  fi

  error "Installation failed: nemoclaw binary not found."
}

# ---------------------------------------------------------------------------
# 5. Onboard
# ---------------------------------------------------------------------------
run_onboard() {
  info "Running nemoclaw onboard…"
  nemoclaw onboard
}

# ---------------------------------------------------------------------------
# 6. Post-install message
# ---------------------------------------------------------------------------
post_install_message() {
  # Only show shell reload instructions when Node was installed via a
  # version manager that modifies PATH in shell profile files.
  # nvm and fnm require sourcing the profile; nodesource/brew install to
  # system paths already on PATH.
  if [[ ! -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    return 0
  fi

  local profile="$HOME/.bashrc"
  if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$(basename "${SHELL:-}")" == "zsh" ]]; then
    profile="$HOME/.zshrc"
  elif [[ ! -f "$HOME/.bashrc" && -f "$HOME/.profile" ]]; then
    profile="$HOME/.profile"
  fi

  echo ""
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
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  info "=== NemoClaw Installer ==="

  install_nodejs
  ensure_supported_runtime
  # install_or_upgrade_ollama
  install_nemoclaw
  verify_nemoclaw
  post_install_message
  run_onboard

  info "=== Installation complete ==="
}

main "$@"
