#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
#
# NemoClaw installer — installs Node.js, Ollama (if GPU present), and NemoClaw.

set -euo pipefail

# Global cleanup state — ensures background processes are killed and temp files
# are removed on any exit path (set -e, unhandled signal, unexpected error).
_cleanup_pids=()
_cleanup_files=()
_global_cleanup() {
  for pid in "${_cleanup_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for f in "${_cleanup_files[@]:-}"; do
    rm -f "$f" 2>/dev/null || true
  done
}
trap _global_cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

resolve_repo_root() {
  local base="${NEMOCLAW_REPO_ROOT:-$SCRIPT_DIR}"
  if [[ -f "${base}/package.json" ]]; then
    (cd "${base}" && pwd)
    return
  fi
  if [[ -f "${base}/../package.json" ]]; then
    (cd "${base}/.." && pwd)
    return
  fi
  if [[ -f "${base}/../../package.json" ]]; then
    (cd "${base}/../.." && pwd)
    return
  fi
  printf "%s\n" "$base"
}
DEFAULT_NEMOCLAW_VERSION="0.1.0"
TOTAL_STEPS=3

resolve_installer_version() {
  local repo_root
  repo_root="$(resolve_repo_root)"
  if [[ -n "${NEMOCLAW_INSTALL_REF:-}" && "${NEMOCLAW_INSTALL_REF}" != "latest" ]]; then
    printf "%s" "${NEMOCLAW_INSTALL_REF#v}"
    return
  fi
  # Prefer git tags (works in dev clones and CI)
  if command -v git &>/dev/null && [[ -d "${repo_root}/.git" ]]; then
    local git_ver=""
    if git_ver="$(git -C "$repo_root" describe --tags --match 'v*' 2>/dev/null)"; then
      git_ver="${git_ver#v}"
      if [[ -n "$git_ver" ]]; then
        printf "%s" "$git_ver"
        return
      fi
    fi
  fi
  # Fall back to .version file (stamped during install)
  if [[ -f "${repo_root}/.version" ]]; then
    local file_ver
    file_ver="$(cat "${repo_root}/.version")"
    if [[ -n "$file_ver" ]]; then
      printf "%s" "$file_ver"
      return
    fi
  fi
  # Last resort: package.json
  local package_json="${repo_root}/package.json"
  local version=""
  if [[ -f "$package_json" ]]; then
    version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$package_json" | head -1)"
  fi
  printf "%s" "${version:-$DEFAULT_NEMOCLAW_VERSION}"
}

NEMOCLAW_VERSION="$(resolve_installer_version)"

installer_version_for_display() {
  if [[ -z "${NEMOCLAW_VERSION:-}" || "${NEMOCLAW_VERSION}" == "${DEFAULT_NEMOCLAW_VERSION}" ]]; then
    printf ""
    return
  fi
  printf "  v%s" "$NEMOCLAW_VERSION"
}

# Resolve which Git ref to install from.
# Priority: NEMOCLAW_INSTALL_TAG env var > "latest" tag.
resolve_release_tag() {
  if [[ -n "${NEMOCLAW_INSTALL_REF:-}" ]]; then
    printf "%s" "${NEMOCLAW_INSTALL_REF}"
    return
  fi
  # Allow explicit override (for CI, pinning, or testing).
  # Otherwise default to the "latest" tag, which we maintain to point at
  # the commit we want everybody to install.
  printf "%s" "${NEMOCLAW_INSTALL_TAG:-latest}"
}

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

verify_downloaded_script() {
  local file="$1" label="${2:-script}"
  if [ ! -s "$file" ]; then
    error "$label installer download is empty or missing"
  fi
  if ! head -1 "$file" | grep -qE '^#!.*(sh|bash)'; then
    error "$label installer does not start with a shell shebang — possible download corruption"
  fi
  local hash
  if command -v sha256sum >/dev/null 2>&1; then
    hash="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    hash="$(shasum -a 256 "$file" | awk '{print $1}')"
  fi
  if [ -n "${hash:-}" ]; then
    info "$label installer SHA-256: $hash"
  fi
}

resolve_default_sandbox_name() {
  local registry_file="${HOME}/.nemoclaw/sandboxes.json"
  local sandbox_name="${NEMOCLAW_SANDBOX_NAME:-}"

  # Prefer the sandbox name from the current onboard session — it reflects
  # the sandbox just created, whereas sandboxes.json may hold a stale default
  # from a previous gateway that no longer exists (#1839).
  local session_file="${HOME}/.nemoclaw/onboard-session.json"
  if [[ -z "$sandbox_name" && -f "$session_file" ]] && command_exists node; then
    sandbox_name="$(
      node -e '
        const fs = require("fs");
        try {
          const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const name = data.sandboxName || "";
          process.stdout.write(name);
        } catch {}
      ' "$session_file" 2>/dev/null || true
    )"
  fi

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

resolve_onboarded_agent() {
  local session_file="${HOME}/.nemoclaw/onboard-session.json"
  if [[ -f "$session_file" ]] && command_exists node; then
    node -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(data.agent || "openclaw");
      } catch { process.stdout.write("openclaw"); }
    ' "$session_file" 2>/dev/null || printf "openclaw"
  else
    printf "openclaw"
  fi
}

# step N "Description" — numbered section header
step() {
  local n=$1 msg=$2
  printf "\n${C_GREEN}[%s/%s]${C_RESET} ${C_BOLD}%s${C_RESET}\n" \
    "$n" "$TOTAL_STEPS" "$msg"
  printf "  ${C_DIM}──────────────────────────────────────────────────${C_RESET}\n"
}

print_banner() {
  local version_suffix
  version_suffix="$(installer_version_for_display)"
  printf "\n"
  # ANSI Shadow ASCII art — hand-crafted, no figlet dependency
  printf "  ${C_GREEN}${C_BOLD} ███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝${C_RESET}\n"
  printf "  ${C_GREEN}${C_BOLD} ╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝${C_RESET}\n"
  printf "\n"
  if [[ -n "${NEMOCLAW_AGENT:-}" && "${NEMOCLAW_AGENT}" != "openclaw" ]]; then
    printf "  ${C_DIM}Launch %s in an OpenShell sandbox.%s${C_RESET}\n" "${NEMOCLAW_AGENT^}" "$version_suffix"
  else
    printf "  ${C_DIM}Launch OpenClaw in an OpenShell sandbox.%s${C_RESET}\n" "$version_suffix"
  fi
  printf "\n"
}

print_done() {
  local elapsed=$((SECONDS - _INSTALL_START))
  local _needs_reload=false
  needs_shell_reload && _needs_reload=true

  info "=== Installation complete ==="
  printf "\n"
  printf "  ${C_GREEN}${C_BOLD}NemoClaw${C_RESET}  ${C_DIM}(%ss)${C_RESET}\n" "$elapsed"
  printf "\n"
  if [[ "$ONBOARD_RAN" == true ]]; then
    local sandbox_name agent_name
    sandbox_name="$(resolve_default_sandbox_name)"
    agent_name="$(resolve_onboarded_agent)"
    if [[ "$agent_name" == "openclaw" || -z "$agent_name" ]]; then
      printf "  ${C_GREEN}Your OpenClaw Sandbox is live.${C_RESET}\n"
    else
      printf "  ${C_GREEN}Your %s Sandbox is live.${C_RESET}\n" "${agent_name^}"
    fi
    printf "  ${C_DIM}Sandbox in, break things, and tell us what you find.${C_RESET}\n"
    printf "\n"
    printf "  ${C_GREEN}Next:${C_RESET}\n"
    if [[ "$_needs_reload" == true ]]; then
      printf "  %s$%s source %s\n" "$C_GREEN" "$C_RESET" "$(detect_shell_profile)"
    fi
    printf "  %s$%s nemoclaw %s connect\n" "$C_GREEN" "$C_RESET" "$sandbox_name"
    if [[ "$agent_name" == "openclaw" || -z "$agent_name" ]]; then
      printf "  %ssandbox@%s$%s openclaw tui\n" "$C_GREEN" "$sandbox_name" "$C_RESET"
    fi
  elif [[ "$NEMOCLAW_READY_NOW" == true ]]; then
    printf "  ${C_GREEN}NemoClaw CLI is installed.${C_RESET}\n"
    printf "  ${C_DIM}Onboarding has not run yet.${C_RESET}\n"
    printf "\n"
    printf "  ${C_GREEN}Next:${C_RESET}\n"
    if [[ "$_needs_reload" == true ]]; then
      printf "  %s$%s source %s\n" "$C_GREEN" "$C_RESET" "$(detect_shell_profile)"
    fi
    printf "  %s$%s nemoclaw onboard\n" "$C_GREEN" "$C_RESET"
  else
    printf "  ${C_GREEN}NemoClaw CLI is installed.${C_RESET}\n"
    printf "  ${C_DIM}Onboarding did not run because this shell cannot resolve 'nemoclaw' yet.${C_RESET}\n"
    printf "\n"
    printf "  ${C_GREEN}Next:${C_RESET}\n"
    if [[ -n "$NEMOCLAW_RECOVERY_EXPORT_DIR" ]]; then
      printf "  %s$%s export PATH=\"%s:\$PATH\"\n" "$C_GREEN" "$C_RESET" "$NEMOCLAW_RECOVERY_EXPORT_DIR"
    fi
    if [[ -n "$NEMOCLAW_RECOVERY_PROFILE" ]]; then
      printf "  %s$%s source %s\n" "$C_GREEN" "$C_RESET" "$NEMOCLAW_RECOVERY_PROFILE"
    fi
    printf "  %s$%s nemoclaw onboard\n" "$C_GREEN" "$C_RESET"
  fi
  printf "\n"
  printf "  ${C_BOLD}GitHub${C_RESET}  ${C_DIM}https://github.com/nvidia/nemoclaw${C_RESET}\n"
  printf "  ${C_BOLD}Docs${C_RESET}    ${C_DIM}https://docs.nvidia.com/nemoclaw/latest/${C_RESET}\n"
  printf "\n"
}

usage() {
  local version_suffix
  version_suffix="$(installer_version_for_display)"
  printf "\n"
  printf "  ${C_BOLD}NemoClaw Installer${C_RESET}${C_DIM}%s${C_RESET}\n\n" "$version_suffix"
  printf "  ${C_DIM}Usage:${C_RESET}\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- [options]\n\n"
  printf "  ${C_DIM}Options:${C_RESET}\n"
  printf "    --non-interactive    Skip prompts (uses env vars / defaults)\n"
  printf "    --yes-i-accept-third-party-software Accept the third-party software notice in non-interactive mode\n"
  printf "    --version, -v        Print installer version and exit\n"
  printf "    --help, -h           Show this help message and exit\n\n"
  printf "  ${C_DIM}Environment:${C_RESET}\n"
  printf "    NVIDIA_API_KEY                API key (skips credential prompt)\n"
  printf "    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 Same as --yes-i-accept-third-party-software\n"
  printf "    NEMOCLAW_NON_INTERACTIVE=1    Same as --non-interactive\n"
  printf "    NEMOCLAW_SANDBOX_NAME         Sandbox name to create/use\n"
  printf "    NEMOCLAW_SINGLE_SESSION=1     Abort if active sandbox sessions exist\n"
  printf "    NEMOCLAW_RECREATE_SANDBOX=1   Recreate an existing sandbox\n"
  printf "    NEMOCLAW_INSTALL_TAG         Git ref to install (default: latest release)\n"
  printf "    NEMOCLAW_PROVIDER             build | openai | anthropic | anthropicCompatible\n"
  printf "                                  | gemini | ollama | custom | nim-local | vllm\n"
  printf "                                  (aliases: cloud -> build, nim -> nim-local)\n"
  printf "    NEMOCLAW_MODEL                Inference model to configure\n"
  printf "    NEMOCLAW_POLICY_MODE          suggested | custom | skip\n"
  printf "    NEMOCLAW_POLICY_PRESETS       Comma-separated policy presets\n"
  printf "    BRAVE_API_KEY                 Enable Brave Search with this API key (stored in sandbox OpenClaw config)\n"
  printf "    NEMOCLAW_EXPERIMENTAL=1       Show experimental/local options\n"
  printf "    CHAT_UI_URL                   Chat UI URL to open after setup\n"
  printf "    DISCORD_BOT_TOKEN             Auto-enable Discord policy support\n"
  printf "    SLACK_BOT_TOKEN               Auto-enable Slack policy support\n"
  printf "    TELEGRAM_BOT_TOKEN            Auto-enable Telegram policy support\n"
  printf "\n"
}

show_usage_notice() {
  local repo_root
  repo_root="$(resolve_repo_root)"
  local source_root="${NEMOCLAW_SOURCE_ROOT:-$repo_root}"
  local notice_script="${source_root}/bin/lib/usage-notice.js"
  if [[ ! -f "$notice_script" ]]; then
    notice_script="${repo_root}/bin/lib/usage-notice.js"
  fi
  local -a notice_cmd=(node "$notice_script")
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    notice_cmd+=(--non-interactive)
    if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
      notice_cmd+=(--yes-i-accept-third-party-software)
    fi
    "${notice_cmd[@]}"
  elif [ -t 0 ]; then
    "${notice_cmd[@]}"
  elif exec 3</dev/tty; then
    info "Installer stdin is piped; attaching the usage notice to /dev/tty…"
    local status=0
    "${notice_cmd[@]}" <&3 || status=$?
    exec 3<&-
    return "$status"
  else
    error "Interactive third-party software acceptance requires a TTY. Re-run in a terminal or set NEMOCLAW_NON_INTERACTIVE=1 with --yes-i-accept-third-party-software."
  fi
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
  local status
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

  # Register with global cleanup so any exit path reaps the child and temp file.
  _cleanup_pids+=("$pid")
  _cleanup_files+=("$log")

  # Ensure Ctrl+C kills the background process and cleans up the temp file.
  trap 'kill "$pid" 2>/dev/null; rm -f "$log"; exit 130' INT TERM

  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C_GREEN}%s${C_RESET}  %s" "${frames[$((i++ % 10))]}" "$msg"
    sleep 0.08
  done

  # Restore default signal handling after the background process exits.
  trap - INT TERM

  if wait "$pid"; then
    status=0
  else
    status=$?
  fi

  if [[ $status -eq 0 ]]; then
    printf "\r  ${C_GREEN}✓${C_RESET}  %s\n" "$msg"
  else
    printf "\r  ${C_RED}✗${C_RESET}  %s\n\n" "$msg"
    cat "$log" >&2
    printf "\n"
  fi
  rm -f "$log"

  # Deregister only after cleanup actions are complete, so the global EXIT
  # trap still covers this pid/log if a signal arrives before this point.
  _cleanup_pids=("${_cleanup_pids[@]/$pid/}")
  _cleanup_files=("${_cleanup_files[@]/$log/}")
  return $status
}

command_exists() { command -v "$1" &>/dev/null; }

MIN_NODE_VERSION="22.16.0"
MIN_NPM_MAJOR=10
RUNTIME_REQUIREMENT_MSG="NemoClaw requires Node.js >=${MIN_NODE_VERSION} and npm >=${MIN_NPM_MAJOR}."
NEMOCLAW_SHIM_DIR="${HOME}/.local/bin"
NEMOCLAW_READY_NOW=false
NEMOCLAW_RECOVERY_PROFILE=""
NEMOCLAW_RECOVERY_EXPORT_DIR=""
NEMOCLAW_SOURCE_ROOT="$(resolve_repo_root)"
ONBOARD_RAN=false

# Compare two semver strings (major.minor.patch). Returns 0 if $1 >= $2.
# Rejects prerelease suffixes (e.g. "22.16.0-rc.1") to avoid arithmetic errors.
version_gte() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || return 1
  [[ "$2" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || return 1
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
# Skip if node is already on PATH — sourcing nvm.sh can reset PATH and
# override the caller's node/npm (e.g. in test environments with stubs).
# Pass --force to load nvm even when node is on PATH (needed when upgrading).
ensure_nvm_loaded() {
  if [[ "${1:-}" != "--force" ]]; then
    command -v node &>/dev/null && return 0
  fi
  if [[ -z "${NVM_DIR:-}" ]]; then
    export NVM_DIR="$HOME/.nvm"
  fi
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    \. "$NVM_DIR/nvm.sh"
  fi
}

detect_shell_profile() {
  local profile="$HOME/.bashrc"
  case "$(basename "${SHELL:-}")" in
    zsh)
      profile="$HOME/.zshrc"
      ;;
    fish)
      profile="$HOME/.config/fish/config.fish"
      ;;
    tcsh)
      profile="$HOME/.tcshrc"
      ;;
    csh)
      profile="$HOME/.cshrc"
      ;;
    *)
      if [[ ! -f "$HOME/.bashrc" && -f "$HOME/.profile" ]]; then
        profile="$HOME/.profile"
      fi
      ;;
  esac
  printf "%s" "$profile"
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
  local npm_bin shim_path node_path node_dir cli_path
  npm_bin="$(npm config get prefix 2>/dev/null)/bin" || true
  shim_path="${NEMOCLAW_SHIM_DIR}/nemoclaw"

  if [[ -z "$npm_bin" || ! -x "$npm_bin/nemoclaw" ]]; then
    return 1
  fi

  node_path="$(command -v node 2>/dev/null || true)"
  if [[ -z "$node_path" || ! -x "$node_path" ]]; then
    return 1
  fi

  cli_path="$npm_bin/nemoclaw"
  if [[ -z "$cli_path" || ! -x "$cli_path" ]]; then
    return 1
  fi
  node_dir="$(dirname "$node_path")"

  # If npm placed the binary at the same path as the shim target (e.g. when
  # npm_config_prefix=$HOME/.local), writing a shim would overwrite the real
  # binary with a script that exec's itself — an infinite loop.  In that case
  # the binary is already where it needs to be; skip shim creation.
  if [[ "$cli_path" -ef "$shim_path" ]]; then
    refresh_path
    ensure_local_bin_in_profile
    return 0
  fi

  mkdir -p "$NEMOCLAW_SHIM_DIR"
  cat >"$shim_path" <<EOF
#!/usr/bin/env bash
export PATH="$node_dir:\$PATH"
exec "$cli_path" "\$@"
EOF
  chmod +x "$shim_path"
  refresh_path
  ensure_local_bin_in_profile
  info "Created user-local shim at $shim_path"
  return 0
}

# Detect whether the parent shell likely needs a reload after install.
# When running via `curl | bash`, the installer executes in a subprocess.
# Even when the bin directory is already in PATH, the parent shell may have
# stale bash hash-table entries pointing to a previously deleted binary
# (e.g. upgrade/reinstall after `rm $(which nemoclaw)`).  Sourcing the
# shell profile reassigns PATH which clears the hash table, so we always
# recommend it when the installer verified nemoclaw in the subprocess.
needs_shell_reload() {
  [[ "$NEMOCLAW_READY_NOW" != true ]] && return 1
  return 0
}

# Add ~/.local/bin (and for fish, the nvm node bin) to the user's shell
# profile PATH so that nemoclaw, openshell, and any future tools installed
# there are discoverable in new terminal sessions.
# Idempotent — skips if the marker comment is already present.
ensure_local_bin_in_profile() {
  local profile
  profile="$(detect_shell_profile)"
  [[ -n "$profile" ]] || return 0

  # Already present — nothing to do.
  if [[ -f "$profile" ]] && grep -qF '# NemoClaw PATH setup' "$profile" 2>/dev/null; then
    return 0
  fi

  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"

  local local_bin="$NEMOCLAW_SHIM_DIR"

  case "$shell_name" in
    fish)
      # fish needs both ~/.local/bin and the nvm node bin (nvm doesn't support fish).
      local node_bin=""
      node_bin="$(command -v node 2>/dev/null)" || true
      if [[ -n "$node_bin" ]]; then
        node_bin="$(dirname "$node_bin")"
      fi
      {
        printf '\n# NemoClaw PATH setup\n'
        printf 'fish_add_path --path --append "%s"\n' "$local_bin"
        if [[ -n "$node_bin" ]]; then
          printf 'fish_add_path --path --append "%s"\n' "$node_bin"
        fi
        printf '# end NemoClaw PATH setup\n'
      } >>"$profile"
      ;;
    tcsh | csh)
      {
        printf '\n# NemoClaw PATH setup\n'
        # shellcheck disable=SC2016
        printf 'setenv PATH "%s:${PATH}"\n' "$local_bin"
        printf '# end NemoClaw PATH setup\n'
      } >>"$profile"
      ;;
    *)
      # bash, zsh, and others — nvm already handles node PATH for these shells.
      {
        printf '\n# NemoClaw PATH setup\n'
        # shellcheck disable=SC2016
        printf 'export PATH="%s:$PATH"\n' "$local_bin"
        printf '# end NemoClaw PATH setup\n'
      } >>"$profile"
      ;;
  esac
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

  if ! version_gte "${node_version#v}" "$MIN_NODE_VERSION" || ((npm_major < MIN_NPM_MAJOR)); then
    error "Unsupported runtime detected: Node.js ${node_version:-unknown}, npm ${npm_version:-unknown}. ${RUNTIME_REQUIREMENT_MSG} Upgrade Node.js and rerun the installer."
  fi

  info "Runtime OK: Node.js ${node_version}, npm ${npm_version}"
}

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
install_nodejs() {
  if command_exists node; then
    local current_version current_npm_major
    current_version="$(node --version 2>/dev/null || true)"
    current_npm_major="$(version_major "$(npm --version 2>/dev/null || echo 0)")"
    if version_gte "${current_version#v}" "$MIN_NODE_VERSION" \
      && [[ "$current_npm_major" =~ ^[0-9]+$ ]] \
      && ((current_npm_major >= MIN_NPM_MAJOR)); then
      info "Node.js found: ${current_version}"
      return
    fi
    warn "Node.js ${current_version}, npm major ${current_npm_major:-unknown} found but NemoClaw requires Node.js >=${MIN_NODE_VERSION} and npm >=${MIN_NPM_MAJOR} — upgrading via nvm…"
  else
    info "Node.js not found — installing via nvm…"
  fi
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
  ensure_nvm_loaded --force
  spin "Installing Node.js 22..." bash -c ". \"$NVM_DIR/nvm.sh\" && nvm install 22 --no-progress"
  ensure_nvm_loaded --force
  nvm use 22 --silent
  nvm alias default 22 2>/dev/null || true
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
      (
        tmpdir="$(mktemp -d)"
        trap 'rm -rf "$tmpdir"' EXIT
        curl -fsSL https://ollama.com/install.sh -o "$tmpdir/install_ollama.sh"
        verify_downloaded_script "$tmpdir/install_ollama.sh" "Ollama"
        sh "$tmpdir/install_ollama.sh"
      )
      info "Ollama upgraded to $(get_ollama_version)"
    fi
  else
    # No ollama — only install if a GPU is present
    if detect_gpu; then
      info "GPU detected — installing Ollama…"
      (
        tmpdir="$(mktemp -d)"
        trap 'rm -rf "$tmpdir"' EXIT
        curl -fsSL https://ollama.com/install.sh -o "$tmpdir/install_ollama.sh"
        verify_downloaded_script "$tmpdir/install_ollama.sh" "Ollama"
        sh "$tmpdir/install_ollama.sh"
      )
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
# Fix npm permissions for global installs (Linux only).
# If the npm global prefix points to a system directory (e.g. /usr or
# /usr/local) the user likely lacks write permissions and npm link will fail
# with EACCES.  Redirect the prefix to ~/.npm-global so the install succeeds
# without sudo.
# ---------------------------------------------------------------------------
fix_npm_permissions() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 0
  fi

  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || true)"
  if [[ -z "$npm_prefix" ]]; then
    return 0
  fi

  if [[ -w "$npm_prefix" || -w "$npm_prefix/lib" ]]; then
    return 0
  fi

  info "npm global prefix '${npm_prefix}' is not writable — configuring user-local installs"
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"

  # shellcheck disable=SC2016
  local path_line='export PATH="$HOME/.npm-global/bin:$PATH"'
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$rc" ]] && ! grep -q ".npm-global" "$rc"; then
      printf '\n# Added by NemoClaw installer\n%s\n' "$path_line" >>"$rc"
    fi
  done

  export PATH="$HOME/.npm-global/bin:$PATH"
  ok "npm configured for user-local installs (~/.npm-global)"
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
  openclaw_version="$(resolve_openclaw_version "$install_dir")"

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

resolve_openclaw_version() {
  local install_dir="$1"
  local package_json dockerfile_base resolved_version

  package_json="${install_dir}/package.json"
  dockerfile_base="${install_dir}/Dockerfile.base"

  if [[ -f "$package_json" ]]; then
    resolved_version="$(
      node -e "const v = require('${package_json}').dependencies?.openclaw; if (v) console.log(v)" \
        2>/dev/null || true
    )"
    if [[ -n "$resolved_version" ]]; then
      printf '%s\n' "$resolved_version"
      return 0
    fi
  fi

  if [[ -f "$dockerfile_base" ]]; then
    awk '
      match($0, /openclaw@[0-9][0-9.]+/) {
        print substr($0, RSTART + 9, RLENGTH - 9)
        exit
      }
      match($0, /ARG[[:space:]]+OPENCLAW_VERSION[[:space:]]*=[[:space:]]*[0-9][0-9.]+/) {
        line = substr($0, RSTART, RLENGTH)
        sub(/^[^=]+=[[:space:]]*/, "", line)
        print line
        exit
      }
    ' "$dockerfile_base"
  fi
}

is_source_checkout() {
  local repo_root="$1"
  local package_json="${repo_root}/package.json"

  [[ -f "$package_json" ]] || return 1
  grep -q '"name"[[:space:]]*:[[:space:]]*"nemoclaw"' "$package_json" 2>/dev/null || return 1

  if [[ "${NEMOCLAW_BOOTSTRAP_PAYLOAD:-}" == "1" ]]; then
    return 1
  fi

  if [[ -n "${NEMOCLAW_REPO_ROOT:-}" || -d "${repo_root}/.git" ]]; then
    return 0
  fi

  return 1
}

install_nemoclaw() {
  command_exists git || error "git was not found on PATH."
  local repo_root package_json
  repo_root="$(resolve_repo_root)"
  package_json="${repo_root}/package.json"
  if is_source_checkout "$repo_root"; then
    info "NemoClaw package.json found in the selected source checkout — installing from source…"
    NEMOCLAW_SOURCE_ROOT="$repo_root"
    if [[ -z "${NEMOCLAW_AGENT:-}" || "${NEMOCLAW_AGENT}" == "openclaw" ]]; then
      spin "Preparing OpenClaw package" bash -c "$(declare -f info warn resolve_openclaw_version pre_extract_openclaw); pre_extract_openclaw \"\$1\"" _ "$NEMOCLAW_SOURCE_ROOT" \
        || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
    fi
    spin "Installing NemoClaw dependencies" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm install --ignore-scripts"
    spin "Building NemoClaw CLI modules" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm run --if-present build:cli"
    spin "Building NemoClaw plugin" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\"/nemoclaw && npm install --ignore-scripts && npm run build"
    spin "Linking NemoClaw CLI" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm link"
  else
    if [[ -f "$package_json" ]]; then
      info "Installer payload is not a persistent source checkout — installing from GitHub…"
    fi
    info "Installing NemoClaw from GitHub…"
    # Resolve the latest release tag so we never install raw main.
    local release_ref
    release_ref="$(resolve_release_tag)"
    info "Resolved install ref: ${release_ref}"
    # Clone first so we can pre-extract openclaw before npm install (GH-503).
    # npm install -g git+https://... does this internally but we can't hook
    # into its extraction pipeline, so we do it ourselves.
    local nemoclaw_src="${HOME}/.nemoclaw/source"
    rm -rf "$nemoclaw_src"
    mkdir -p "$(dirname "$nemoclaw_src")"
    NEMOCLAW_SOURCE_ROOT="$nemoclaw_src"
    spin "Cloning NemoClaw source" git clone --depth 1 --branch "$release_ref" https://github.com/NVIDIA/NemoClaw.git "$nemoclaw_src"
    # Fetch version tags into the shallow clone so `git describe --tags
    # --match "v*"` works at runtime (the shallow clone only has the
    # single ref we asked for).
    git -C "$nemoclaw_src" fetch --depth=1 origin 'refs/tags/v*:refs/tags/v*' 2>/dev/null || true
    # Also stamp .version as a fallback for environments where git is
    # unavailable or tags are pruned later.
    git -C "$nemoclaw_src" describe --tags --match 'v*' 2>/dev/null \
      | sed 's/^v//' >"$nemoclaw_src/.version" || true
    if [[ -z "${NEMOCLAW_AGENT:-}" || "${NEMOCLAW_AGENT}" == "openclaw" ]]; then
      spin "Preparing OpenClaw package" bash -c "$(declare -f info warn resolve_openclaw_version pre_extract_openclaw); pre_extract_openclaw \"\$1\"" _ "$nemoclaw_src" \
        || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
    fi
    spin "Installing NemoClaw dependencies" bash -c "cd \"$nemoclaw_src\" && npm install --ignore-scripts"
    spin "Building NemoClaw CLI modules" bash -c "cd \"$nemoclaw_src\" && npm run --if-present build:cli"
    spin "Building NemoClaw plugin" bash -c "cd \"$nemoclaw_src\"/nemoclaw && npm install --ignore-scripts && npm run build"
    spin "Linking NemoClaw CLI" bash -c "cd \"$nemoclaw_src\" && npm link"
  fi

  refresh_path
  ensure_nemoclaw_shim || true
}

# ---------------------------------------------------------------------------
# 4. Verify
# ---------------------------------------------------------------------------

# Verify that a nemoclaw binary is the real NemoClaw CLI and not the broken
# placeholder npm package (npmjs.org/nemoclaw 0.1.0 — 249 bytes, no build
# artifacts).  The real CLI prints "nemoclaw v<semver>" on --version.
# Mirrors the isOpenshellCLI() pattern from resolve-openshell.js (PR #970).
is_real_nemoclaw_cli() {
  local bin_path="${1:-nemoclaw}"
  local version_output
  version_output="$("$bin_path" --version 2>/dev/null)" || return 1
  # Real CLI outputs: "nemoclaw v0.1.0" (or any semver, with optional pre-release)
  [[ "$version_output" =~ ^nemoclaw[[:space:]]+v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
}

verify_nemoclaw() {
  if command_exists nemoclaw; then
    if is_real_nemoclaw_cli "$(command -v nemoclaw)"; then
      NEMOCLAW_READY_NOW=true
      ensure_nemoclaw_shim || true
      info "Verified: nemoclaw is available at $(command -v nemoclaw)"
      return 0
    else
      warn "Found nemoclaw at $(command -v nemoclaw) but it is not the real NemoClaw CLI."
      warn "This is likely the broken placeholder npm package."
      npm uninstall -g nemoclaw 2>/dev/null || true
    fi
  fi

  local npm_bin
  npm_bin="$(npm config get prefix 2>/dev/null)/bin" || true

  if [[ -n "$npm_bin" && -x "$npm_bin/nemoclaw" ]]; then
    if is_real_nemoclaw_cli "$npm_bin/nemoclaw"; then
      ensure_nemoclaw_shim || true
      if command_exists nemoclaw; then
        NEMOCLAW_READY_NOW=true
        info "Verified: nemoclaw is available at $(command -v nemoclaw)"
        return 0
      fi

      NEMOCLAW_RECOVERY_PROFILE="$(detect_shell_profile)"
      if [[ -x "$NEMOCLAW_SHIM_DIR/nemoclaw" ]]; then
        NEMOCLAW_RECOVERY_EXPORT_DIR="$NEMOCLAW_SHIM_DIR"
      else
        NEMOCLAW_RECOVERY_EXPORT_DIR="$npm_bin"
      fi
      warn "Found nemoclaw at $npm_bin/nemoclaw but this shell still cannot resolve it."
      warn "Onboarding will be skipped until PATH is updated."
      return 0
    else
      warn "Found nemoclaw at $npm_bin/nemoclaw but it is not the real NemoClaw CLI."
      npm uninstall -g nemoclaw 2>/dev/null || true
    fi
  fi

  warn "Could not locate the nemoclaw executable."
  warn "Try re-running:  curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"
  error "Installation failed: nemoclaw binary not found."
}

# ---------------------------------------------------------------------------
# 5. Onboard
# ---------------------------------------------------------------------------
run_installer_host_preflight() {
  local preflight_module="${NEMOCLAW_SOURCE_ROOT}/dist/lib/preflight.js"
  if ! command_exists node || [[ ! -f "$preflight_module" ]]; then
    return 0
  fi

  local output status
  if output="$(
    # shellcheck disable=SC2016
    node -e '
      const preflightPath = process.argv[1];
      try {
        const { assessHost, planHostRemediation } = require(preflightPath);
        const host = assessHost();
        const actions = planHostRemediation(host);
        const blockingActions = actions.filter((action) => action && action.blocking);
        const infoLines = [];
        const actionLines = [];
        if (host.runtime && host.runtime !== "unknown") {
          infoLines.push(`Detected container runtime: ${host.runtime}`);
        }
        if (host.notes && host.notes.includes("Running under WSL")) {
          infoLines.push("Running under WSL");
        }
        for (const action of actions) {
          actionLines.push(`- ${action.title}: ${action.reason}`);
          for (const command of action.commands || []) {
            actionLines.push(`  ${command}`);
          }
        }
        if (infoLines.length > 0) {
          process.stdout.write(`__INFO__\n${infoLines.join("\n")}\n`);
        }
        if (actionLines.length > 0) {
          process.stdout.write(`__ACTIONS__\n${actionLines.join("\n")}`);
        }
        process.exit(blockingActions.length > 0 ? 10 : 0);
      } catch {
        process.exit(0);
      }
    ' "$preflight_module"
  )"; then
    status=0
  else
    status=$?
  fi

  if [[ -n "$output" ]]; then
    local info_output="" action_output=""
    info_output="$(printf "%s\n" "$output" | awk 'BEGIN{mode=0} /^__INFO__$/ {mode=1; next} /^__ACTIONS__$/ {mode=0} mode {print}')"
    action_output="$(printf "%s\n" "$output" | awk 'BEGIN{mode=0} /^__ACTIONS__$/ {mode=1; next} mode {print}')"
    echo ""
    if [[ -n "$info_output" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] && printf "  %s\n" "$line"
      done <<<"$info_output"
    fi
    if [[ "$status" -eq 10 ]]; then
      warn "Host preflight found issues that will prevent onboarding right now."
      if [[ -n "$action_output" ]]; then
        while IFS= read -r line; do
          [[ -n "$line" ]] && printf "  %s\n" "$line"
        done <<<"$action_output"
      fi
    elif [[ -n "$action_output" ]]; then
      warn "Host preflight found warnings."
      while IFS= read -r line; do
        [[ -n "$line" ]] && printf "  %s\n" "$line"
      done <<<"$action_output"
    fi
  fi

  [[ "$status" -ne 10 ]]
}

run_onboard() {
  show_usage_notice
  info "Running nemoclaw onboard…"
  local -a onboard_cmd=(onboard)
  if command_exists node && [[ -f "${HOME}/.nemoclaw/onboard-session.json" ]]; then
    if node -e '
      const fs = require("fs");
      const file = process.argv[1];
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const resumable = data && data.resumable !== false;
        const status = data && data.status;
        process.exit(resumable && status && status !== "complete" ? 0 : 1);
      } catch {
        process.exit(1);
      }
    ' "${HOME}/.nemoclaw/onboard-session.json"; then
      info "Found an interrupted onboarding session — resuming it."
      onboard_cmd+=(--resume)
    fi
  fi
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    onboard_cmd+=(--non-interactive)
    if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
      onboard_cmd+=(--yes-i-accept-third-party-software)
    fi
    nemoclaw "${onboard_cmd[@]}"
  elif [ -t 0 ]; then
    nemoclaw "${onboard_cmd[@]}"
  elif exec 3</dev/tty; then
    info "Installer stdin is piped; attaching onboarding to /dev/tty…"
    local status=0
    nemoclaw "${onboard_cmd[@]}" <&3 || status=$?
    exec 3<&-
    return "$status"
  else
    error "Interactive onboarding requires a TTY. Re-run in a terminal or set NEMOCLAW_NON_INTERACTIVE=1 with --yes-i-accept-third-party-software."
  fi
}

# 6. Post-install message (printed last — after onboarding — so PATH hints stay visible)
# ---------------------------------------------------------------------------
post_install_message() {
  if [[ "$NEMOCLAW_READY_NOW" == true ]]; then
    return 0
  fi

  if [[ -z "$NEMOCLAW_RECOVERY_EXPORT_DIR" ]]; then
    return 0
  fi

  if [[ -z "$NEMOCLAW_RECOVERY_PROFILE" ]]; then
    NEMOCLAW_RECOVERY_PROFILE="$(detect_shell_profile)"
  fi

  echo ""
  echo "  ──────────────────────────────────────────────────"
  warn "Your current shell cannot resolve 'nemoclaw' yet."
  echo ""
  echo "  To use nemoclaw now, run:"
  echo ""
  echo "    export PATH=\"${NEMOCLAW_RECOVERY_EXPORT_DIR}:\$PATH\""
  echo "    source ${NEMOCLAW_RECOVERY_PROFILE}"
  echo ""
  echo "  Then run:"
  echo ""
  echo "    nemoclaw onboard"
  echo ""
  echo "  Or open a new terminal window after updating your shell profile."
  echo "  ──────────────────────────────────────────────────"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  # Parse flags
  NON_INTERACTIVE=""
  ACCEPT_THIRD_PARTY_SOFTWARE=""
  for arg in "$@"; do
    case "$arg" in
      --non-interactive) NON_INTERACTIVE=1 ;;
      --yes-i-accept-third-party-software) ACCEPT_THIRD_PARTY_SOFTWARE=1 ;;
      --version | -v)
        local version_suffix
        version_suffix="$(installer_version_for_display)"
        printf "nemoclaw-installer%s\n" "${version_suffix# }"
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
  ACCEPT_THIRD_PARTY_SOFTWARE="${ACCEPT_THIRD_PARTY_SOFTWARE:-${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}}"
  export NEMOCLAW_NON_INTERACTIVE="${NON_INTERACTIVE}"
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${ACCEPT_THIRD_PARTY_SOFTWARE}"

  _INSTALL_START=$SECONDS
  print_banner
  bash "${SCRIPT_DIR}/setup-jetson.sh"

  step 1 "Node.js"
  install_nodejs
  ensure_supported_runtime

  step 2 "NemoClaw CLI"
  # install_or_upgrade_ollama
  fix_npm_permissions
  install_nemoclaw
  verify_nemoclaw

  # Pre-upgrade safety: back up all sandbox state before onboarding (which may
  # upgrade OpenShell). If the upgrade destroys sandbox contents, the backups
  # in ~/.nemoclaw/rebuild-backups/ let the user recover via `nemoclaw <name> rebuild`.
  # Check the registry file directly to avoid shelling out to nemoclaw (which
  # may be a stub in test environments).
  local _reg_file="${HOME}/.nemoclaw/sandboxes.json"
  if [ -f "$_reg_file" ] && command_exists nemoclaw && command_exists openshell; then
    local _has_sandboxes
    _has_sandboxes="$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(len(d.get('sandboxes', {})))
except Exception:
    print(0)
" "$_reg_file" 2>/dev/null || echo 0)"
    if [ "$_has_sandboxes" -gt 0 ]; then
      info "Backing up $_has_sandboxes sandbox(es) before upgrade…"
      nemoclaw backup-all 2>&1 || warn "Pre-upgrade backup failed (non-fatal). Continuing."
    fi
  fi

  step 3 "Onboarding"
  if command_exists nemoclaw; then
    if [[ -f "${HOME}/.nemoclaw/sandboxes.json" ]] && node -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const count = Object.keys(data.sandboxes || {}).length;
        process.exit(count > 0 ? 0 : 1);
      } catch {
        process.exit(1);
      }
    ' "${HOME}/.nemoclaw/sandboxes.json"; then
      warn "Existing sandbox sessions detected. Onboarding may disrupt running agents."
      if [[ "${NEMOCLAW_SINGLE_SESSION:-}" == "1" ]]; then
        error "Aborting — NEMOCLAW_SINGLE_SESSION is set. Destroy existing sessions with 'nemoclaw <name> destroy' before reinstalling."
      fi
      warn "Consider destroying existing sessions with 'nemoclaw <name> destroy' first."
      warn "Set NEMOCLAW_SINGLE_SESSION=1 to abort the installer when sessions are active."
    fi
    if run_installer_host_preflight; then
      run_onboard
      ONBOARD_RAN=true
    else
      warn "Skipping onboarding until the host prerequisites above are fixed."
    fi
  else
    warn "Skipping onboarding — this shell still cannot resolve 'nemoclaw'."
  fi

  # Post-upgrade: check for stale sandboxes and offer to rebuild them.
  # See: https://github.com/NVIDIA/NemoClaw/issues/1904
  if [ "${_has_sandboxes:-0}" -gt 0 ] 2>/dev/null && command_exists nemoclaw; then
    info "Checking for sandboxes that need upgrading…"
    nemoclaw upgrade-sandboxes 2>&1 || warn "Sandbox upgrade check failed (non-fatal). Run 'nemoclaw upgrade-sandboxes' manually."
  fi

  print_done
  post_install_message
}

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]] || { [[ -z "${BASH_SOURCE[0]:-}" ]] && { [[ "$0" == "bash" ]] || [[ "$0" == "-bash" ]]; }; }; then
  main "$@"
fi
