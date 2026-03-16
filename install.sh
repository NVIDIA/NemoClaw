#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw installer — installs Node.js, Ollama (if GPU present), and NemoClaw.

set -euo pipefail

# ---------------------------------------------------------------------------
# Checksum verification
# ---------------------------------------------------------------------------
# Source pinned SHA-256 digests and the verify_file helper.
# Every external download must be gated on verify_file before execution.
# shellcheck source=scripts/verify-checksums.sh
source "$(dirname "$0")/scripts/verify-checksums.sh"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

command_exists() { command -v "$1" &>/dev/null; }

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

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
install_nodejs() {
  if command_exists node; then
    info "Node.js found: $(node --version)"
    return
  fi

  info "Node.js not found — installing via nvm…"
  local _nvm_installer
  _nvm_installer=$(mktemp /tmp/nvm-install-XXXXXX.sh)
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh" -o "$_nvm_installer"
  verify_file "nvm-install.sh" "$_nvm_installer"
  bash "$_nvm_installer"
  rm -f "$_nvm_installer"
  \. "$HOME/.nvm/nvm.sh"
  nvm install 24
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
      local _ollama_installer
      _ollama_installer=$(mktemp /tmp/ollama-install-XXXXXX.sh)
      curl -fsSL "https://ollama.com/install.sh" -o "$_ollama_installer"
      verify_file "ollama-install.sh" "$_ollama_installer"
      sh "$_ollama_installer"
      rm -f "$_ollama_installer"
      info "Ollama upgraded to $(get_ollama_version)"
    fi
  else
    # No ollama — only install if a GPU is present
    if detect_gpu; then
      info "GPU detected — installing Ollama…"
      local _ollama_installer
      _ollama_installer=$(mktemp /tmp/ollama-install-XXXXXX.sh)
      curl -fsSL "https://ollama.com/install.sh" -o "$_ollama_installer"
      verify_file "ollama-install.sh" "$_ollama_installer"
      sh "$_ollama_installer"
      rm -f "$_ollama_installer"
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
    npm install -g nemoclaw
  fi
}

# ---------------------------------------------------------------------------
# 4. Onboard
# ---------------------------------------------------------------------------
run_onboard() {
  info "Running nemoclaw onboard…"
  npx nemoclaw onboard
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  info "=== NemoClaw Installer ==="

  install_nodejs
  # install_or_upgrade_ollama
  install_nemoclaw
  run_onboard

  info "=== Installation complete ==="
}

main "$@"
