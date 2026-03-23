#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw installer — installs Node.js, Ollama (if GPU present), and NemoClaw.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DEFAULT_NEMOCLAW_VERSION="0.1.0"
TOTAL_STEPS=3

resolve_installer_version() {
  local package_json="${SCRIPT_DIR}/package.json"
  local version=""
  if [[ -f "$package_json" ]]; then
    version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$package_json" | head -1)"
  fi
  printf "%s" "${version:-$DEFAULT_NEMOCLAW_VERSION}"
}

NEMOCLAW_VERSION="$(resolve_installer_version)"

# ---------------------------------------------------------------------------
# Color / style — disabled when NO_COLOR is set or stdout is not a TTY.
# Uses exact NVIDIA green #76B900 on truecolor terminals; 256-color otherwise.
# ---------------------------------------------------------------------------
if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
  if [[ "${COLORTERM:-}" == "truecolor" || "${COLORTERM:-}" == "24bit" ]]; then
    C_GREEN=$'\033[38;2;118;185;0m' # #76B900 — exact NVIDIA green
  else
    C_GREEN=$'\033[38;5;148m' # closest 256-color on dark backgrounds
  fi
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[1;31m'
  C_YELLOW=$'\033[1;33m'
  C_CYAN=$'\033[1;36m'
  C_RESET=$'\033[0m'
else
  C_GREEN='' C_BOLD='' C_DIM='' C_RED='' C_YELLOW='' C_CYAN='' C_RESET=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info() { printf "${C_CYAN}[INFO]${C_RESET}  %s\n" "$*"; }
warn() { printf "${C_YELLOW}[WARN]${C_RESET}  %s\n" "$*"; }
error() {
  printf "${C_RED}[ERROR]${C_RESET} %s\n" "$*" >&2
  exit 1
}
ok() { printf "  ${C_GREEN}✓${C_RESET}  %s\n" "$*"; }

resolve_default_sandbox_name() {
  local registry_file="${HOME}/.nemoclaw/sandboxes.json"
  local sandbox_name="${NEMOCLAW_SANDBOX_NAME:-}"

  if [[ -z "$sandbox_name" && -f "$registry_file" ]] && command_exists node; then
    sandbox_name="$(
      node -e '
        const fs = require("fs");
        const file = process.argv[1];
        try {
          const data = JSON.parse(fs.readFileSync(file, "utf8"));
          const sandboxes = data.sandboxes || {};
          const preferred = data.defaultSandbox;
          const name = (preferred && sandboxes[preferred] && preferred) || Object.keys(sandboxes)[0] || "";
          process.stdout.write(name);
        } catch {}
      ' "$registry_file" 2>/dev/null || true
    )"
  fi

  printf "%s" "${sandbox_name:-my-assistant}"
}

# step N "Description" — numbered section header
step() {
  local n=$1 msg=$2
  printf "\n${C_GREEN}[%s/%s]${C_RESET} ${C_BOLD}%s${C_RESET}\n" \
    "$n" "$TOTAL_STEPS" "$msg"
  printf "  ${C_DIM}──────────────────────────────────────────────────${C_RESET}\n"
}

print_banner() {
  printf "\n"
  # ANSI Shadow ASCII art — hand-crafted, no figlet dependency
  printf "  ${C_GREEN}${C_BOLD} ███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝${C_RESET}\n"
  printf "\n"
  printf "  ${C_DIM}Launch OpenClaw in an OpenShell sandbox.  v%s${C_RESET}\n" "$NEMOCLAW_VERSION"
  printf "\n"
}

print_done() {
  local elapsed=$((SECONDS - _INSTALL_START))
  local sandbox_name
  sandbox_name="$(resolve_default_sandbox_name)"
  info "=== Installation complete ==="
  printf "\n"
  printf "  ${C_GREEN}${C_BOLD}NemoClaw${C_RESET}  ${C_DIM}(%ss)${C_RESET}\n" "$elapsed"
  printf "\n"
  printf "  ${C_GREEN}Your OpenClaw Sandbox is live.${C_RESET}\n"
  printf "  ${C_DIM}Sandbox in, break things, and tell us what you find.${C_RESET}\n"
  printf "\n"
  printf "  ${C_GREEN}Next:${C_RESET}\n"
  printf "  %s$%s nemoclaw %s connect\n" "$C_GREEN" "$C_RESET" "$sandbox_name"
  printf "  %ssandbox@%s$%s openclaw tui\n" "$C_GREEN" "$sandbox_name" "$C_RESET"
  printf "\n"
  printf "  ${C_BOLD}GitHub${C_RESET}  ${C_DIM}https://github.com/nvidia/nemoclaw${C_RESET}\n"
  printf "  ${C_BOLD}Docs${C_RESET}    ${C_DIM}https://docs.nvidia.com/nemoclaw/latest/${C_RESET}\n"
  printf "\n"
}

usage() {
  printf "\n"
  printf "  ${C_BOLD}NemoClaw Installer${C_RESET}  ${C_DIM}v%s${C_RESET}\n\n" "$NEMOCLAW_VERSION"
  printf "  ${C_DIM}Usage:${C_RESET}\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- [options]\n\n"
  printf "  ${C_DIM}Options:${C_RESET}\n"
  printf "    --non-interactive    Skip prompts (uses env vars / defaults)\n"
  printf "    --version, -v        Print installer version and exit\n"
  printf "    --help               Show this help message and exit\n\n"
  printf "  ${C_DIM}Environment:${C_RESET}\n"
  printf "    NVIDIA_API_KEY                API key (skips credential prompt)\n"
  printf "    NEMOCLAW_NON_INTERACTIVE=1    Same as --non-interactive\n"
  printf "    NEMOCLAW_SANDBOX_NAME         Sandbox name to create/use\n"
  printf "    NEMOCLAW_RECREATE_SANDBOX=1   Recreate an existing sandbox\n"
  printf "    NEMOCLAW_PROVIDER             cloud | ollama | nim | vllm\n"
  printf "    NEMOCLAW_MODEL                Inference model to configure\n"
  printf "    NEMOCLAW_POLICY_MODE          suggested | custom | skip\n"
  printf "    NEMOCLAW_POLICY_PRESETS       Comma-separated policy presets\n"
  printf "    NEMOCLAW_EXPERIMENTAL=1       Show experimental/local options\n"
  printf "    CHAT_UI_URL                   Chat UI URL to open after setup\n"
  printf "    DISCORD_BOT_TOKEN             Auto-enable Discord policy support\n"
  printf "    SLACK_BOT_TOKEN               Auto-enable Slack policy support\n"
  printf "    TELEGRAM_BOT_TOKEN            Auto-enable Telegram policy support\n"
  printf "\n"
}

# spin "label" cmd [args...]
#   Runs a command in the background, showing a braille spinner until it exits.
#   Stdout/stderr are captured; dumped only on failure.
#   Falls back to plain output when stdout is not a TTY (CI / piped installs).
spin() {
  local msg="$1"
  shift

  if [[ ! -t 1 ]]; then
    info "$msg"
    "$@"
    return
  fi

  local log
  log=$(mktemp)
  "$@" >"$log" 2>&1 &
  local pid=$! i=0
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C_GREEN}%s${C_RESET}  %s" "${frames[$((i++ % 10))]}" "$msg"
    sleep 0.08
  done

  if wait "$pid"; then
    local status=0
  else
    local status=$?
  fi
  if [[ $status -eq 0 ]]; then
    printf "\r  ${C_GREEN}✓${C_RESET}  %s\n" "$msg"
  else
    printf "\r  ${C_RED}✗${C_RESET}  %s\n\n" "$msg"
    cat "$log" >&2
    printf "\n"
  fi
  rm -f "$log"
  return $status
}

command_exists() { command -v "$1" &>/dev/null; }

MIN_NODE_MAJOR=20
MIN_NPM_MAJOR=10
RECOMMENDED_NODE_MAJOR=22
RUNTIME_REQUIREMENT_MSG="NemoClaw requires Node.js >=${MIN_NODE_MAJOR} and npm >=${MIN_NPM_MAJOR} (recommended Node.js ${RECOMMENDED_NODE_MAJOR})."
NEMOCLAW_SHIM_DIR="${HOME}/.local/bin"
ORIGINAL_PATH="${PATH:-}"

# Compare two semver strings (major.minor.patch). Returns 0 if $1 >= $2.
version_gte() {
  local -a a b
  IFS=. read -ra a <<<"$1"
  IFS=. read -ra b <<<"$2"
  for i in 0 1 2; do
    local ai=${a[$i]:-0} bi=${b[$i]:-0}
    if ((ai > bi)); then return 0; fi
    if ((ai < bi)); then return 1; fi
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

  if [[ -d "$NEMOCLAW_SHIM_DIR" && ":$PATH:" != *":$NEMOCLAW_SHIM_DIR:"* ]]; then
    export PATH="$NEMOCLAW_SHIM_DIR:$PATH"
  fi
}

ensure_nemoclaw_shim() {
  local npm_bin shim_path
  npm_bin="$(npm config get prefix 2>/dev/null)/bin" || true
  shim_path="${NEMOCLAW_SHIM_DIR}/nemoclaw"

  if [[ -z "$npm_bin" || ! -x "$npm_bin/nemoclaw" ]]; then
    return 1
  fi

  if [[ ":$ORIGINAL_PATH:" == *":$npm_bin:"* ]] || [[ ":$ORIGINAL_PATH:" == *":$NEMOCLAW_SHIM_DIR:"* ]]; then
    return 0
  fi

  mkdir -p "$NEMOCLAW_SHIM_DIR"
  ln -sfn "$npm_bin/nemoclaw" "$shim_path"
  refresh_path
  info "Created user-local shim at $shim_path"
  return 0
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

  if ((node_major < MIN_NODE_MAJOR || npm_major < MIN_NPM_MAJOR)); then
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
    || {
      rm -f "$nvm_tmp"
      error "Failed to download nvm installer"
    }
  local actual_hash
  if command_exists sha256sum; then
    actual_hash="$(sha256sum "$nvm_tmp" | awk '{print $1}')"
  elif command_exists shasum; then
    actual_hash="$(shasum -a 256 "$nvm_tmp" | awk '{print $1}')"
  else
    warn "No SHA-256 tool found — skipping nvm integrity check"
    actual_hash="$NVM_SHA256" # allow execution
  fi
  if [[ "$actual_hash" != "$NVM_SHA256" ]]; then
    rm -f "$nvm_tmp"
    error "nvm installer integrity check failed\n  Expected: $NVM_SHA256\n  Actual:   $actual_hash"
  fi
  info "nvm installer integrity verified"
  spin "Installing nvm..." bash "$nvm_tmp"
  rm -f "$nvm_tmp"
  ensure_nvm_loaded
  spin "Installing Node.js ${RECOMMENDED_NODE_MAJOR}..." bash -c ". \"$NVM_DIR/nvm.sh\" && nvm install ${RECOMMENDED_NODE_MAJOR} --no-progress"
  ensure_nvm_loaded
  nvm use "${RECOMMENDED_NODE_MAJOR}" --silent
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
    echo $((bytes / 1024 / 1024))
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
  local vram_gb=$((vram_mb / 1024))
  info "Detected ${vram_gb} GB VRAM"

  if ((vram_gb >= 120)); then
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
# Work around openclaw tarball missing directory entries (GH-503).
# npm's tar extractor hard-fails because the tarball is missing directory
# entries for extensions/, skills/, and dist/plugin-sdk/config/. System tar
# handles this fine. We pre-extract openclaw into node_modules BEFORE npm
# install so npm sees the dependency is already satisfied and skips it.
pre_extract_openclaw() {
  local install_dir="$1"
  local openclaw_version
  openclaw_version=$(node -e "console.log(require('${install_dir}/package.json').dependencies.openclaw)" 2>/dev/null || echo "")

  if [[ -z "$openclaw_version" ]]; then
    warn "Could not determine openclaw version — skipping pre-extraction"
    return 1
  fi

  info "Pre-extracting openclaw@${openclaw_version} with system tar (GH-503 workaround)…"
  local tmpdir
  tmpdir="$(mktemp -d)"
  if npm pack "openclaw@${openclaw_version}" --pack-destination "$tmpdir" >/dev/null 2>&1; then
    local tgz
    tgz="$(find "$tmpdir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit)"
    if [[ -n "$tgz" && -f "$tgz" ]]; then
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

install_nemoclaw() {
  if [[ -f "./package.json" ]] && grep -q '"name": "nemoclaw"' ./package.json 2>/dev/null; then
    info "NemoClaw package.json found in current directory — installing from source…"
    spin "Preparing OpenClaw package" bash -lc "$(declare -f pre_extract_openclaw); pre_extract_openclaw \"\$1\"" _ "$(pwd)" \
      || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
    spin "Installing NemoClaw dependencies" npm install --ignore-scripts
    spin "Building NemoClaw plugin" bash -lc 'cd nemoclaw && npm install --ignore-scripts && npm run build'
    spin "Linking NemoClaw CLI" npm link
  else
    info "Installing NemoClaw from GitHub…"
    # Clone first so we can pre-extract openclaw before npm install (GH-503).
    # npm install -g git+https://... does this internally but we can't hook
    # into its extraction pipeline, so we do it ourselves.
    local nemoclaw_src="${HOME}/.nemoclaw/source"
    rm -rf "$nemoclaw_src"
    mkdir -p "$(dirname "$nemoclaw_src")"
    spin "Cloning NemoClaw source" git clone --depth 1 https://github.com/NVIDIA/NemoClaw.git "$nemoclaw_src"
    spin "Preparing OpenClaw package" bash -lc "$(declare -f pre_extract_openclaw); pre_extract_openclaw \"\$1\"" _ "$nemoclaw_src" \
      || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
    spin "Installing NemoClaw dependencies" bash -lc "cd \"$nemoclaw_src\" && npm install --ignore-scripts"
    spin "Building NemoClaw plugin" bash -lc "cd \"$nemoclaw_src\"/nemoclaw && npm install --ignore-scripts && npm run build"
    spin "Linking NemoClaw CLI" bash -lc "cd \"$nemoclaw_src\" && npm link"
  fi

  refresh_path
  ensure_nemoclaw_shim || true
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
    ensure_nemoclaw_shim || true
    if command_exists nemoclaw; then
      info "Verified: nemoclaw is available at $(command -v nemoclaw)"
      return 0
    fi

    warn "Found nemoclaw at $npm_bin/nemoclaw but could not expose it on PATH."
    warn ""
    warn "Add one of these directories to your shell profile:"
    warn "  $NEMOCLAW_SHIM_DIR"
    warn "  $npm_bin"
    warn ""
    warn "Continuing — nemoclaw is installed but requires a PATH update."
    return 0
  else
    warn "Could not locate the nemoclaw executable."
    warn "Try running:  npm install -g git+https://github.com/NVIDIA/NemoClaw.git"
  fi

  error "Installation failed: nemoclaw binary not found."
}

# ---------------------------------------------------------------------------
# 5. Onboard
# ---------------------------------------------------------------------------
run_onboard() {
  info "Running nemoclaw onboard…"
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    nemoclaw onboard --non-interactive
  elif [ -t 0 ]; then
    nemoclaw onboard
  elif exec 3</dev/tty; then
    info "Installer stdin is piped; attaching onboarding to /dev/tty…"
    local status=0
    nemoclaw onboard <&3 || status=$?
    exec 3<&-
    return "$status"
  else
    error "Interactive onboarding requires a TTY. Re-run in a terminal or set NEMOCLAW_NON_INTERACTIVE=1."
  fi
}

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
  # Parse flags
  NON_INTERACTIVE=""
  for arg in "$@"; do
    case "$arg" in
      --non-interactive) NON_INTERACTIVE=1 ;;
      --version | -v)
        printf "nemoclaw-installer v%s\n" "$NEMOCLAW_VERSION"
        exit 0
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        usage
        error "Unknown option: $arg"
        ;;
    esac
  done
  # Also honor env var
  NON_INTERACTIVE="${NON_INTERACTIVE:-${NEMOCLAW_NON_INTERACTIVE:-}}"
  export NEMOCLAW_NON_INTERACTIVE="${NON_INTERACTIVE}"

  _INSTALL_START=$SECONDS
  print_banner

  step 1 "Node.js"
  install_nodejs
  ensure_supported_runtime

  step 2 "NemoClaw CLI"
  # install_or_upgrade_ollama
  install_nemoclaw
  verify_nemoclaw
  post_install_message

  step 3 "Onboarding"
  if command_exists nemoclaw; then
    run_onboard
  else
    warn "Skipping onboarding — nemoclaw is not on PATH. Run 'nemoclaw onboard' after updating your PATH."
  fi

  print_done
}

main "$@"
