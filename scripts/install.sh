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
# #4414: When re-launched as a staged copy via `curl | bash`, queue the
# staged tmpfile for removal on EXIT. NEMOCLAW_INSTALLER_STAGED carries
# the staged path forward so both the loop guard and cleanup use one var.
[[ "${NEMOCLAW_INSTALLER_STAGED:-}" == /tmp/nemoclaw-installer-* ]] \
  && _cleanup_files+=("${NEMOCLAW_INSTALLER_STAGED}")
_global_cleanup() {
  for pid in "${_cleanup_pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for f in "${_cleanup_files[@]:-}"; do
    rm -f "$f" 2>/dev/null || true
  done
}
trap _global_cleanup EXIT

_INSTALLER_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "${_INSTALLER_SOURCE}")" && pwd)"
_INSTALLER_SCRIPT_PATH="${SCRIPT_DIR}/$(basename "${_INSTALLER_SOURCE}")"

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
DEFAULT_INSTALL_REF="lkg"
INSTALL_TAG_EXAMPLE="vX.Y.Z"
TOTAL_STEPS=3

is_mutable_install_ref() {
  case "${1:-}" in
    latest | lkg | refs/tags/latest | refs/tags/lkg) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_installer_version() {
  local repo_root
  repo_root="$(resolve_repo_root)"
  if [[ -n "${NEMOCLAW_INSTALL_REF:-}" ]] && ! is_mutable_install_ref "${NEMOCLAW_INSTALL_REF}"; then
    printf "%s" "${NEMOCLAW_INSTALL_REF#v}"
    return
  fi
  # Prefer git tags (works in dev clones and CI)
  if command -v git &>/dev/null && [[ -e "${repo_root}/.git" ]]; then
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

agent_display_name() {
  case "${1:-}" in
    hermes) printf "Hermes" ;;
    langchain-deepagents-code) printf "LangChain Deep Agents Code" ;;
    openclaw | "") printf "OpenClaw" ;;
    *)
      local first rest
      first="$(printf "%.1s" "$1" | tr '[:lower:]' '[:upper:]')"
      rest="${1#?}"
      printf "%s%s" "$first" "$rest"
      ;;
  esac
}

canonical_agent_name() {
  local raw="${1:-}" normalized
  normalized="$(printf "%s" "$raw" | tr '[:upper:]_ ' '[:lower:]--' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
  case "$normalized" in
    nemoclaw | nemo-claw | openclaw)
      printf "openclaw"
      ;;
    nemohermes | nemo-hermes | hermes)
      printf "hermes"
      ;;
    nemo-deepagents | nemo-deepagent | nemodeepagents | nemodeepagent | dcode | deepagent | deepagents | deep-agent | deep-agents | deepagentcode | deepagentscode | deepagent-code | deepagents-code | deep-agent-code | deep-agents-code | langchain | langchain-code | langchaindeepagent | langchaindeepagents | langchain-deepagent | langchain-deepagents | langchaindeepagentcode | langchaindeepagentscode | langchain-deepagent-code | langchain-deepagents-code | langchain-deep-agent | langchain-deep-agents | langchain-deep-agent-code | langchain-deep-agents-code)
      printf "langchain-deepagents-code"
      ;;
    *)
      printf "%s" "$raw"
      ;;
  esac
}

# Resolve which Git ref to install from.
# Priority: NEMOCLAW_INSTALL_TAG env var > lkg tag.
resolve_release_tag() {
  if [[ -n "${NEMOCLAW_INSTALL_REF:-}" ]]; then
    printf "%s" "${NEMOCLAW_INSTALL_REF}"
    return
  fi
  # Allow explicit override (for CI, pinning, or testing).
  # Otherwise default to the "lkg" tag, which we maintain to point at
  # the last-known-good commit we want everybody to install.
  printf "%s" "${NEMOCLAW_INSTALL_TAG:-$DEFAULT_INSTALL_REF}"
}

clone_nemoclaw_ref() {
  local ref="$1" dest="$2"

  git init --quiet "$dest"
  git -C "$dest" remote add origin https://github.com/NVIDIA/NemoClaw.git
  if ! git -C "$dest" fetch --quiet --depth 1 origin "$ref"; then
    error "Requested install ref '$ref' is not available from https://github.com/NVIDIA/NemoClaw.git. Check NEMOCLAW_INSTALL_TAG/NEMOCLAW_INSTALL_REF and try again."
  fi
  git -C "$dest" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
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

resolve_nemoclaw_gateway_port() {
  local port="${NEMOCLAW_GATEWAY_PORT:-8080}"
  port="${port#"${port%%[![:space:]]*}"}"
  port="${port%"${port##*[![:space:]]}"}"
  if [[ ! "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
    error "NEMOCLAW_GATEWAY_PORT must be an integer between 1024 and 65535."
  fi
  if [ "$port" -ge 18789 ] && [ "$port" -le 18799 ]; then
    error "NEMOCLAW_GATEWAY_PORT must not overlap the 18789-18799 dashboard port range."
  fi
  case "$port" in
    8000 | 11434 | 11435 | 11436 | 11437)
      error "NEMOCLAW_GATEWAY_PORT must not overlap a reserved inference or runtime-adapter port ($port)."
      ;;
  esac
  local -a configured_names=(
    NEMOCLAW_DASHBOARD_PORT
    NEMOCLAW_VLLM_PORT
    NEMOCLAW_OLLAMA_PORT
    NEMOCLAW_OLLAMA_PROXY_PORT
    NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT
    NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT
  )
  local -a configured_ports=(
    "${NEMOCLAW_DASHBOARD_PORT:-18789}"
    "${NEMOCLAW_VLLM_PORT:-8000}"
    "${NEMOCLAW_OLLAMA_PORT:-11434}"
    "${NEMOCLAW_OLLAMA_PROXY_PORT:-11435}"
    "${NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT:-11436}"
    "${NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT:-11437}"
  )
  local i configured_port
  for i in "${!configured_ports[@]}"; do
    configured_port="${configured_ports[$i]}"
    configured_port="${configured_port#"${configured_port%%[![:space:]]*}"}"
    configured_port="${configured_port%"${configured_port##*[![:space:]]}"}"
    if [[ "$configured_port" =~ ^[0-9]+$ ]] && [ "$port" -eq "$configured_port" ]; then
      error "NEMOCLAW_GATEWAY_PORT conflicts with ${configured_names[$i]} ($configured_port)."
    fi
  done
  printf "%s" "$port"
}

nemoclaw_state_dir() {
  local port
  port="$(resolve_nemoclaw_gateway_port)" || return 1
  if [ "$port" -eq 8080 ]; then
    printf "%s/.nemoclaw" "$HOME"
  else
    printf "%s/.nemoclaw/gateways/%s" "$HOME" "$port"
  fi
}

assert_nemoclaw_state_path_safe() {
  local target="$1" root="${HOME}/.nemoclaw" current relative component
  case "$target" in
    "$root" | "$root"/*) ;;
    *) error "Refusing NemoClaw state path outside ${root}: ${target}" ;;
  esac

  current="$root"
  if [ -L "$current" ]; then
    error "Refusing symbolic link in NemoClaw state path: ${current}"
  fi
  relative="${target#"$root"}"
  relative="${relative#/}"
  while [ -n "$relative" ]; do
    component="${relative%%/*}"
    current="${current}/${component}"
    if [ -L "$current" ]; then
      error "Refusing symbolic link in NemoClaw state path: ${current}"
    fi
    if [ "$relative" = "$component" ]; then break; fi
    relative="${relative#*/}"
  done
}

ensure_nemoclaw_state_dir() {
  local state_dir root gateways_dir
  state_dir="$(nemoclaw_state_dir)" || return 1
  root="${HOME}/.nemoclaw"
  gateways_dir="${root}/gateways"
  assert_nemoclaw_state_path_safe "$state_dir"
  (umask 077 && mkdir -p "$state_dir") || error "Could not create NemoClaw state directory: ${state_dir}"
  assert_nemoclaw_state_path_safe "$state_dir"
  chmod 700 "$root" || error "Could not secure NemoClaw state directory: ${root}"
  if [ "$state_dir" != "$root" ]; then
    chmod 700 "$gateways_dir" "$state_dir" \
      || error "Could not secure gateway-scoped NemoClaw state directory: ${state_dir}"
  fi
  printf "%s" "$state_dir"
}

nemoclaw_gateway_name() {
  local port
  port="$(resolve_nemoclaw_gateway_port)" || return 1
  if [ "$port" -eq 8080 ]; then
    printf "nemoclaw"
  else
    printf "nemoclaw-%s" "$port"
  fi
}

# Common TTY-required error message for the third-party software notice.
# Used by both show_usage_notice() and preflight_usage_notice_prompt() so
# the recovery hint stays in sync (#3058).
tty_required_error_message() {
  cat <<'EOF'
Interactive third-party software acceptance requires a TTY.

  Three ways to proceed (#3058):
    1. Re-run in a terminal:
         bash <(curl -fsSL https://www.nvidia.com/nemoclaw.sh)

    2. Accept upfront in the curl|bash pipe:
         curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash

    3. Pass the flag through to the installer:
         curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --yes-i-accept-third-party-software

  See docs/reference/commands.mdx for the full non-interactive install reference.
EOF
}

verify_downloaded_script() {
  local file="$1" label="${2:-script}" expected_hash="${3:-}"
  if [ ! -s "$file" ]; then
    error "$label download is empty or missing"
  fi
  if ! head -1 "$file" | grep -qE '^#!.*(sh|bash)'; then
    error "$label does not start with a shell shebang — possible download corruption"
  fi
  local actual_hash=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$file" | awk '{print $1}')"
  fi
  if [ -n "$expected_hash" ]; then
    if [ -z "$actual_hash" ]; then
      error "No SHA-256 tool available — cannot verify $label integrity"
    fi
    if [ "$actual_hash" != "$expected_hash" ]; then
      rm -f "$file"
      error "$label integrity check failed\n  Expected: $expected_hash\n  Actual:   $actual_hash"
    fi
    info "$label integrity verified (SHA-256: ${actual_hash:0:16}…)"
  elif [ -n "$actual_hash" ]; then
    info "$label SHA-256: $actual_hash"
  fi
}

resolve_default_sandbox_name() {
  local state_dir registry_file
  state_dir="$(nemoclaw_state_dir)"
  registry_file="${state_dir}/sandboxes.json"
  local sandbox_name=""

  # Prefer the sandbox name from the current onboard session — it reflects
  # the sandbox just created, whereas sandboxes.json may hold a stale default
  # from a previous gateway that no longer exists (#1839).
  local session_file="${state_dir}/onboard-session.json"
  if [[ -f "$session_file" ]] && command_exists node; then
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
  if [[ -z "$sandbox_name" && -f "$session_file" ]]; then
    sandbox_name="$(
      sed -n 's/.*"sandboxName"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p' "$session_file" 2>/dev/null \
        | head -n 1
    )"
  fi

  if [[ -z "$sandbox_name" ]]; then
    sandbox_name="${NEMOCLAW_SANDBOX_NAME:-}"
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

  local fallback="my-assistant"
  case "${NEMOCLAW_AGENT:-}" in
    hermes)
      fallback="hermes"
      ;;
    langchain-deepagents-code)
      fallback="deepagents-code"
      ;;
  esac
  printf "%s" "${sandbox_name:-$fallback}"
}

resolve_onboarded_agent() {
  local session_file
  session_file="$(nemoclaw_state_dir)/onboard-session.json"
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

restore_onboard_forward_after_post_checks() {
  local sandbox_name agent_name agent_display port openshell_bin attempt selected_state_dir state_dir pid_file watcher_script watcher_pid
  sandbox_name="$(resolve_default_sandbox_name)"
  agent_name="$(resolve_onboarded_agent)"
  agent_display="$(agent_display_name "$agent_name")"

  case "$agent_name" in
    hermes) port=8642 ;;
    *) return 0 ;;
  esac

  if [[ -n "${NEMOCLAW_OPENSHELL_BIN:-}" && -x "$NEMOCLAW_OPENSHELL_BIN" ]]; then
    openshell_bin="$NEMOCLAW_OPENSHELL_BIN"
  elif command_exists openshell; then
    openshell_bin="$(command -v openshell)"
  else
    return 0
  fi

  selected_state_dir="$(ensure_nemoclaw_state_dir)" || return 1
  state_dir="${selected_state_dir}/state"
  assert_nemoclaw_state_path_safe "$state_dir"
  (umask 077 && mkdir -p "$state_dir") \
    || error "Could not create gateway-scoped runtime state directory: ${state_dir}"
  assert_nemoclaw_state_path_safe "$state_dir"
  chmod 700 "$state_dir" \
    || error "Could not secure gateway-scoped runtime state directory: ${state_dir}"
  pid_file="${state_dir}/${agent_name}-${sandbox_name}-${port}.forward.pid"
  if [[ -f "$pid_file" ]]; then
    local old_pid expected_watcher_script current_uid old_uid old_args
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    expected_watcher_script="${pid_file}.js"
    current_uid="$(id -u)"
    if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
      old_uid="$(ps -p "$old_pid" -o uid= 2>/dev/null | tr -d '[:space:]' || true)"
      old_args="$(ps -p "$old_pid" -o args= 2>/dev/null || true)"
      if [[ "$old_uid" == "$current_uid" && "$old_args" == *"$expected_watcher_script"* ]]; then
        kill "$old_pid" >/dev/null 2>&1 || true
      fi
    fi
    rm -f "$pid_file"
  fi

  stop_agent_forward_if_owned() {
    local forward_list owner status
    "$openshell_bin" forward stop "$port" "$sandbox_name" >/dev/null 2>&1 && return 0
    forward_list="$("$openshell_bin" forward list 2>/dev/null || true)"
    owner="$(awk -v sandbox="$sandbox_name" -v port="$port" '
      $1 == sandbox && $3 == port {
        print $1
        exit
      }
    ' <<<"$forward_list")"
    status="$(awk -v sandbox="$sandbox_name" -v port="$port" '
      $1 == sandbox && $3 == port {
        print tolower($5)
        exit
      }
    ' <<<"$forward_list")"
    if [[ "$owner" == "$sandbox_name" && ("$status" == "running" || "$status" == "active") ]]; then
      "$openshell_bin" forward stop "$port" "$sandbox_name" >/dev/null 2>&1 || true
    fi
  }

  for attempt in 1 2 3; do
    stop_agent_forward_if_owned
    if [ "$attempt" -gt 1 ]; then
      sleep 2
    fi
    "$openshell_bin" forward start --background "$port" "$sandbox_name" >/dev/null 2>&1 || true
    watcher_pid=""
    if [[ "${NEMOCLAW_SKIP_FORWARD_WATCHER:-}" != "1" ]] && command_exists node; then
      watcher_script="${pid_file}.js"
      cat >"$watcher_script" <<'NODE'
const { spawnSync } = require("child_process");
const [openshellBin, port, sandboxName] = process.argv.slice(2);
function run(args) {
  spawnSync(openshellBin, args, { stdio: "ignore" });
}
function healthy() {
  return spawnSync("curl", ["-sf", "--max-time", "3", `http://127.0.0.1:${port}/health`], {
    stdio: "ignore",
  }).status === 0;
}
function tick() {
  if (healthy()) return;
  run(["forward", "stop", port, sandboxName]);
  run(["forward", "start", "--background", port, sandboxName]);
}
tick();
setInterval(tick, 10_000);
NODE
      node -e '
        const { spawn } = require("child_process");
        const fs = require("fs");
        const [script, openshellBin, port, sandboxName, pidFile] = process.argv.slice(1);
        const child = spawn(process.execPath, [script, openshellBin, port, sandboxName], {
          detached: true,
          stdio: "ignore",
        });
        fs.writeFileSync(pidFile, String(child.pid) + "\n");
        child.unref();
      ' "$watcher_script" "$openshell_bin" "$port" "$sandbox_name" "$pid_file" \
        >/dev/null 2>&1 || true
    fi
    sleep 4
    if command_exists curl \
      && curl -sf --max-time 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    watcher_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if ! command_exists curl && [[ -n "$watcher_pid" ]] && kill -0 "$watcher_pid" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$watcher_pid" ]]; then
      kill "$watcher_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
  done

  warn "Could not restore ${agent_display} host forward on port ${port}."
  warn "Run: openshell forward start --background ${port} ${sandbox_name}"
  return 1
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
  if [[ "${NEMOCLAW_AGENT:-openclaw}" == "hermes" ]]; then
    printf "  ${C_GREEN}${C_BOLD} ███╗   ██╗███████╗███╗   ███╗ ██████╗ ██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ████╗  ██║██╔════╝████╗ ████║██╔═══██╗██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝${C_RESET}\n"
  else
    printf "  ${C_GREEN}${C_BOLD} ███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝${C_RESET}\n"
    printf "  ${C_GREEN}${C_BOLD} ╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝${C_RESET}\n"
  fi
  printf "\n"
  if [[ -n "${NEMOCLAW_AGENT:-}" && "${NEMOCLAW_AGENT}" != "openclaw" ]]; then
    printf "  ${C_DIM}Launch %s in an OpenShell sandbox.%s${C_RESET}\n" "$(agent_display_name "$NEMOCLAW_AGENT")" "$version_suffix"
  else
    printf "  ${C_DIM}Launch OpenClaw in an OpenShell sandbox.%s${C_RESET}\n" "$version_suffix"
  fi
  printf "\n"
}

print_cli_path_refresh_actions() {
  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"

  if [[ -z "$NEMOCLAW_RECOVERY_PROFILE" ]]; then
    NEMOCLAW_RECOVERY_PROFILE="$(detect_shell_profile)"
  fi

  if [[ -n "$NEMOCLAW_RECOVERY_PROFILE" ]]; then
    printf "  %s$%s source %s\n" "$C_GREEN" "$C_RESET" "$NEMOCLAW_RECOVERY_PROFILE"
  fi
  if [[ -n "$NEMOCLAW_RECOVERY_EXPORT_DIR" ]]; then
    case "$shell_name" in
      fish)
        printf "  %s$%s set -gx PATH \"%s\" \$PATH\n" "$C_GREEN" "$C_RESET" "$NEMOCLAW_RECOVERY_EXPORT_DIR"
        ;;
      tcsh | csh)
        printf "  %s$%s setenv PATH \"%s:\${PATH}\"\n" "$C_GREEN" "$C_RESET" "$NEMOCLAW_RECOVERY_EXPORT_DIR"
        ;;
      *)
        printf "  %s$%s export PATH=\"%s:\$PATH\"\n" "$C_GREEN" "$C_RESET" "$NEMOCLAW_RECOVERY_EXPORT_DIR"
        ;;
    esac
  fi
  printf "  ${C_DIM}Or open a new terminal after updating your shell profile.${C_RESET}\n"
}

# Surface the silent agent fallback. When a non-interactive install (a Brev
# launchable or other automated deploy) completes on the default OpenClaw
# runtime *because* NEMOCLAW_AGENT was never set, say so loudly. A launchable
# that meant to provision a different agent (for example Hermes) otherwise looks
# identical to an OpenClaw deploy and the mistake is only visible from the live
# page's RUNTIME field. (#5211)
warn_default_agent_fallback() {
  local resolved_agent="${1:-}"

  # Only meaningful once a sandbox was actually provisioned.
  [[ "${ONBOARD_RAN:-false}" == true ]] || return 0
  # An explicit NEMOCLAW_AGENT (even =openclaw) is an intentional choice — stay
  # quiet. The bug is the *unset* case falling back to openclaw.
  [[ -z "${NEMOCLAW_AGENT:-}" ]] || return 0
  # Only the default-to-openclaw outcome is worth flagging.
  [[ "$resolved_agent" == "openclaw" || -z "$resolved_agent" ]] || return 0
  # Interactive users who skipped NEMOCLAW_AGENT chose OpenClaw on purpose; the
  # silent fallback only traps automated launchable deploys.
  installer_non_interactive || return 0

  printf "\n"
  printf "  ${C_YELLOW}${C_BOLD}Note: deployed the default OpenClaw runtime (RUNTIME = OpenClaw).${C_RESET}\n"
  printf "  ${C_YELLOW}NEMOCLAW_AGENT was not set, so the installer defaulted to OpenClaw.${C_RESET}\n"
  printf "  ${C_DIM}If you intended a different agent (for example Hermes), the launchable${C_RESET}\n"
  printf "  ${C_DIM}or environment must export NEMOCLAW_AGENT before install, for example:${C_RESET}\n"
  printf "  %s\$%s curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=hermes bash\n" \
    "$C_GREEN" "$C_RESET"
}

print_done() {
  local elapsed=$((SECONDS - _INSTALL_START))
  local _needs_cli_refresh=false
  needs_shell_reload && _needs_cli_refresh=true

  # #5735: do not claim a clean install when the automatic upgrade of a
  # pre-existing sandbox failed (it may have been destroyed before its recreate
  # failed). Surface an explicit incomplete/recovery status instead.
  # #6520: same when recovery exited 0 but recorded sandboxes were not found
  # on their own recorded gateway — they were not recovered, so the install is
  # not clean either.
  if [[ "${_UPGRADE_SANDBOXES_FAILED:-false}" == true ]]; then
    warn "=== Installation completed with warnings ==="
  elif [[ "${_PREEXISTING_SANDBOX_ORPHANED:-false}" == true ]]; then
    warn "=== Installation completed with warnings ==="
  else
    info "=== Installation complete ==="
  fi
  printf "\n"
  printf "  ${C_GREEN}${C_BOLD}%s${C_RESET}  ${C_DIM}(%ss)${C_RESET}\n" "$_CLI_DISPLAY" "$elapsed"
  printf "\n"
  if [[ "${_PREEXISTING_SANDBOX_RECOVERY_RAN:-false}" == true ]]; then
    if [[ "${_PREEXISTING_SANDBOX_ORPHANED:-false}" == true ]]; then
      # #6520: recovery exited 0 but recorded sandboxes were not found on
      # their own recorded gateway; do not report them as recovered, and give
      # a concrete remediation path instead.
      printf "  ${C_YELLOW}Some recorded sandboxes were not found on their recorded gateway and were not recovered.${C_RESET}\n"
      printf "  ${C_YELLOW}Their gateway registration or Docker image may have been removed (see the recovery notes above).${C_RESET}\n"
      printf "  ${C_DIM}Clear a stranded sandbox with '%s <name> destroy', then rebuild it with '%s onboard'.${C_RESET}\n" "$_CLI_BIN" "$_CLI_BIN"
    else
      printf "  ${C_GREEN}Existing sandboxes were recovered and upgraded.${C_RESET}\n"
    fi
    if [[ "$_needs_cli_refresh" == true ]]; then
      printf "  ${C_YELLOW}%s installed, but this shell needs PATH refresh before '%s' will run.${C_RESET}\n" "$_CLI_DISPLAY" "$_CLI_BIN"
      printf "\n"
      printf "  ${C_GREEN}For this terminal:${C_RESET}\n"
      print_cli_path_refresh_actions
    fi
    if [[ "${_PREEXISTING_SANDBOX_ORPHANED:-false}" == true ]]; then
      printf "  ${C_DIM}Generic onboarding was skipped because recorded sandboxes exist.${C_RESET}\n"
    else
      printf "  ${C_DIM}No new sandbox onboarding was needed.${C_RESET}\n"
    fi
  elif [[ "$ONBOARD_RAN" == true ]]; then
    local agent_name
    agent_name="$(resolve_onboarded_agent)"
    if [[ "$_needs_cli_refresh" == true ]]; then
      printf "  ${C_YELLOW}%s installed, but this shell needs PATH refresh before '%s' will run.${C_RESET}\n" "$_CLI_DISPLAY" "$_CLI_BIN"
      printf "  ${C_DIM}Onboarding completed; refresh PATH before using the CLI from this terminal.${C_RESET}\n"
      printf "\n"
      printf "  ${C_GREEN}For this terminal:${C_RESET}\n"
      print_cli_path_refresh_actions
    else
      if [[ "$agent_name" == "openclaw" || -z "$agent_name" ]]; then
        printf "  ${C_GREEN}Your OpenClaw Sandbox is live.${C_RESET}\n"
      else
        printf "  ${C_GREEN}Your %s Sandbox is live.${C_RESET}\n" "$(agent_display_name "$agent_name")"
      fi
      printf "  ${C_DIM}Use the Start chatting section above for browser and terminal options.${C_RESET}\n"
    fi
    warn_default_agent_fallback "$agent_name"
  elif [[ "$NEMOCLAW_READY_NOW" == true ]]; then
    if [[ "$_needs_cli_refresh" == true ]]; then
      printf "  ${C_YELLOW}%s CLI is installed, but this shell needs PATH refresh before '%s' will run.${C_RESET}\n" "$_CLI_DISPLAY" "$_CLI_BIN"
    else
      printf "  ${C_GREEN}%s CLI is installed.${C_RESET}\n" "$_CLI_DISPLAY"
    fi
    printf "  ${C_YELLOW}${C_BOLD}Onboarding did not run.${C_RESET}\n"
    printf "\n"
    printf "  ${C_GREEN}${C_BOLD}To finish setup, run:${C_RESET}\n"
    if [[ "$_needs_cli_refresh" == true ]]; then
      print_cli_path_refresh_actions
    else
      printf "  %s$%s source %s\n" "$C_GREEN" "$C_RESET" "$(detect_shell_profile)"
    fi
    printf "  %s$%s %s onboard\n" "$C_GREEN" "$C_RESET" "$_CLI_BIN"
  else
    printf "  ${C_YELLOW}%s CLI is installed, but this shell cannot resolve '%s' yet.${C_RESET}\n" "$_CLI_DISPLAY" "$_CLI_BIN"
    printf "  ${C_YELLOW}${C_BOLD}Onboarding did not run.${C_RESET}\n"
    printf "\n"
    printf "  ${C_GREEN}${C_BOLD}To finish setup, run:${C_RESET}\n"
    print_cli_path_refresh_actions
    printf "  %s$%s %s onboard\n" "$C_GREEN" "$C_RESET" "$_CLI_BIN"
  fi
  if [[ "${_UPGRADE_SANDBOXES_FAILED:-false}" == true ]]; then
    printf "\n"
    printf "  ${C_YELLOW}${C_BOLD}Existing sandbox upgrade did not finish.${C_RESET}\n"
    printf "  ${C_YELLOW}One or more pre-existing sandboxes failed to upgrade. See the messages above for the affected sandbox name, any preserved backup path, and recovery steps (${C_BOLD}%s onboard --resume${C_RESET}${C_YELLOW} / ${C_BOLD}%s <name> rebuild${C_RESET}${C_YELLOW}).${C_RESET}\n" "$_CLI_BIN" "$_CLI_BIN"
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
  printf "  ${C_BOLD}%s Installer${C_RESET}${C_DIM}%s${C_RESET}\n\n" "$_CLI_DISPLAY" "$version_suffix"
  printf "  ${C_DIM}Usage:${C_RESET}\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash\n"
  printf "    curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- [options]\n\n"
  printf "  ${C_DIM}Options:${C_RESET}\n"
  printf "    --non-interactive    Skip prompts (uses env vars / defaults)\n"
  printf "    --yes-i-accept-third-party-software Accept the third-party software notice without prompting\n"
  printf "    --fresh              Discard any failed/interrupted onboarding session and start over\n"
  printf "    --station-deepseek   Use DeepSeek V4 Flash for DGX Station express install (interactive terminal required)\n"
  printf "    --version, -v        Print installer version and exit\n"
  printf "    --help, -h           Show this help message and exit\n\n"
  printf "  ${C_DIM}Environment:${C_RESET}\n"
  printf "    NVIDIA_INFERENCE_API_KEY                API key (skips credential prompt)\n"
  printf "    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 Same as --yes-i-accept-third-party-software\n"
  printf "    NEMOCLAW_NON_INTERACTIVE=1    Same as --non-interactive\n"
  printf "    NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt Allow sudo prompts during non-interactive onboarding\n"
  printf "    NEMOCLAW_FRESH=1              Same as --fresh\n"
  printf "    NEMOCLAW_NO_EXPRESS=1         Skip express install prompt on supported platforms\n"
  printf "    NEMOCLAW_SANDBOX_NAME         Sandbox name to create/use\n"
  printf "    NEMOCLAW_SINGLE_SESSION=1     Abort if active sandbox sessions exist\n"
  printf "    NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE=1\n"
  printf "                                  Allow automatic pre-0.0.37 OpenShell gateway upgrade\n"
  printf "    NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1\n"
  printf "                                  Continue after manually backing up and retiring old gateway\n"
  printf "    NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE\n"
  printf "                                  Exact JSON array of pre-fingerprint managed sandbox names\n"
  printf "    NEMOCLAW_RECREATE_SANDBOX=1   Recreate an existing sandbox\n"
  printf "    NEMOCLAW_INSTALL_TAG          Git ref to install (default: %s)\n" "$DEFAULT_INSTALL_REF"
  printf "                                  In curl pipes, set this on bash or export it first.\n"
  printf "                                  Example: curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=%s bash\n" "$INSTALL_TAG_EXAMPLE"
  printf "    NEMOCLAW_INSTALL_REF          Exact Git ref/SHA to install\n"
  printf "    NEMOCLAW_PROVIDER             build | openrouter | openai | anthropic | anthropicCompatible\n"
  printf "                                  | gemini | ollama | custom | nim-local | vllm | routed\n"
  printf "                                  | hermes-provider\n"
  printf "                                  (aliases: cloud -> build, nim -> nim-local)\n"
  printf "    NEMOCLAW_MODEL                Inference model to configure\n"
  printf "    NEMOCLAW_POLICY_MODE          suggested | custom | skip\n"
  printf "    NEMOCLAW_POLICY_PRESETS       Comma-separated policy presets\n"
  printf "    NEMOCLAW_WEB_SEARCH_PROVIDER  brave | tavily | none (Hermes supports tavily only)\n"
  printf "    BRAVE_API_KEY                 Enable Brave Search for OpenClaw when the provider is unset\n"
  printf "    TAVILY_API_KEY                Enable Tavily Search when no higher-precedence supported key is set\n"
  printf "                                  Web search keys stay behind OpenShell credential rewrite\n"
  printf "    NEMOCLAW_EXPERIMENTAL=1       Show experimental/local options\n"
  printf "    CHAT_UI_URL                   Chat UI URL to open after setup\n"
  printf "    Messaging credential env vars Auto-enable matching messaging policy support\n"
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
  # When --yes-i-accept-third-party-software (or NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1)
  # is set, treat the licence step as accepted regardless of --non-interactive — a
  # flag whose name is "yes-i-accept" must be sufficient on its own to clear the
  # notice, even in curl|bash mode where there is no TTY to fall back to. See #2670.
  if [ "${NON_INTERACTIVE:-}" = "1" ] || [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
    notice_cmd+=(--non-interactive)
    if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
      notice_cmd+=(--yes-i-accept-third-party-software)
    fi
    "${notice_cmd[@]}"
  elif [ -t 0 ]; then
    "${notice_cmd[@]}"
  elif { exec 3</dev/tty; } 2>/dev/null; then
    info "Installer stdin is piped; attaching the usage notice to /dev/tty…"
    local status=0
    "${notice_cmd[@]}" <&3 || status=$?
    exec 3<&-
    return "$status"
  else
    error "$(tty_required_error_message)"
  fi
}

usage_notice_config_path() {
  local repo_root source_root notice_json
  repo_root="$(resolve_repo_root)"
  source_root="${NEMOCLAW_SOURCE_ROOT:-$repo_root}"
  notice_json="${source_root}/bin/lib/usage-notice.json"
  if [[ ! -f "$notice_json" ]]; then
    notice_json="${repo_root}/bin/lib/usage-notice.json"
  fi
  printf "%s" "$notice_json"
}

json_string_field() {
  local file="$1" field="$2"
  sed -nE "s/^[[:space:]]*\"${field}\"[[:space:]]*:[[:space:]]*\"(.*)\"[,]?[[:space:]]*$/\\1/p" "$file" \
    | head -n 1 \
    | sed 's/\\"/"/g; s/\\\\/\\/g'
}

usage_notice_state_file() {
  local state_dir
  state_dir="$(nemoclaw_state_dir)" || return 1
  printf "%s/usage-notice.json" "$state_dir"
}

usage_notice_accepted_shell() {
  local version="$1" state_file saved_version
  state_file="$(usage_notice_state_file)" || return 1
  assert_nemoclaw_state_path_safe "$state_file"
  [[ -n "$version" && -f "$state_file" ]] || return 1
  saved_version="$(sed -nE 's/.*"acceptedVersion"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$state_file" | head -n 1)"
  [[ "$saved_version" == "$version" ]]
}

save_usage_notice_acceptance_shell() {
  local version="$1" state_file state_dir accepted_at temp_file
  state_file="$(usage_notice_state_file)" || return 1
  state_dir="$(ensure_nemoclaw_state_dir)" || return 1
  assert_nemoclaw_state_path_safe "$state_file"
  accepted_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  temp_file="$(mktemp "${state_file}.tmp.XXXXXX")" \
    || error "Could not create temporary usage-notice state under ${state_dir}."
  chmod 600 "$temp_file" || {
    rm -f "$temp_file"
    error "Could not secure temporary usage-notice state under ${state_dir}."
  }
  if ! printf '{\n  "acceptedVersion": "%s",\n  "acceptedAt": "%s"\n}\n' \
    "$version" "$accepted_at" >"$temp_file"; then
    rm -f "$temp_file"
    error "Could not write usage-notice state under ${state_dir}."
  fi
  assert_nemoclaw_state_path_safe "$state_file"
  if ! mv -f "$temp_file" "$state_file"; then
    rm -f "$temp_file"
    error "Could not publish usage-notice state under ${state_dir}."
  fi
  assert_nemoclaw_state_path_safe "$state_file"
}

print_usage_notice_body_shell() {
  local file="$1"
  awk '
    /"body"[[:space:]]*:/ { in_body = 1; next }
    in_body && /^[[:space:]]*]/ { exit }
    in_body {
      line = $0
      sub(/^[[:space:]]*"/, "", line)
      sub(/",[[:space:]]*$/, "", line)
      sub(/"[[:space:]]*$/, "", line)
      gsub(/\\"/, "\"", line)
      gsub(/\\\\/, "\\", line)
      printf "  %s\n", line
    }
  ' "$file"
}

show_usage_notice_shell() {
  local notice_json version title prompt notice_body answer answer_lc
  notice_json="$(usage_notice_config_path)"
  if [[ ! -f "$notice_json" ]]; then
    error "Third-party software notice configuration not found."
  fi

  version="$(json_string_field "$notice_json" "version")"
  title="$(json_string_field "$notice_json" "title")"
  prompt="$(json_string_field "$notice_json" "interactivePrompt")"
  if [[ -z "$version" ]]; then
    error "Third-party software notice version not found."
  fi
  notice_body="$(print_usage_notice_body_shell "$notice_json")"
  if [[ -z "$(printf "%s" "$notice_body" | tr -d '[:space:]')" ]]; then
    error "Third-party software notice body not found."
  fi

  if usage_notice_accepted_shell "$version"; then
    return 0
  fi

  printf "\n"
  printf "  %s\n" "${title:-Third-Party Software Notice - NemoClaw Installer}"
  printf "  ──────────────────────────────────────────────────\n"
  printf "%s\n" "$notice_body"
  printf "\n"
  printf "  %s" "${prompt:-Type 'yes' to accept the NemoClaw license and third-party software notice and continue [no]: }"
  if ! IFS= read -r answer; then
    printf "\n  Installation cancelled\n" >&2
    return 1
  fi
  answer_lc="$(printf "%s" "$answer" | tr '[:upper:]' '[:lower:]')"
  if [[ "$answer_lc" != "yes" ]]; then
    printf "  Installation cancelled\n" >&2
    return 1
  fi

  save_usage_notice_acceptance_shell "$version"
  return 0
}

preflight_usage_notice_prompt() {
  if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
    return 0
  fi

  local notice_json version
  notice_json="$(usage_notice_config_path)"
  if [[ -f "$notice_json" ]]; then
    version="$(json_string_field "$notice_json" "version")"
    if [[ -n "$version" ]] && usage_notice_accepted_shell "$version"; then
      return 0
    fi
  fi

  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    error "Non-interactive installation requires explicit third-party software acceptance. Re-run with --yes-i-accept-third-party-software or set NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1."
  fi

  if [ -t 0 ]; then
    show_usage_notice_shell
    return "$?"
  fi

  if { exec 3</dev/tty; } 2>/dev/null; then
    info "Installer stdin is piped; prompting for the third-party software notice on /dev/tty before install."
    local status=0
    show_usage_notice_shell <&3 || status=$?
    exec 3<&-
    return "$status"
  fi

  error "$(tty_required_error_message)"
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

MIN_NODE_VERSION="22.19.0"
MIN_NPM_MAJOR=10

# ── Agent branding — adapt user-visible names to the active agent ──
if [[ -n "${NEMOCLAW_AGENT:-}" ]]; then
  NEMOCLAW_AGENT="$(canonical_agent_name "$NEMOCLAW_AGENT")"
  export NEMOCLAW_AGENT
fi
case "${NEMOCLAW_AGENT:-openclaw}" in
  hermes)
    _CLI_DISPLAY="NemoHermes"
    _AGENT_PRODUCT="Hermes"
    _CLI_BIN="nemohermes"
    ;;
  langchain-deepagents-code)
    _CLI_DISPLAY="NemoDeepAgents"
    _AGENT_PRODUCT="LangChain Deep Agents Code"
    _CLI_BIN="nemo-deepagents"
    ;;
  *)
    _CLI_DISPLAY="NemoClaw"
    _AGENT_PRODUCT="OpenClaw"
    _CLI_BIN="nemoclaw"
    ;;
esac

RUNTIME_REQUIREMENT_MSG="${_CLI_DISPLAY} requires Node.js >=${MIN_NODE_VERSION} and npm >=${MIN_NPM_MAJOR}."
NEMOCLAW_SHIM_DIR="${HOME}/.local/bin"
NEMOCLAW_READY_NOW=false
NEMOCLAW_RECOVERY_PROFILE=""
NEMOCLAW_RECOVERY_EXPORT_DIR=""
NEMOCLAW_CURRENT_SHELL_NEEDS_PATH_REFRESH=false
NEMOCLAW_INSTALLER_INITIAL_PATH="${PATH:-}"
NEMOCLAW_SOURCE_ROOT="$(resolve_repo_root)"
ONBOARD_RAN=false
# Absolute path to the just-installed CLI binary. Populated by
# verify_nemoclaw whenever the binary is found on disk, even when the
# current shell's PATH does not yet resolve $_CLI_BIN. Lets the installer
# invoke the CLI directly so a stale PATH cache does not silently skip
# auto-onboarding (#3276).
_CLI_PATH=""
_PREEXISTING_SANDBOX_COUNT=0
_PREEXISTING_SANDBOX_RECOVERY_RAN=false
# #6520: set when the automatic recovery pass exited 0 but skipped recorded
# sandboxes it could not observe on the selected gateway (e.g. their gateway
# and Docker image were removed by a prior uninstall while sandboxes.json was
# preserved). The final summary must not claim those sandboxes were recovered.
_PREEXISTING_SANDBOX_ORPHANED=false
_LEGACY_MANAGED_RECOVERY_NAMES_JSON="[]"
# #5735: set when automatic recovery/upgrade of pre-existing sandboxes
# reported a failure. A failed/destructive rebuild must not be reported as a
# clean install, so print_done downgrades the final banner when this is true.
_UPGRADE_SANDBOXES_FAILED=false

# Compare two semver strings (major.minor.patch). Returns 0 if $1 >= $2.
# Rejects prerelease suffixes (e.g. "22.19.0-rc.1") to avoid arithmetic errors.
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

# Resolve the active npm global bin without letting a host nvm install
# override an already-working node/npm on PATH.
resolve_npm_bin() {
  if ! command -v npm >/dev/null 2>&1; then
    ensure_nvm_loaded
  fi

  command -v npm >/dev/null 2>&1 || return 1

  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || true)"
  [[ -n "$npm_prefix" ]] || return 1

  printf '%s/bin\n' "$npm_prefix"
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

path_contains_dir() {
  local path_list="${1:-}" dir="${2:-}"
  [[ -n "$path_list" && -n "$dir" ]] || return 1
  [[ ":$path_list:" == *":$dir:"* ]]
}

record_cli_resolution_state() {
  local resolved_cli="${1:-}" npm_bin="${2:-}" candidate_dir preferred_dir=""
  local -a candidate_dirs=()

  if [[ "$resolved_cli" == */* ]]; then
    candidate_dirs+=("$(dirname "$resolved_cli")")
  fi
  if [[ -x "$NEMOCLAW_SHIM_DIR/$_CLI_BIN" ]]; then
    candidate_dirs+=("$NEMOCLAW_SHIM_DIR")
  fi
  if [[ -n "$npm_bin" && -x "$npm_bin/$_CLI_BIN" ]]; then
    candidate_dirs+=("$npm_bin")
  fi

  for candidate_dir in "${candidate_dirs[@]}"; do
    if path_contains_dir "$NEMOCLAW_INSTALLER_INITIAL_PATH" "$candidate_dir"; then
      NEMOCLAW_CURRENT_SHELL_NEEDS_PATH_REFRESH=false
      return 0
    fi
  done

  if [[ -x "$NEMOCLAW_SHIM_DIR/$_CLI_BIN" ]]; then
    preferred_dir="$NEMOCLAW_SHIM_DIR"
  elif [[ "$resolved_cli" == */* ]]; then
    preferred_dir="$(dirname "$resolved_cli")"
  elif [[ -n "$npm_bin" && -x "$npm_bin/$_CLI_BIN" ]]; then
    preferred_dir="$npm_bin"
  fi

  if [[ -n "$preferred_dir" ]]; then
    NEMOCLAW_CURRENT_SHELL_NEEDS_PATH_REFRESH=true
    NEMOCLAW_RECOVERY_EXPORT_DIR="${NEMOCLAW_RECOVERY_EXPORT_DIR:-$preferred_dir}"
    NEMOCLAW_RECOVERY_PROFILE="${NEMOCLAW_RECOVERY_PROFILE:-$(detect_shell_profile)}"
  fi
}

# Check whether npm link can write to the active prefix targets.
npm_link_targets_writable() {
  local npm_prefix="$1"
  local npm_bin_dir npm_lib_dir

  [ -n "$npm_prefix" ] || return 1

  npm_bin_dir="$npm_prefix/bin"
  npm_lib_dir="$npm_prefix/lib/node_modules"

  if [ -d "$npm_bin_dir" ]; then
    [ -w "$npm_bin_dir" ] || return 1
  elif [ ! -w "$npm_prefix" ]; then
    return 1
  fi

  if [ -d "$npm_lib_dir" ]; then
    [ -w "$npm_lib_dir" ] || return 1
  elif [ -d "$npm_prefix/lib" ]; then
    [ -w "$npm_prefix/lib" ] || return 1
  elif [ ! -w "$npm_prefix" ]; then
    return 1
  fi

  return 0
}

# Refresh PATH so that npm global bin is discoverable.
# After nvm installs Node.js the global bin lives under the nvm prefix,
# which may not yet be on PATH in the current session.
refresh_path() {
  local npm_bin
  npm_bin="$(resolve_npm_bin)" || true
  if [[ -n "$npm_bin" && -d "$npm_bin" && ":$PATH:" != *":$npm_bin:"* ]]; then
    export PATH="$npm_bin:$PATH"
  fi

  if [[ -d "$NEMOCLAW_SHIM_DIR" && ":$PATH:" != *":$NEMOCLAW_SHIM_DIR:"* ]]; then
    export PATH="$NEMOCLAW_SHIM_DIR:$PATH"
  fi
}

prefer_user_local_openshell() {
  local local_bin="${XDG_BIN_HOME:-${HOME}/.local/bin}"
  local openshell_bin="${local_bin}/openshell"
  if [[ -x "$openshell_bin" ]]; then
    export NEMOCLAW_OPENSHELL_BIN="$openshell_bin"
    export PATH="$local_bin:$PATH"
  fi
}

# Run scripts/install-openshell.sh during install_nemoclaw when appropriate.
# - mode=force:      always invoke (GitHub-clone branch — fresh install path)
# - mode=if-missing: invoke only when openshell is absent from PATH
#                    (source-checkout branch — preserves developer autonomy
#                    over their own openshell version)
# Both modes defer when NEMOCLAW_DEFER_OPENSHELL_INSTALL=1 so the pre-upgrade
# backup flow can run before any version bump.
maybe_install_openshell_during_install() {
  local mode="${1:-force}"
  if truthy_env "${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}"; then
    info "Deferring OpenShell CLI installation until after pre-upgrade backup."
    return 0
  fi
  if [[ "$mode" == "if-missing" ]] && command_exists openshell; then
    return 0
  fi
  spin "Installing OpenShell CLI" bash "${NEMOCLAW_SOURCE_ROOT}/scripts/install-openshell.sh"
  prefer_user_local_openshell
}

ensure_cli_shim() {
  local cli_bin="${1:-$_CLI_BIN}"
  local npm_bin shim_path node_path node_dir cli_path expected_shim
  npm_bin="$(resolve_npm_bin)" || true
  shim_path="${NEMOCLAW_SHIM_DIR}/${cli_bin}"

  if [[ -z "$npm_bin" || ! -x "$npm_bin/$cli_bin" ]]; then
    return 1
  fi

  node_path="$(command -v node 2>/dev/null || true)"
  if [[ -z "$node_path" || ! -x "$node_path" ]]; then
    return 1
  fi

  cli_path="$npm_bin/$cli_bin"
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

  expected_shim="$(
    cat <<EOF
#!/usr/bin/env bash
export PATH="$node_dir:\$PATH"
exec "$cli_path" "\$@"
EOF
  )"

  if [[ -x "$shim_path" ]] && cmp -s "$shim_path" <(printf '%s\n' "$expected_shim"); then
    refresh_path
    ensure_local_bin_in_profile
    return 0
  fi

  mkdir -p "$NEMOCLAW_SHIM_DIR"
  printf '%s\n' "$expected_shim" >"$shim_path"
  chmod +x "$shim_path"
  refresh_path
  ensure_local_bin_in_profile
  info "Created user-local shim at $shim_path"
  return 0
}

ensure_nemoclaw_shim() {
  local cli_bin status=0
  ensure_cli_shim "$_CLI_BIN" || status=$?
  for cli_bin in nemoclaw nemohermes nemo-deepagents; do
    [[ "$cli_bin" == "$_CLI_BIN" ]] && continue
    ensure_cli_shim "$cli_bin" || true
  done
  return "$status"
}

# Detect whether the caller's shell needs a PATH refresh after install.
# install.sh can export PATH for its own subprocess, but that cannot mutate the
# terminal that launched it. If the resolved CLI directory was not present at
# installer start, make the final output say so explicitly.
needs_shell_reload() {
  [[ "$NEMOCLAW_CURRENT_SHELL_NEEDS_PATH_REFRESH" == true ]]
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

# Fail fast when a host dependency that scripts/install-openshell.sh relies on
# is missing, before any clone/build/download work. install-openshell.sh uses
# `strings` (binutils) to confirm the OpenShell CLI binary carries the
# credential-rewrite endpoints; without it the install ran for ~5 minutes
# (Node.js, clone, npm install, tsc build, OpenShell download + checksum)
# only to abort at the final verification step (#4415). Skip when the OpenShell
# install is deferred: that flag postpones all OpenShell work to a later phase
# where install-openshell.sh runs the same `strings` check itself.
ensure_openshell_build_deps() {
  if truthy_env "${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}"; then
    return 0
  fi
  command_exists strings || error "'strings' (from binutils) is required to install and verify OpenShell. Install it first (Debian/Ubuntu: sudo apt-get install -y binutils) and re-run the installer."
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
    warn "Node.js ${current_version}, npm major ${current_npm_major:-unknown} found but ${_CLI_DISPLAY} requires Node.js >=${MIN_NODE_VERSION} and npm >=${MIN_NPM_MAJOR} — upgrading via nvm…"
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
  local installed_version
  installed_version="$(node --version)"
  info "Node.js installed via nvm: ${installed_version} (default alias)"
  # Surface the shell-reload requirement right next to the install line so the
  # user isn't left thinking the new Node is already active in their terminal.
  # install.sh runs as a subprocess; the parent shell's PATH genuinely cannot
  # be mutated from here, so we print the truth and the exact command.
  # See issue #2178.
  warn "Your current shell may still resolve \`node\` to an older version until it's reloaded."
  printf "        Open a new terminal, or run this in your existing shell:\n"
  # shellcheck disable=SC2016  # intentional: user pastes this literally; their shell expands the vars
  printf '          source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22\n'
}

# ---------------------------------------------------------------------------
# 2. Ollama — handled entirely by `nemoclaw onboard` (binary install, model
# pulls, daemon binding). install.sh used to bootstrap Ollama here, but that
# duplicated onboard's own install-ollama branch and pulled a hardcoded
# nemotron model regardless of NEMOCLAW_MODEL. Removed in favour of letting
# onboard own the policy.
# ---------------------------------------------------------------------------
detect_gpu() {
  # Returns 0 if a GPU is detected. Used by the vLLM bootstrap below.
  if command_exists nvidia-smi; then
    nvidia-smi &>/dev/null && return 0
  fi
  return 1
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

  if [[ -n "${NEMOCLAW_REPO_ROOT:-}" || -e "${repo_root}/.git" ]]; then
    return 0
  fi

  return 1
}

install_nemoclaw() {
  command_exists git || error "git was not found on PATH."
  local repo_root package_json
  repo_root="$(resolve_repo_root)"
  package_json="${repo_root}/package.json"
  # Tell prepare not to run npm link — the installer handles linking explicitly.
  export NEMOCLAW_INSTALLING=1

  if is_source_checkout "$repo_root"; then
    info "${_CLI_DISPLAY} package.json found in the selected source checkout — installing from source…"
    NEMOCLAW_SOURCE_ROOT="$repo_root"
    if [[ -z "${NEMOCLAW_AGENT:-}" || "${NEMOCLAW_AGENT}" == "openclaw" ]]; then
      spin "Preparing OpenClaw package" bash -c "$(declare -f info warn resolve_openclaw_version pre_extract_openclaw); pre_extract_openclaw \"\$1\"" _ "$NEMOCLAW_SOURCE_ROOT" \
        || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
    fi
    spin "Installing ${_CLI_DISPLAY} dependencies" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm install --ignore-scripts"
    spin "Building ${_CLI_DISPLAY} CLI modules" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm run --if-present build:cli"
    spin "Building ${_CLI_DISPLAY} plugin" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\"/nemoclaw && npm ci --ignore-scripts && npm run build"
    spin "Linking ${_CLI_DISPLAY} CLI" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm link"

    # Bootstrap OpenShell when the source checkout is being used as a fresh
    # install entrypoint (e.g. `git clone … && bash install.sh`) and the host
    # has no openshell on PATH. Skipping here previously left the user at a
    # circular preflight error ("Run the NemoClaw installer or
    # scripts/install-openshell.sh") even though they were running the
    # installer. A developer who already has a managed openshell on PATH
    # keeps their existing binary — install-openshell.sh is only invoked
    # when openshell is genuinely missing. See #3989.
    maybe_install_openshell_during_install if-missing
  else
    if [[ -f "$package_json" ]]; then
      info "Installer payload is not a persistent source checkout — installing from GitHub…"
    fi
    info "Installing ${_CLI_DISPLAY} from GitHub…"
    # Resolve the maintained install tag so we never install raw main.
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
    spin "Cloning ${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"
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
    spin "Installing ${_CLI_DISPLAY} dependencies" bash -c "cd \"$nemoclaw_src\" && npm install --ignore-scripts"
    spin "Building ${_CLI_DISPLAY} CLI modules" bash -c "cd \"$nemoclaw_src\" && npm run --if-present build:cli"
    spin "Building ${_CLI_DISPLAY} plugin" bash -c "cd \"$nemoclaw_src\"/nemoclaw && npm ci --ignore-scripts && npm run build"
    spin "Linking ${_CLI_DISPLAY} CLI" bash -c "cd \"$nemoclaw_src\" && npm link"

    # Install/upgrade the OpenShell CLI on the GitHub-clone path (curl|bash).
    # Without this, install.sh defers the openshell version gate entirely to
    # onboard, so any later skip of onboard (preflight blocking,
    # interrupted session) leaves openshell stale below blueprint's
    # min_openshell_version even though the new NemoClaw declared a higher
    # floor. The source-checkout branch invokes the same helper in
    # `if-missing` mode so developers keep autonomy when openshell is already
    # on PATH. The script is idempotent on the happy path. See #2272, #3989.
    maybe_install_openshell_during_install force
  fi

  refresh_path
  ensure_nemoclaw_shim || true
}

# ---------------------------------------------------------------------------
# 4. Verify
# ---------------------------------------------------------------------------

# Verify that a CLI binary is the real NemoClaw CLI and not the broken
# placeholder npm package (npmjs.org/nemoclaw 0.1.0 — 249 bytes, no build
# artifacts).  The real CLI prints "<binary> v<semver>" on --version.
# Mirrors the isOpenshellCLI() pattern from resolve-openshell.js (PR #970).
is_real_nemoclaw_cli() {
  local bin_path="${1:-nemoclaw}"
  local expected_name="${2:-$_CLI_BIN}"
  local version_output
  version_output="$("$bin_path" --version 2>/dev/null)" || return 1
  # Real CLI outputs: "nemoclaw v0.1.0", "nemohermes v0.1.0", or
  # "nemo-deepagents v0.1.0" (or any semver, with optional pre-release/build metadata).
  [[ "$version_output" =~ ^${expected_name}[[:space:]]+v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$ ]]
}

verify_nemoclaw() {
  if command_exists "$_CLI_BIN"; then
    local resolved_cli npm_bin
    resolved_cli="$(command -v "$_CLI_BIN")"
    if is_real_nemoclaw_cli "$resolved_cli" "$_CLI_BIN"; then
      NEMOCLAW_READY_NOW=true
      _CLI_PATH="$resolved_cli"
      npm_bin="$(resolve_npm_bin)" || true
      ensure_nemoclaw_shim || true
      record_cli_resolution_state "$resolved_cli" "$npm_bin"
      info "Verified: ${_CLI_BIN} is available at $resolved_cli"
      return 0
    else
      warn "Found ${_CLI_BIN} at $(command -v "$_CLI_BIN") but it is not the real ${_CLI_DISPLAY} CLI."
      warn "This is likely the broken placeholder npm package."
      npm uninstall -g nemoclaw 2>/dev/null || true
    fi
  fi

  local npm_bin
  npm_bin="$(resolve_npm_bin)" || true

  if [[ -n "$npm_bin" && -x "$npm_bin/$_CLI_BIN" ]]; then
    if is_real_nemoclaw_cli "$npm_bin/$_CLI_BIN" "$_CLI_BIN"; then
      ensure_nemoclaw_shim || true
      if command_exists "$_CLI_BIN"; then
        local resolved_cli
        resolved_cli="$(command -v "$_CLI_BIN")"
        NEMOCLAW_READY_NOW=true
        _CLI_PATH="$resolved_cli"
        record_cli_resolution_state "$resolved_cli" "$npm_bin"
        info "Verified: ${_CLI_BIN} is available at $resolved_cli"
        return 0
      fi

      # PATH still can't resolve $_CLI_BIN even after shim creation. Record
      # the absolute path so the rest of the installer can invoke the CLI
      # directly — auto-onboarding must not silently skip just because the
      # current shell's PATH cache is stale. The user-facing PATH-refresh
      # hint is still emitted so future shells pick the binary up by name
      # (#3276).
      #
      # Deliberately leave NEMOCLAW_READY_NOW=false here: that flag means
      # "the calling shell can resolve $_CLI_BIN by name", which is exactly
      # what's not true on this branch. print_done() routes through ONBOARD_RAN
      # + _needs_cli_refresh to render the "refresh PATH before using the CLI"
      # message; flipping READY_NOW=true would short-circuit that and falsely
      # advertise the CLI as immediately runnable by name.
      _CLI_PATH="$npm_bin/$_CLI_BIN"
      NEMOCLAW_CURRENT_SHELL_NEEDS_PATH_REFRESH=true
      NEMOCLAW_RECOVERY_PROFILE="$(detect_shell_profile)"
      if [[ -x "$NEMOCLAW_SHIM_DIR/$_CLI_BIN" ]]; then
        NEMOCLAW_RECOVERY_EXPORT_DIR="$NEMOCLAW_SHIM_DIR"
      else
        NEMOCLAW_RECOVERY_EXPORT_DIR="$npm_bin"
      fi
      warn "Found ${_CLI_BIN} at $_CLI_PATH but this shell's PATH does not yet resolve it."
      warn "Running onboarding via the absolute path; refresh your shell PATH afterwards (commands below)."
      return 0
    else
      warn "Found ${_CLI_BIN} at $npm_bin/$_CLI_BIN but it is not the real ${_CLI_DISPLAY} CLI."
      npm uninstall -g nemoclaw 2>/dev/null || true
    fi
  fi

  # Single warn header, then plain printf for each bullet. warn() prefixes
  # every line with "[warn]" + colour codes, which would render the bulleted
  # diagnostic table as six separate warnings rather than one structured block.
  warn "Could not locate the ${_CLI_BIN} executable after install. Searched:"
  if command_exists "$_CLI_BIN"; then
    printf '    - PATH lookup (command -v %s):  %s  (rejected — not the real CLI)\n' \
      "$_CLI_BIN" "$(command -v "$_CLI_BIN")"
  else
    printf '    - PATH lookup (command -v %s):  not found\n' "$_CLI_BIN"
  fi
  if [[ -n "$npm_bin" ]]; then
    printf '    - npm prefix bin:    %s/%s\n' "$npm_bin" "$_CLI_BIN"
  else
    printf '    - npm prefix bin:    (npm not configured)\n'
  fi
  printf '    - User shim dir:     %s/%s\n' "$NEMOCLAW_SHIM_DIR" "$_CLI_BIN"
  printf '    Active PATH: %s\n' "${PATH:-(empty)}"
  warn "Try re-running:  curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"
  error "Installation failed: ${_CLI_BIN} binary not found."
}

inspect_sandbox_registry_for_upgrade() {
  local reg_file="$1" field="$2" scope="${3:-legacy}" gateway_port
  gateway_port="$(resolve_nemoclaw_gateway_port)"
  node - "$reg_file" "$field" "$gateway_port" "$scope" <<'NODE'
const fs = require("node:fs");

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

let registry;
try {
  registry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch {
  process.exit(1);
}
if (!isObjectRecord(registry) || !isObjectRecord(registry.sandboxes)) process.exit(1);

const allEntries = Object.entries(registry.sandboxes);
if (allEntries.some(([name, entry]) => !name.trim() || !isObjectRecord(entry) || entry.name !== name)) {
  process.exit(1);
}
const selectedPort = Number(process.argv[4]);
const canonicalName = (port) => port === 8080 ? "nemoclaw" : `nemoclaw-${port}`;
const portFromName = (name) => {
  if (name === "nemoclaw") return 8080;
  const match = /^nemoclaw-([0-9]+)$/.exec(name);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 && canonicalName(port) === name
    ? port
    : null;
};
const entryPort = (entry) => {
  const hasPort = entry.gatewayPort !== undefined && entry.gatewayPort !== null;
  const hasName = entry.gatewayName !== undefined && entry.gatewayName !== null;
  if (hasPort && (!Number.isInteger(entry.gatewayPort) || entry.gatewayPort < 1 || entry.gatewayPort > 65535)) {
    throw new Error("invalid gatewayPort");
  }
  if (hasName && typeof entry.gatewayName !== "string") throw new Error("invalid gatewayName");
  const namedPort = hasName ? portFromName(entry.gatewayName) : null;
  if (hasName && namedPort === null) throw new Error("invalid gatewayName");
  if (hasPort && hasName && canonicalName(entry.gatewayPort) !== entry.gatewayName) {
    throw new Error("conflicting gateway identity");
  }
  return hasPort ? entry.gatewayPort : namedPort ?? 8080;
};

let entries;
try {
  entries = allEntries.filter(([, entry]) => entryPort(entry) === selectedPort);
} catch {
  process.exit(1);
}
if (process.argv[5] === "selected" && entries.length !== allEntries.length) process.exit(1);
// Keep this raw-registry predicate in sync with isRouteOnlySandboxReservation()
// in src/lib/state/registry.ts.
const sandboxes = entries.filter(
  ([, entry]) => !(entry.pendingRouteReservation === true && entry.createdAt === undefined),
);

if (process.argv[3] === "count") {
  process.stdout.write(String(sandboxes.length));
  process.exit(0);
}
if (process.argv[3] !== "ambiguous-names") process.exit(1);

const ambiguous = sandboxes
  .filter(([, entry]) => {
    const version = entry.nemoclawVersion;
    const hasFingerprint = typeof version === "string" && version.trim().length > 0;
    const hasNoCustomImageEvidence =
      entry.fromDockerfile === undefined || entry.fromDockerfile === null;
    return !hasFingerprint && hasNoCustomImageEvidence;
  })
  .map(([name]) => name)
  .sort();
process.stdout.write(JSON.stringify(ambiguous));
NODE
}

registered_sandbox_count() {
  local reg_file scope="selected"
  reg_file="$(nemoclaw_state_dir)/sandboxes.json"
  if [ "$(resolve_nemoclaw_gateway_port)" -eq 8080 ]; then scope="legacy"; fi
  if [ ! -f "$reg_file" ] && [ "$(resolve_nemoclaw_gateway_port)" -ne 8080 ]; then
    # Pre-segregation releases stored every gateway's rows in the shared file.
    reg_file="${HOME}/.nemoclaw/sandboxes.json"
    scope="legacy"
  fi
  if [ ! -f "$reg_file" ]; then
    printf "0"
    return
  fi
  inspect_sandbox_registry_for_upgrade "$reg_file" count "$scope"
}

resolve_existing_cli_runner() {
  local resolved_cli=""
  if command_exists "$_CLI_BIN"; then
    resolved_cli="$(command -v "$_CLI_BIN")"
    if is_real_nemoclaw_cli "$resolved_cli" "$_CLI_BIN"; then
      printf "%s" "$resolved_cli"
      return 0
    fi
  fi

  local npm_bin
  npm_bin="$(resolve_npm_bin)" || true
  if [[ -n "$npm_bin" && -x "$npm_bin/$_CLI_BIN" ]]; then
    if is_real_nemoclaw_cli "$npm_bin/$_CLI_BIN" "$_CLI_BIN"; then
      printf "%s" "$npm_bin/$_CLI_BIN"
      return 0
    fi
  fi

  return 1
}

prepare_current_cli_for_preupgrade_backup() {
  local old_defer="${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-__unset__}"
  info "Preparing current ${_CLI_DISPLAY} CLI for pre-upgrade backup…"
  export NEMOCLAW_DEFER_OPENSHELL_INSTALL=1
  install_nemoclaw
  if [[ "$old_defer" == "__unset__" ]]; then
    unset NEMOCLAW_DEFER_OPENSHELL_INSTALL
  else
    export NEMOCLAW_DEFER_OPENSHELL_INSTALL="$old_defer"
  fi
  verify_nemoclaw
}

resolve_prepared_cli_runner() {
  if [[ -n "${_CLI_PATH:-}" && -x "$_CLI_PATH" ]] && is_real_nemoclaw_cli "$_CLI_PATH" "$_CLI_BIN"; then
    printf "%s" "$_CLI_PATH"
    return 0
  fi
  resolve_existing_cli_runner
}

run_preupgrade_backup() {
  if ! prepare_current_cli_for_preupgrade_backup; then
    warn "Could not prepare the current ${_CLI_DISPLAY} CLI for pre-upgrade backup."
    return 1
  fi

  local current_cli_runner=""
  if ! current_cli_runner="$(resolve_prepared_cli_runner)"; then
    warn "Could not locate the current ${_CLI_BIN} CLI for pre-upgrade backup."
    return 1
  fi

  NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1 "$current_cli_runner" backup-all 2>&1
}

installed_openshell_version() {
  command_exists openshell || return 1
  openshell --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

truthy_env() {
  case "${1:-}" in
    1 | true | TRUE | yes | YES | y | Y) return 0 ;;
    *) return 1 ;;
  esac
}

legacy_openshell_gateway_upgrade_needed() {
  local version="$1"
  [[ -n "$version" ]] && ! version_gte "$version" "0.0.37"
}

installer_non_interactive() {
  [[ "${NON_INTERACTIVE:-}" == "1" || "${NEMOCLAW_NON_INTERACTIVE:-}" == "1" ]]
}

legacy_ambiguous_sandbox_names_json() {
  local reg_file="$1"
  local scope="legacy"
  if [ "$(resolve_nemoclaw_gateway_port)" -ne 8080 ] \
    && [ "$reg_file" = "$(nemoclaw_state_dir)/sandboxes.json" ]; then
    scope="selected"
  fi
  inspect_sandbox_registry_for_upgrade "$reg_file" ambiguous-names "$scope"
}

normalize_legacy_managed_confirmation_json() {
  node -e '
    let names;
    try {
      names = JSON.parse(process.argv[1]);
    } catch {
      process.exit(1);
    }
    if (
      !Array.isArray(names) ||
      names.some((name) => typeof name !== "string" || name.length === 0) ||
      new Set(names).size !== names.length
    ) {
      process.exit(1);
    }
    process.stdout.write(JSON.stringify([...names].sort()));
  ' "$1"
}

confirm_legacy_managed_image_recovery() {
  local reg_file="$1" ambiguous_json="" ambiguous_count="0"
  if ! ambiguous_json="$(legacy_ambiguous_sandbox_names_json "$reg_file")"; then
    error "Could not inspect legacy sandbox image provenance. Existing sandboxes were left unchanged."
  fi
  ambiguous_count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$ambiguous_json")"
  if [ "$ambiguous_count" -eq 0 ] 2>/dev/null; then
    _LEGACY_MANAGED_RECOVERY_NAMES_JSON="[]"
    return 0
  fi

  cat <<EOF

  ${ambiguous_count} existing sandbox(es) predate managed-image provenance tracking:
EOF
  while IFS= read -r sandbox_name; do
    [[ -n "$sandbox_name" ]] && printf "    %s\n" "$sandbox_name"
  done < <(node -e 'for (const name of JSON.parse(process.argv[1])) console.log(JSON.stringify(name))' "$ambiguous_json")
  cat <<EOF

  Continue only if every sandbox above was created with NemoClaw's standard
  managed image. Recovery will replace it with the current managed image. A
  custom --from image cannot be inferred from this legacy registry format.

EOF

  if [[ -n "${NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE:-}" ]]; then
    local confirmed_json=""
    if ! confirmed_json="$(normalize_legacy_managed_confirmation_json "$NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE")"; then
      error "NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE must be a JSON array containing the exact sandbox names listed above."
    fi
    if [[ "$confirmed_json" != "$ambiguous_json" ]]; then
      error "NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE must exactly match the listed sandbox names: ${ambiguous_json}"
    fi
    info "Confirmed ${ambiguous_count} exact pre-fingerprint sandbox name(s) used NemoClaw-managed images."
    _LEGACY_MANAGED_RECOVERY_NAMES_JSON="$ambiguous_json"
    return 0
  fi

  if installer_non_interactive; then
    error "Legacy sandbox recovery requires explicit confirmation. Set NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE='${ambiguous_json}' only after verifying those exact sandboxes used managed images."
  fi

  local answer=""
  if [ -t 0 ]; then
    printf "  Confirm these were managed-image sandboxes? [y/N]: "
    IFS= read -r answer || answer=""
  elif { exec 3</dev/tty; } 2>/dev/null; then
    info "Installer stdin is piped; prompting for legacy sandbox recovery on /dev/tty..."
    printf "  Confirm these were managed-image sandboxes? [y/N]: "
    IFS= read -r answer <&3 || answer=""
    exec 3<&-
  else
    error "Legacy sandbox recovery requires a TTY prompt or an exact JSON name array in NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE."
  fi

  answer="$(printf "%s" "$answer" | tr '[:upper:]' '[:lower:]')"
  case "$answer" in
    y | yes)
      _LEGACY_MANAGED_RECOVERY_NAMES_JSON="$ambiguous_json"
      info "Confirmed legacy managed-image recovery."
      ;;
    *)
      error "Aborting before backup or OpenShell changes. Existing gateway and sandboxes were left unchanged."
      ;;
  esac
}

print_openshell_upgrade_manual_commands() {
  local gateway_port gateway_name gateway_port_env=""
  gateway_port="$(resolve_nemoclaw_gateway_port)" || return 1
  gateway_name="$(nemoclaw_gateway_name)" || return 1
  if [ "$gateway_port" -ne 8080 ]; then
    gateway_port_env="NEMOCLAW_GATEWAY_PORT=${gateway_port} "
  fi
  cat <<EOF
  Manual upgrade path (after installing the current CLI with OpenShell deferred):
    ${gateway_port_env}NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1 ${_CLI_BIN} backup-all
    openshell gateway remove ${gateway_name} || openshell gateway destroy -g ${gateway_name}
    curl -fsSL https://www.nvidia.com/nemoclaw.sh | ${gateway_port_env}NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1 bash
    ${gateway_port_env}${_CLI_BIN} upgrade-sandboxes --check

  The prepared installer rerun lists pre-fingerprint sandboxes and asks you to
  confirm their managed-image provenance. For a non-interactive rerun, set
  NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE to the exact JSON array printed by
  the installer only after verifying every listed sandbox used a managed image.

  Use NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE=1 to allow the installer
  to run the backup, gateway retirement, and restore preparation automatically.
EOF
}

confirm_experimental_openshell_gateway_upgrade() {
  local sandbox_count="$1" old_openshell_version="$2"

  if truthy_env "${NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE:-}"; then
    info "Accepted experimental OpenShell gateway upgrade for ${sandbox_count} existing sandbox(es)."
    return 0
  fi

  cat <<EOF

  Existing NemoClaw sandbox state uses OpenShell ${old_openshell_version}.
  This release upgrades OpenShell to the current supported version, which uses a
  different gateway layout than pre-0.0.37 gateways.

  NemoClaw can run the new automatic upgrade path now:
    1. install the current CLI without replacing OpenShell
    2. back up every registered sandbox with the current state manifest
    3. retire the old OpenShell gateway
    4. install the current supported OpenShell
    5. recreate and restore the registered sandbox

  This upgrade path is new. Durable workspace and agent configuration state
  should be preserved, but running processes may be interrupted.

EOF
  print_openshell_upgrade_manual_commands
  printf "\n"

  if installer_non_interactive; then
    error "OpenShell gateway upgrade requires explicit opt-in. Set NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE=1 to continue automatically, or run the manual commands above."
  fi

  local answer=""
  if [ -t 0 ]; then
    printf "  Continue with automatic OpenShell gateway upgrade? [Y/n]: "
    IFS= read -r answer || answer=""
  elif { exec 3</dev/tty; } 2>/dev/null; then
    info "Installer stdin is piped; prompting for OpenShell gateway upgrade on /dev/tty..."
    printf "  Continue with automatic OpenShell gateway upgrade? [Y/n]: "
    IFS= read -r answer <&3 || answer=""
    exec 3<&-
  else
    error "OpenShell gateway upgrade requires a TTY prompt. Set NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE=1 to continue automatically, or run the manual commands above."
  fi

  answer="$(printf "%s" "$answer" | tr '[:upper:]' '[:lower:]')"
  case "$answer" in
    "" | y | yes)
      info "Accepted experimental OpenShell gateway upgrade."
      return 0
      ;;
    *)
      error "Aborting before OpenShell gateway upgrade. Existing gateway and sandboxes were left unchanged."
      ;;
  esac
}

preinstall_backup_and_retire_legacy_gateway() {
  local reg_file gateway_name
  reg_file="$(nemoclaw_state_dir)/sandboxes.json"
  if [ ! -f "$reg_file" ] && [ "$(resolve_nemoclaw_gateway_port)" -ne 8080 ]; then
    reg_file="${HOME}/.nemoclaw/sandboxes.json"
  fi
  [ -f "$reg_file" ] || return 0
  gateway_name="$(nemoclaw_gateway_name)"

  local sandbox_count
  if ! sandbox_count="$(registered_sandbox_count)"; then
    error "Could not inspect the existing sandbox registry. Existing gateway and sandboxes were left unchanged."
  fi
  _PREEXISTING_SANDBOX_COUNT="$sandbox_count"
  [ "$sandbox_count" -gt 0 ] 2>/dev/null || return 0
  if ! command_exists openshell; then
    # NemoClaw v0.0.55's OpenShell 0.0.44 layout could install this binary
    # without persisting ~/.local/bin on PATH. Retain this fallback while direct
    # v0.0.55 upgrades are supported; remove it only after support for that
    # source version and its regression fixture are retired together.
    prefer_user_local_openshell
  fi
  command_exists openshell || return 0

  if [[ "${NEMOCLAW_SINGLE_SESSION:-}" == "1" ]]; then
    error "Aborting — NEMOCLAW_SINGLE_SESSION is set. Destroy existing sessions with '${_CLI_BIN} <name> destroy' before reinstalling."
  fi

  local old_openshell_version=""
  old_openshell_version="$(installed_openshell_version || true)"
  if legacy_openshell_gateway_upgrade_needed "$old_openshell_version" && truthy_env "${NEMOCLAW_OPENSHELL_UPGRADE_PREPARED:-}"; then
    confirm_legacy_managed_image_recovery "$reg_file"
    info "Using manually prepared OpenShell gateway upgrade state."
    export NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE=1
    return 0
  fi

  if legacy_openshell_gateway_upgrade_needed "$old_openshell_version"; then
    if ! confirm_experimental_openshell_gateway_upgrade "$sandbox_count" "$old_openshell_version"; then
      return 0
    fi
  fi

  confirm_legacy_managed_image_recovery "$reg_file"
  info "Backing up ${sandbox_count} sandbox(es) before upgrading OpenShell…"
  if ! run_preupgrade_backup; then
    if legacy_openshell_gateway_upgrade_needed "$old_openshell_version"; then
      error "Pre-upgrade backup failed. Aborting before retiring the legacy OpenShell gateway."
    fi
    error "Pre-upgrade backup stopped the installer. Resolve every reported sandbox backup failure or skipped sandbox using the CLI output above, then rerun the installer."
  fi
  export NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE=1

  # Current OpenShell builds are not compatible with pre-0.0.37 gateway state,
  # and those CLIs no longer have lifecycle verbs for destroying that old gateway.
  # Retire the old gateway while the old CLI can still do it, after backup.
  if [[ -n "$old_openshell_version" ]] && ! version_gte "$old_openshell_version" "0.0.37"; then
    info "Retiring OpenShell ${old_openshell_version} gateway before installing current OpenShell…"
    if [ "$gateway_name" = "nemoclaw" ]; then
      openshell gateway destroy -g "$gateway_name" >/dev/null 2>&1 \
        || openshell gateway destroy >/dev/null 2>&1 \
        || warn "Could not destroy the legacy OpenShell gateway before upgrade; onboarding will clean up stale runtime state."
    else
      openshell gateway destroy -g "$gateway_name" >/dev/null 2>&1 \
        || warn "Could not destroy legacy gateway ${gateway_name} before upgrade; onboarding will clean up only that gateway's stale runtime state."
    fi
  fi
}

# ---------------------------------------------------------------------------
# 5. Onboard
# ---------------------------------------------------------------------------
repair_installer_stale_nvidia_cdi_spec() {
  local flagged_file="${1:-}"
  local service_spec_path="/var/run/cdi/nvidia.yaml"
  local sudo_cmd=()

  info "Refreshing NVIDIA CDI device spec with NVIDIA's CDI refresh service."
  info "NVIDIA GPU passthrough uses CDI specs so Docker/OpenShell can request nvidia.com/gpu devices."
  info "Docker is configured for CDI, but the effective nvidia.com/gpu spec may be stale."
  info "The refresh service regenerates ${service_spec_path}; re-assessment verifies that effective spec."
  if [[ -n "$flagged_file" && "$flagged_file" != "$service_spec_path" ]]; then
    info "The stale ${flagged_file} file is a leftover; the refreshed ${service_spec_path} overrides it."
  fi
  if ! command_exists systemctl; then
    warn "Could not refresh the stale NVIDIA CDI spec automatically because systemctl is unavailable."
    return 0
  fi
  if [[ "$(id -u)" -ne 0 ]]; then
    sudo_cmd=(sudo)
    info "You may be asked for your password to authorize these host-level admin changes."
    info "NemoClaw does not store your password."
    if ! sudo -v; then
      warn "Could not obtain sudo credentials for NVIDIA CDI refresh service repair."
      return 0
    fi
  fi
  if "${sudo_cmd[@]}" systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service >/dev/null 2>&1 \
    && "${sudo_cmd[@]}" systemctl start nvidia-cdi-refresh.service >/dev/null 2>&1; then
    ok "Enabled NVIDIA CDI refresh service and refreshed the service-managed NVIDIA CDI device spec."
    return 0
  fi
  warn "Could not refresh the stale NVIDIA CDI spec automatically with nvidia-cdi-refresh.service."
}

repair_installer_nvidia_cdi_spec() {
  local preflight_module="$1"
  local repair_plan=""
  local repair_kind=""
  local spec_path=""

  repair_plan="$(
    # shellcheck disable=SC2016
    node -e '
      const preflightPath = process.argv[1];
      try {
        const { assessHost, getNvidiaCdiSpecPath, isWslDockerDesktopRuntime } = require(preflightPath);
        const host = assessHost();
        if (
          host &&
          host.cdiNvidiaGpuSpecMissing &&
          !isWslDockerDesktopRuntime(host)
        ) {
          process.stdout.write(`missing\t${getNvidiaCdiSpecPath(host)}`);
        } else if (
          host &&
          host.cdiNvidiaGpuSpecStale &&
          host.cdiNvidiaGpuSpecNeedsRepair &&
          !host.cdiNvidiaGpuSpecMissing &&
          host.nvidiaContainerToolkitInstalled &&
          !isWslDockerDesktopRuntime(host)
        ) {
          const mismatch = String(host.cdiNvidiaGpuSpecMismatch || "");
          const flaggedFilePath = mismatch.trim().split(/\s+/, 1)[0] || "";
          process.stdout.write(`stale\t${flaggedFilePath}`);
        }
      } catch {
        process.exit(0);
      }
    ' "$preflight_module" 2>/dev/null || true
  )"

  if [[ -z "$repair_plan" ]]; then
    return 0
  fi

  repair_kind="${repair_plan%%$'\t'*}"
  spec_path="${repair_plan#*$'\t'}"

  if [[ "$repair_kind" == "stale" ]]; then
    repair_installer_stale_nvidia_cdi_spec "$spec_path"
    return 0
  fi

  if ! command_exists nvidia-ctk; then
    return 0
  fi

  local spec_dir="${spec_path%/*}"
  if [[ -z "$spec_dir" || "$spec_dir" == "$spec_path" ]]; then
    spec_dir="/etc/cdi"
    spec_path="${spec_dir}/nvidia.yaml"
  fi

  local sudo_cmd=()
  info "Refreshing NVIDIA CDI device spec at ${spec_path}."
  info "NVIDIA GPU passthrough uses CDI specs so Docker/OpenShell can request nvidia.com/gpu devices."
  info "Docker is configured for CDI, but the nvidia.com/gpu spec is missing or may be stale."
  info "Without a refreshed spec, OpenShell gateway startup can fail before the sandbox can use the GPU."
  info "NemoClaw will first enable NVIDIA's CDI refresh service."
  info "If that service does not generate the spec, NemoClaw will run nvidia-ctk cdi generate directly."
  if [[ "$(id -u)" -ne 0 ]]; then
    sudo_cmd=(sudo)
    info "You may be asked for your password to authorize these host-level admin changes."
    info "NemoClaw does not store your password."
    if ! sudo -v; then
      warn "Could not obtain sudo credentials for NVIDIA CDI device spec generation."
      return 0
    fi
  fi

  local cdi_list_output=""
  if command_exists systemctl; then
    info "Trying NVIDIA CDI refresh service (auto-generates GPU CDI specs)."
    if "${sudo_cmd[@]}" systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service >/dev/null 2>&1 \
      && cdi_list_output="$(nvidia-ctk cdi list 2>/dev/null)" \
      && grep -q 'nvidia\.com/gpu' <<<"$cdi_list_output"; then
      ok "Enabled NVIDIA CDI refresh service and generated NVIDIA CDI device spec."
      return 0
    fi
    warn "NVIDIA CDI refresh service did not produce nvidia.com/gpu; falling back to direct generation."
  fi

  local cdi_generate_output=""
  if "${sudo_cmd[@]}" mkdir -p "$spec_dir" && cdi_generate_output="$("${sudo_cmd[@]}" nvidia-ctk cdi generate --output="$spec_path" 2>&1)"; then
    if cdi_list_output="$(nvidia-ctk cdi list 2>/dev/null)"; then
      if grep -q 'nvidia\.com/gpu' <<<"$cdi_list_output"; then
        ok "Generated NVIDIA CDI device spec."
      else
        warn "Generated NVIDIA CDI device spec, but nvidia-ctk cdi list did not show nvidia.com/gpu."
      fi
    else
      ok "Generated NVIDIA CDI device spec."
      warn "Could not verify it with nvidia-ctk cdi list."
    fi
  else
    warn "Could not generate the NVIDIA CDI device spec automatically."
    if [[ -n "$cdi_generate_output" ]]; then
      warn "nvidia-ctk cdi generate output:"
      printf "%s\n" "$cdi_generate_output" | tail -40 | sed 's/^/  /'
    fi
  fi
}

run_installer_host_preflight() {
  local preflight_module="${NEMOCLAW_SOURCE_ROOT}/dist/lib/onboard/preflight.js"
  if ! command_exists node || [[ ! -f "$preflight_module" ]]; then
    return 0
  fi

  repair_installer_nvidia_cdi_spec "$preflight_module"

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

recover_preexisting_sandboxes_before_onboard() {
  local cli_runner="$1"
  if [ "${_PREEXISTING_SANDBOX_COUNT:-0}" -le 0 ] 2>/dev/null; then
    return 0
  fi

  info "Recovering and upgrading pre-existing sandboxes before onboarding…"
  # `--auto` is the existing non-interactive maintenance path. When the
  # pre-upgrade backup signal is present, the CLI also recovers registered
  # non-Ready sandboxes from their validated latest backup. It attempts every
  # eligible sandbox before returning non-zero for any failure.
  #
  # #6520: mirror the CLI output into a temp log (while still streaming it) so
  # the installer can tell "recovered" apart from "exited 0 but recorded
  # sandboxes are unrecoverable" — e.g. after `nemoclaw uninstall` removed the
  # gateway and Docker image a preserved sandboxes.json still references. The
  # CLI emits a dedicated orphan marker only for sandboxes absent from their
  # own recorded gateway (never for sandboxes bound to another live gateway or
  # ones that reconnect mid-run); keep the grep in sync with the "recorded
  # sandbox(es) were not found on their recorded gateway" line in
  # src/lib/actions/upgrade-sandboxes.ts.
  local recovery_log=""
  recovery_log="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-recovery-XXXXXX" 2>/dev/null)" || recovery_log=""
  local recovery_status=0
  if [ -n "$recovery_log" ]; then
    _cleanup_files+=("$recovery_log")
    if NEMOCLAW_CONFIRMED_LEGACY_MANAGED_SANDBOXES="${_LEGACY_MANAGED_RECOVERY_NAMES_JSON:-[]}" \
      "$cli_runner" upgrade-sandboxes --auto 2>&1 | tee "$recovery_log"; then
      recovery_status=0
    else
      # pipefail: take the CLI's own status, not tee's — a log-write failure
      # (e.g. ENOSPC on TMPDIR) must not convert a successful recovery into
      # the #5735 failure path.
      recovery_status=${PIPESTATUS[0]}
    fi
  else
    NEMOCLAW_CONFIRMED_LEGACY_MANAGED_SANDBOXES="${_LEGACY_MANAGED_RECOVERY_NAMES_JSON:-[]}" \
      "$cli_runner" upgrade-sandboxes --auto 2>&1 || recovery_status=$?
  fi
  if [ "$recovery_status" -eq 0 ]; then
    _PREEXISTING_SANDBOX_RECOVERY_RAN=true
    if [ -n "$recovery_log" ] \
      && grep -Fq "recorded sandbox(es) were not found on their recorded gateway" "$recovery_log"; then
      _PREEXISTING_SANDBOX_ORPHANED=true
    fi
    rm -f "$recovery_log" 2>/dev/null || true
    return 0
  fi

  rm -f "$recovery_log" 2>/dev/null || true
  _UPGRADE_SANDBOXES_FAILED=true
  warn "One or more existing sandboxes could not be recovered automatically."
  warn "Generic onboarding will not run; review the affected sandbox and preserved backup diagnostics above."
  return 1
}

run_onboard() {
  show_usage_notice
  info "Running ${_CLI_BIN} onboard…"
  local -a onboard_cmd=(onboard)
  local session_file
  session_file="$(nemoclaw_state_dir)/onboard-session.json"
  # --fresh takes precedence over any session state. We forward --fresh to
  # the active CLI's onboard command so it clears the existing session file before
  # creating a new one — the install.sh classifier is bypassed entirely.
  if [ "${FRESH:-}" = "1" ]; then
    info "Starting a fresh onboarding session (--fresh)."
    onboard_cmd+=(--fresh)
  elif command_exists node && [[ -f "$session_file" ]]; then
    # Classify the session: "resume" (auto-attach --resume), "fresh-recover"
    # (interrupted before sandbox creation — nothing to resume, start over),
    # "failed" (last run reported a step failure — user must choose), "skip"
    # (complete / missing / unreadable — nothing to resume), or "corrupt".
    local session_state
    session_state="$(
      node -e '
        const fs = require("fs");
        let out = "skip";
        try {
          const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          if (!data || data.resumable === false || data.status === "complete") {
            out = "skip";
          } else if (data.status === "failed" || data.failure) {
            out = "failed";
          } else if (data.status === "in_progress") {
            // A run interrupted before confirmed sandbox creation has no
            // sandbox to resume. Auto-attaching --resume here dead-ends at the
            // CLI non-interactive resume guard (#2753) with no recovery path
            // for curl|bash installs (#5626), so start fresh instead. Only
            // auto-resume once the session has both the sandbox name and the
            // completed sandbox step that onboard-session.ts records.
            const sandboxCreated =
              typeof data.sandboxName === "string" &&
              data.sandboxName.trim() !== "" &&
              data.steps &&
              data.steps.sandbox &&
              data.steps.sandbox.status === "complete";
            out = sandboxCreated ? "resume" : "fresh-recover";
          } else {
            // Unknown or missing status — do not auto-resume a file we
            // cannot classify against what onboard-session.ts actually
            // writes (in_progress / failed / complete).
            out = "corrupt";
          }
        } catch {
          out = "corrupt";
        }
        process.stdout.write(out);
      ' "$session_file" 2>/dev/null || printf "corrupt"
    )"
    case "$session_state" in
      resume)
        info "Found an interrupted onboarding session — resuming it."
        onboard_cmd+=(--resume)
        ;;
      fresh-recover)
        # #5626: interrupted before sandbox creation; nothing to resume.
        info "Found an interrupted onboarding session with no sandbox yet — starting fresh."
        onboard_cmd+=(--fresh)
        ;;
      failed)
        # #2430: a previous run failed. The user's provider/inference
        # choice may be the cause, so auto-resuming would just loop.
        # Refuse in non-interactive mode (no safe default); prompt in
        # interactive mode so the user can pick resume vs. fresh.
        local _fresh_install_cmd
        case "${NEMOCLAW_AGENT:-openclaw}" in
          hermes)
            _fresh_install_cmd="curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=hermes bash -s -- --fresh"
            ;;
          langchain-deepagents-code)
            _fresh_install_cmd="curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=langchain-deepagents-code bash -s -- --fresh"
            ;;
          *)
            _fresh_install_cmd="curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --fresh"
            ;;
        esac
        if [ "${NON_INTERACTIVE:-}" = "1" ]; then
          error "Previous onboarding session failed. To discard it and start over, run '${_fresh_install_cmd}'. To retry the same session, run '${_CLI_BIN} onboard --resume'."
        fi
        local _prompt_stdin="/dev/tty"
        if [ -t 0 ]; then _prompt_stdin="/dev/stdin"; fi
        if [ ! -r "$_prompt_stdin" ]; then
          error "Previous onboarding session failed, and no TTY is available to prompt. To discard it and start over, run '${_fresh_install_cmd}'. To retry the same session, run '${_CLI_BIN} onboard --resume'."
        fi
        info "Previous onboarding session failed."
        local _resume_answer=""
        while :; do
          printf "  Resume the failed session, or start fresh? [R/f]: " >&2
          if ! IFS= read -r _resume_answer <"$_prompt_stdin"; then
            error "Could not read response from TTY. To discard the failed session and start over, run '${_fresh_install_cmd}'. To retry the same session, run '${_CLI_BIN} onboard --resume'."
          fi
          # Use tr to lowercase the answer rather than the bash 4 case
          # expansion form (lowercase via the comma-comma operator), which
          # is unavailable on macOS /bin/bash 3.2 and would print
          # "bad substitution" on macOS hosts running the curl-piped
          # installer.
          local _resume_answer_lc
          _resume_answer_lc="$(printf '%s' "$_resume_answer" | tr '[:upper:]' '[:lower:]')"
          case "$_resume_answer_lc" in
            "" | r | resume)
              onboard_cmd+=(--resume)
              break
              ;;
            f | fresh)
              onboard_cmd+=(--fresh)
              break
              ;;
            *) printf "  Please answer 'r' or 'f'.\n" >&2 ;;
          esac
        done
        ;;
      corrupt)
        warn "Onboarding session file is unreadable — ignoring and starting fresh."
        ;;
      skip | *) ;;
    esac
  fi
  # Prefer the absolute path so a stale shell PATH cache cannot silently
  # skip auto-onboarding (#3276). _CLI_PATH is populated by verify_nemoclaw
  # whenever the binary is found on disk; if it is empty the caller has
  # already errored out via verify_nemoclaw's "binary not found" branch.
  local cli_invoke="${_CLI_PATH:-$_CLI_BIN}"
  local status=0
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    onboard_cmd+=(--non-interactive)
    if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
      onboard_cmd+=(--yes-i-accept-third-party-software)
    fi
    # A non-interactive install is by definition unattended consent;
    # forward --yes so the Ollama size-confirmation gate does not abort
    # the unattended download (the size is still printed to logs).
    onboard_cmd+=(--yes)
    "$cli_invoke" "${onboard_cmd[@]}" || status=$?
  elif [ -t 0 ]; then
    "$cli_invoke" "${onboard_cmd[@]}" || status=$?
  elif { exec 3</dev/tty; } 2>/dev/null; then
    info "Installer stdin is piped; attaching onboarding to /dev/tty…"
    "$cli_invoke" "${onboard_cmd[@]}" <&3 || status=$?
    exec 3<&-
  else
    error "Interactive onboarding requires a TTY. Re-run in a terminal or set NEMOCLAW_NON_INTERACTIVE=1 with --yes-i-accept-third-party-software."
  fi
  return "$status"
}

# Make sure Docker is installed and the current user can run it without
# sudo. If we install Docker or add the user to the docker group, exit with
# instructions to relogin/newgrp — Linux only loads group membership at
# login, so the rest of this script (onboard, etc.) would fail otherwise.
# Skipped on macOS (Docker Desktop) and inside WSL (host-managed Docker).
report_unexpected_docker_access() {
  # If Docker is reachable, installation can continue. Still surface the
  # unusual QA/security posture where a non-root user outside the docker group
  # can control the daemon, because that makes "non-docker user denied" checks
  # non-reproducible on this host.
  if [ "$(id -u 2>/dev/null || printf 1)" -eq 0 ]; then
    return 0
  fi

  local current_user
  current_user="$(id -un 2>/dev/null || printf unknown)"

  if id -nG "$current_user" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    return 0
  fi
  if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    return 0
  fi

  info "Docker is reachable even though user '$current_user' is not in the docker group."
  info "This host grants Docker daemon access through another path, so a negative test that expects 'docker info' to fail for non-docker users will not reproduce here."
  if [ -n "${DOCKER_HOST:-}" ]; then
    info "DOCKER_HOST is set to: $DOCKER_HOST"
  else
    info "DOCKER_HOST is not set; check for a docker wrapper, socket ACLs, sudo/policy rules, or host-specific daemon access configuration."
  fi
  local socket_state
  socket_state="$(stat -Lc '%a %U %G %n' /var/run/docker.sock 2>/dev/null || true)"
  if [ -n "$socket_state" ]; then
    info "Docker socket: $socket_state"
  fi
}

ensure_docker() {
  case "$(uname -s)" in
    Darwin | MINGW* | MSYS*) return 0 ;;
  esac
  if is_wsl_host; then
    return 0
  fi
  # Fast path: docker info works → already set up (root, or already-active group).
  if docker info >/dev/null 2>&1; then
    report_unexpected_docker_access
    return 0
  fi

  local needs_group_refresh=0

  if ! command -v docker >/dev/null 2>&1; then
    info "Docker is not installed."
    info "The next step uses sudo to install Docker system-wide via the official convenience script. You may be prompted for your password."
    local docker_tmp
    docker_tmp="$(mktemp)"
    if ! curl -fsSL https://get.docker.com -o "$docker_tmp"; then
      rm -f "$docker_tmp"
      error "Failed to download the Docker convenience script from https://get.docker.com"
    fi
    verify_downloaded_script "$docker_tmp" "Docker installer"
    if ! sudo sh "$docker_tmp"; then
      rm -f "$docker_tmp"
      error "Docker install failed. Install Docker manually and re-run."
    fi
    rm -f "$docker_tmp"
  fi

  if command -v systemctl >/dev/null 2>&1 \
    && ! sudo -n systemctl is-active --quiet docker 2>/dev/null \
    && ! systemctl is-active --quiet docker 2>/dev/null; then
    info "The Docker daemon is not running."
    info "The next step uses sudo to enable and start the docker.service unit. You may be prompted for your password."
    if ! sudo systemctl enable --now docker 2>/dev/null; then
      warn "Could not enable docker.service — will verify daemon accessibility below."
    fi
  fi

  # Root can use the docker socket without being in the docker group, so
  # skip the group setup entirely and just verify the daemon is reachable.
  if [ "$(id -u)" -eq 0 ]; then
    if ! docker info >/dev/null 2>&1; then
      error "Docker is installed but not reachable. Try: systemctl start docker"
    fi
    return 0
  fi

  # Use the effective UID's account name rather than $USER, which can be
  # unset, stale, or overridden by env wrappers.
  local current_user
  current_user="$(id -un)"

  # Persisted group membership (NSS / /etc/group). Determines whether we
  # need to run usermod.
  if ! id -nG "$current_user" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    info "Your user '$current_user' is not in the docker group."
    info "NemoClaw needs Docker access. On personal Linux development machines, adding your user to the docker group is the standard way to run Docker without sudo."
    info "Docker group members can control the daemon with root-level impact, so grant this access only to trusted local accounts; on shared or managed systems, use your organization's approved Docker access path."
    info "Background: https://docs.docker.com/engine/security/#docker-daemon-attack-surface"
    info "You may be prompted for your password."
    sudo usermod -aG docker "$current_user"
    needs_group_refresh=1
  fi

  # Active group list of the current shell (set at login, refreshed only by
  # new login or `newgrp`). If docker isn't here yet, this session can't
  # talk to /var/run/docker.sock even though NSS says we're a member.
  if ! id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    needs_group_refresh=1
  fi

  if [ "$needs_group_refresh" = "1" ]; then
    # #4414: in non-interactive mode, self-reactivate group membership via
    # sg(1) and re-exec the installer so a single curl|bash finishes the
    # install on a clean Ubuntu VM. Linux only loads group membership at
    # login, so without this the rest of the script can't talk to the
    # docker socket. The env-var guard prevents an infinite loop if sg
    # ran but the docker daemon is still unreachable for some other reason.
    if installer_non_interactive \
      && [ "${NEMOCLAW_DOCKER_GROUP_REACTIVATED:-}" != "1" ] \
      && command -v sg >/dev/null 2>&1; then
      local self="${NEMOCLAW_INSTALLER_STAGED:-${_INSTALLER_SCRIPT_PATH:-${BASH_SOURCE[0]:-$0}}}"
      if [ -n "$self" ] && [ -f "$self" ]; then
        info "Reactivating docker group membership via 'sg docker' to continue non-interactive install."
        export NEMOCLAW_DOCKER_GROUP_REACTIVATED=1
        local cmd
        printf -v cmd 'exec bash %q' "$self"
        if [ "${#_NEMOCLAW_INSTALLER_ARGS[@]}" -gt 0 ]; then
          local arg
          for arg in "${_NEMOCLAW_INSTALLER_ARGS[@]}"; do
            printf -v cmd '%s %q' "$cmd" "$arg"
          done
        fi
        exec sg docker -c "$cmd"
      fi
    fi
    printf "\n"
    info "Docker group membership is not active in this shell yet. To finish:"
    info "  1) Run: newgrp docker   (or log out and log back in)"
    info "  2) Re-run: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"
    exit 0
  fi

  if ! docker info >/dev/null 2>&1; then
    error "Docker is installed but not reachable. Try: sudo systemctl start docker"
  fi
}

is_wsl_host() {
  if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ]; then
    return 0
  fi
  if [ -r /proc/sys/kernel/osrelease ] \
    && grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null; then
    return 0
  fi
  if [ -r /proc/version ] \
    && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
    return 0
  fi
  return 1
}

# Detect DGX Spark / DGX Station from firmware (DMI first, devicetree fallback)
# and Windows WSL from the host environment. Echoes "DGX Spark",
# "DGX Station", "Windows WSL", or empty. Used to gate the express install
# prompt; only platforms with a known sensible default are offered.
detect_express_platform() {
  local model=""
  if is_wsl_host; then
    printf "Windows WSL"
    return
  fi
  if [ -r /sys/class/dmi/id/product_name ]; then
    model="$(cat /sys/class/dmi/id/product_name 2>/dev/null || true)"
  fi
  if [ -z "$model" ] && [ -r /sys/firmware/devicetree/base/model ]; then
    model="$(tr -d '\0' </sys/firmware/devicetree/base/model 2>/dev/null || true)"
  fi
  case "$model" in
    *DGX*Spark*) printf "DGX Spark" ;;
    *Station*GB300*)
      if [ -e /etc/dgx-release ] || [ -L /etc/dgx-release ]; then
        printf "Unsupported DGX Station OS"
      else
        printf "DGX Station"
      fi
      ;;
    *DGX*Station*) printf "Unsupported DGX Station generation" ;;
    *) ;;
  esac
}

validate_express_platform_boundary() {
  case "${1:-}" in
    "Unsupported DGX Station OS")
      if [ "${NEMOCLAW_NO_EXPRESS:-}" = "1" ] || [ -n "${NEMOCLAW_PROVIDER:-}" ]; then return 0; fi
      error "DGX OS/BaseOS is outside the validated Station express boundary. Use the generic Ubuntu 24.04 ARM64 image."
      ;;
    "Unsupported DGX Station generation")
      if [ "${NEMOCLAW_NO_EXPRESS:-}" = "1" ] || [ -n "${NEMOCLAW_PROVIDER:-}" ]; then return 0; fi
      error "This DGX Station generation is outside the validated Station GB300 express boundary."
      ;;
  esac
}

STATION_ULTRA_VLLM_MODEL="nemotron-3-ultra-550b-a55b"
STATION_ULTRA_SERVED_MODEL="nvidia/nemotron-3-ultra-550b-a55b"
STATION_DEEPSEEK_VLLM_MODEL="deepseek-v4-flash"
STATION_DEEPSEEK_SERVED_MODEL="deepseek-ai/DeepSeek-V4-Flash"
_SELECTED_EXPRESS_PLATFORM=""
_STATION_EXPRESS_RESUME_REVISION=""

normalize_station_vllm_model() {
  printf "%s" "${1:-}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# True when an interactive terminal is reachable for a prompt: stdin is a TTY,
# or /dev/tty can be opened (the curl|bash case where stdin is the script pipe).
# Mirrors how maybe_offer_express_install decides whether it can prompt.
express_prompt_can_read_tty() {
  [ -t 0 ] && return 0
  if { exec 3</dev/tty; } 2>/dev/null; then
    exec 3<&-
    return 0
  fi
  return 1
}

fail_station_deepseek_terminal_required() {
  error "--station-deepseek selects the DGX Station express prompt, which needs an interactive terminal. Re-run from a terminal (for a curl|bash pipe, /dev/tty must be available), or omit --station-deepseek and configure the install non-interactively."
}

validate_station_deepseek_override() {
  local platform="$1"
  if [ "${STATION_DEEPSEEK:-}" != "1" ]; then
    return 0
  fi
  if [ "$platform" != "DGX Station" ]; then
    error "--station-deepseek requires a detected DGX Station (detected: ${platform:-unsupported platform})."
  fi
  if [ "${NEMOCLAW_NO_EXPRESS:-}" = "1" ]; then
    error "--station-deepseek cannot be combined with NEMOCLAW_NO_EXPRESS=1. Remove one override."
  fi
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    # #7009: name what actually put the run in non-interactive mode so the user
    # can act on it. NON_INTERACTIVE_SOURCE is recorded in main() where the
    # origin is still known (main exports NON_INTERACTIVE into
    # NEMOCLAW_NON_INTERACTIVE, erasing the distinction here). Append the clause
    # only when the origin is known, so direct callers that set NON_INTERACTIVE
    # without going through main's flag parsing still get a clean message.
    local trigger_note=""
    if [ -n "${NON_INTERACTIVE_SOURCE:-}" ]; then
      trigger_note=" (triggered by: ${NON_INTERACTIVE_SOURCE})"
    fi
    error "--station-deepseek selects the DGX Station express prompt and cannot be combined with non-interactive mode${trigger_note}."
  fi
  if [ -n "${NEMOCLAW_PROVIDER:-}" ]; then
    error "--station-deepseek conflicts with NEMOCLAW_PROVIDER=${NEMOCLAW_PROVIDER}. Remove the provider override to use Station express install."
  fi

  local requested_model
  requested_model="$(normalize_station_vllm_model "${NEMOCLAW_VLLM_MODEL:-}")"
  case "$requested_model" in
    "" | "$STATION_DEEPSEEK_VLLM_MODEL" | "deepseek-ai/deepseek-v4-flash") ;;
    *)
      error "--station-deepseek conflicts with NEMOCLAW_VLLM_MODEL='${NEMOCLAW_VLLM_MODEL}'. Remove one override or set NEMOCLAW_VLLM_MODEL=${STATION_DEEPSEEK_VLLM_MODEL}."
      ;;
  esac

  # #7014: --station-deepseek selects the interactive DGX Station express prompt,
  # so it needs a terminal. Without one, maybe_offer_express_install would just
  # log "Skipping express prompt (no TTY)" and continue, silently ignoring the
  # flag and installing a different configuration. Fail fast here (before Docker
  # / build deps) with a clear message instead, mirroring the --non-interactive
  # rejection above. Checked last so a genuine config conflict (provider/model)
  # is still reported first.
  if ! express_prompt_can_read_tty; then
    fail_station_deepseek_terminal_required
  fi
}

preflight_explicit_express_flags() {
  local platform
  platform="$(detect_express_platform)"
  validate_express_platform_boundary "$platform"
  validate_station_deepseek_override "$platform"
}

configure_station_express_model() {
  local selected_model
  selected_model="$(normalize_station_vllm_model "${NEMOCLAW_VLLM_MODEL:-}")"
  if [ "${STATION_DEEPSEEK:-}" = "1" ]; then
    NEMOCLAW_VLLM_MODEL="$STATION_DEEPSEEK_VLLM_MODEL"
    NEMOCLAW_MODEL="$STATION_DEEPSEEK_SERVED_MODEL"
  elif [ -z "$selected_model" ]; then
    NEMOCLAW_VLLM_MODEL="$STATION_ULTRA_VLLM_MODEL"
    NEMOCLAW_MODEL="$STATION_ULTRA_SERVED_MODEL"
  else
    case "$selected_model" in
      "$STATION_ULTRA_VLLM_MODEL" | "nvidia/nvidia-nemotron-3-ultra-550b-a55b-nvfp4")
        NEMOCLAW_MODEL="$STATION_ULTRA_SERVED_MODEL"
        ;;
      "$STATION_ULTRA_SERVED_MODEL")
        # The served alias is useful in route output but is not a Hugging Face
        # repository ID. Normalize it to the registered model slug before the
        # existing managed-vLLM selector consumes it.
        NEMOCLAW_VLLM_MODEL="$STATION_ULTRA_VLLM_MODEL"
        NEMOCLAW_MODEL="$STATION_ULTRA_SERVED_MODEL"
        ;;
      "$STATION_DEEPSEEK_VLLM_MODEL" | "deepseek-ai/deepseek-v4-flash")
        NEMOCLAW_MODEL="$STATION_DEEPSEEK_SERVED_MODEL"
        ;;
    esac
  fi
  export NEMOCLAW_VLLM_MODEL
  if [ -n "${NEMOCLAW_MODEL:-}" ]; then
    export NEMOCLAW_MODEL
  fi
}

station_express_resume_file() {
  local state_dir
  state_dir="$(nemoclaw_state_dir)" || return 1
  printf '%s/station-express-resume' "$state_dir"
}

validate_station_express_resume_model() {
  local model="${1:-}"
  [[ ${#model} -le 255 && "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]
}

validate_station_express_resume_revision() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]
}

station_installer_revision() {
  local revision
  revision="$(git -C "${SCRIPT_DIR}/.." rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
    || error "Could not resolve the exact NemoClaw revision for DGX Station reboot resume."
  validate_station_express_resume_revision "$revision" \
    || error "Resolved NemoClaw revision is invalid: ${revision}"
  printf '%s' "$revision"
}

portable_file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

assert_station_express_resume_file_safe() {
  local state_file=$1 state_dir mode
  state_dir="$(dirname "$state_file")"
  [[ -d "$state_dir" && -O "$state_dir" ]] \
    || error "DGX Station express resume directory is not owned by the current user: ${state_dir}"
  mode="$(portable_file_mode "$state_dir")" \
    || error "Could not inspect DGX Station express resume directory permissions: ${state_dir}"
  (((8#$mode & 0077) == 0)) \
    || error "DGX Station express resume directory must not be accessible by group or other users: ${state_dir}"
  [[ -f "$state_file" && -O "$state_file" ]] \
    || error "DGX Station express resume state must be a regular file owned by the current user: ${state_file}"
  mode="$(portable_file_mode "$state_file")" \
    || error "Could not inspect DGX Station express resume state permissions: ${state_file}"
  [[ "$mode" == "600" ]] || error "DGX Station express resume state must have mode 0600: ${state_file}"
}

load_station_express_resume() {
  local state_file revision_line model_line line_count saved_revision current_revision
  state_file="$(station_express_resume_file)" || return 1
  assert_nemoclaw_state_path_safe "$state_file"
  [[ -e "$state_file" || -L "$state_file" ]] || return 1
  assert_station_express_resume_file_safe "$state_file"
  line_count="$(wc -l <"$state_file" | tr -d '[:space:]')"
  revision_line="$(sed -n '1p' "$state_file")"
  model_line="$(sed -n '2p' "$state_file")"
  saved_revision="${revision_line#revision=}"
  NEMOCLAW_VLLM_MODEL="${model_line#model=}"
  if [[ "$line_count" != "2" || "$revision_line" != "revision=${saved_revision}" || "$model_line" != "model=${NEMOCLAW_VLLM_MODEL}" ]] \
    || ! validate_station_express_resume_revision "$saved_revision" \
    || ! validate_station_express_resume_model "$NEMOCLAW_VLLM_MODEL"; then
    error "DGX Station express resume state is invalid. Remove ${state_file} and rerun the installer."
  fi
  current_revision="$(station_installer_revision)"
  if [[ "$current_revision" != "$saved_revision" ]]; then
    error "DGX Station express resume requires NemoClaw revision ${saved_revision}, but this installer is ${current_revision}. Rerun with: curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=${saved_revision} bash"
  fi
  export NEMOCLAW_VLLM_MODEL
}

save_station_express_resume() {
  local state_file state_dir temp_file revision model="${NEMOCLAW_VLLM_MODEL:-}"
  validate_station_express_resume_model "$model" || error "Cannot save an invalid DGX Station express model selector."
  revision="$(station_installer_revision)"
  state_file="$(station_express_resume_file)" || error "Could not resolve NemoClaw state for DGX Station express resume."
  state_dir="$(ensure_nemoclaw_state_dir)" || error "Could not prepare NemoClaw state for DGX Station express resume."
  assert_nemoclaw_state_path_safe "$state_file"
  temp_file="$(mktemp "${state_file}.tmp.XXXXXX")" || error "Could not create DGX Station express resume state under ${state_dir}."
  chmod 600 "$temp_file" || {
    rm -f "$temp_file"
    error "Could not secure DGX Station express resume state under ${state_dir}."
  }
  if ! printf 'revision=%s\nmodel=%s\n' "$revision" "$model" >"$temp_file"; then
    rm -f "$temp_file"
    error "Could not write DGX Station express resume state under ${state_dir}."
  fi
  if ! mv -f "$temp_file" "$state_file"; then
    rm -f "$temp_file"
    error "Could not publish DGX Station express resume state under ${state_dir}."
  fi
  assert_station_express_resume_file_safe "$state_file"
  _STATION_EXPRESS_RESUME_REVISION="$revision"
}

clear_station_express_resume() {
  local state_file
  state_file="$(station_express_resume_file)" || return 0
  assert_nemoclaw_state_path_safe "$state_file"
  [[ -e "$state_file" || -L "$state_file" ]] || return 0
  [[ -f "$state_file" && -O "$state_file" ]] \
    || error "Refusing to remove invalid DGX Station express resume state: ${state_file}"
  rm -f "$state_file"
}

activate_express_install() {
  local platform="$1"
  _SELECTED_EXPRESS_PLATFORM="$platform"
  NON_INTERACTIVE=1
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt
  export NEMOCLAW_YES=1
  export NEMOCLAW_POLICY_MODE=suggested
  case "$platform" in
    "DGX Spark")
      export NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      export NEMOCLAW_PROVIDER=install-vllm
      if [ -n "${NEMOCLAW_VLLM_MODEL:-}" ]; then
        export NEMOCLAW_VLLM_MODEL
      fi
      ;;
    "DGX Station")
      export NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      export NEMOCLAW_PROVIDER=install-vllm
      configure_station_express_model
      ;;
    "Windows WSL")
      export NEMOCLAW_PROVIDER=install-windows-ollama
      ;;
  esac
}

run_station_host_preparation() {
  # Public curl|bash starts in the root bootstrap, which clones the complete
  # selected ref before executing this payload. Keep the sibling lookup and
  # fail-closed check so Station preparation cannot drift from that ref.
  local helper="${SCRIPT_DIR}/prepare-dgx-station-host.sh"
  [[ -f "$helper" ]] || error "DGX Station host preparation helper is missing: ${helper}"
  bash "$helper" --apply
}

ensure_station_express_host() {
  [[ "${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]] || return 0

  info "Checking pinned DGX Station host prerequisites. Exact matches are reused."
  local status=0
  run_station_host_preparation || status=$?
  case "$status" in
    0)
      ok "DGX Station host prerequisites are ready"
      ;;
    10)
      save_station_express_resume
      local revision
      revision="${_STATION_EXPRESS_RESUME_REVISION}"
      warn "DGX Station host prerequisites were installed and require a reboot."
      info "Run: sudo reboot"
      info "After signing in again, rerun the accepted revision:"
      info "curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=${revision} bash"
      exit 10
      ;;
    *)
      error "DGX Station host preparation failed. Review the station-bootstrap log above, correct the reported host state, and rerun the installer."
      ;;
  esac
}

prepare_installer_host() {
  maybe_offer_express_install
  # Intentional ordering: Station preparation owns the reboot boundary before
  # generic Docker bootstrap; ensure_station_express_host is a no-op elsewhere.
  ensure_station_express_host
  ensure_docker
  ensure_openshell_build_deps
}

# Prompt the user to opt into express install on supported platforms. Sets the
# non-interactive + provider/model env vars when accepted. Skipped when
# the user already passed --non-interactive, set NEMOCLAW_PROVIDER, or has
# no TTY.
describe_express_install() {
  local platform="$1"
  local inference_summary=""
  local inference_disclosure=""
  local sandbox_summary=""
  local tier="${NEMOCLAW_POLICY_TIER:-balanced}"
  local policy_summary=""

  case "$platform" in
    "DGX Spark")
      if [ -n "${NEMOCLAW_VLLM_MODEL:-}" ]; then
        inference_summary="managed local vLLM with model ${NEMOCLAW_VLLM_MODEL}"
      else
        inference_summary="managed local vLLM using the DGX Spark profile default model"
      fi
      inference_disclosure="Managed vLLM pulls the configured vLLM image/model and runs a local vLLM inference container."
      sandbox_summary="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      ;;
    "DGX Station")
      if [ "${STATION_DEEPSEEK:-}" = "1" ]; then
        inference_summary="managed local vLLM with DeepSeek V4 Flash"
        inference_disclosure="Managed vLLM pulls the configured Station image/model and runs a local inference container."
      elif [ -n "$(printf "%s" "${NEMOCLAW_VLLM_MODEL:-}" | tr -d '[:space:]')" ]; then
        inference_summary="managed local vLLM with model ${NEMOCLAW_VLLM_MODEL}"
        inference_disclosure="Managed vLLM pulls the configured vLLM image/model and runs a local inference container."
      else
        inference_summary="managed local vLLM with NVIDIA Nemotron 3 Ultra 550B"
        inference_disclosure="Managed vLLM pulls the pinned Station image and approximately 352 GB model, then runs a local inference container."
      fi
      printf "  Station host setup reuses exact prerequisite versions, applies the reviewed factory DKMS transition when present, installs missing pinned driver, Docker, and NVIDIA Container Toolkit packages, and may require one reboot.\n"
      printf "  Host setup may add this trusted local account to the docker group, which grants root-equivalent control. This flow is only for trusted single-user development hosts; shared or managed hosts require an organization-approved Docker access path.\n"
      printf "  DGX Station remains Deferred; this recipe has not completed end-to-end validation on physical hardware.\n"
      sandbox_summary="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      ;;
    "Windows WSL")
      inference_summary="Windows-host Ollama through host.docker.internal"
      sandbox_summary="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      ;;
    *)
      inference_summary="managed local inference"
      sandbox_summary="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      ;;
  esac

  case "$tier" in
    balanced)
      policy_summary="base sandbox policy plus npm, pypi, huggingface, brew, and the selected web-search preset"
      policy_summary="${policy_summary}, and local-inference access when needed"
      ;;
    restricted)
      policy_summary="base sandbox policy, plus local-inference access when needed"
      ;;
    open)
      policy_summary="base sandbox policy plus broad third-party presets"
      policy_summary="${policy_summary}, and local-inference access when needed"
      ;;
    *)
      policy_summary="base sandbox policy plus tier presets supported by the active agent"
      policy_summary="${policy_summary}, and local-inference access when needed"
      ;;
  esac

  printf "  Express install will configure %s.\n" "$inference_summary"
  if [ -n "$inference_disclosure" ]; then
    printf "  %s\n" "$inference_disclosure"
  fi
  printf "  Sandbox name: %s.\n" "$sandbox_summary"
  printf "  It runs onboarding non-interactively, but still prompts for sudo when host setup needs it.\n"
  printf "  Sandbox policy: suggested mode, tier '%s'. This uses the %s.\n" "$tier" "$policy_summary"
}

maybe_offer_express_install() {
  local platform
  platform="$(detect_express_platform)"
  validate_express_platform_boundary "$platform"
  validate_station_deepseek_override "$platform"
  # Not on a platform we have an express recipe for — say nothing.
  if [ -z "$platform" ]; then
    return 0
  fi
  # On a supported platform but a skip condition applies — explain why so
  # the user understands they could have gotten express otherwise.
  if [ "${NEMOCLAW_NO_EXPRESS:-}" = "1" ]; then
    if [ "$platform" = "DGX Station" ]; then clear_station_express_resume; fi
    info "Detected ${platform}. Skipping express prompt (NEMOCLAW_NO_EXPRESS=1)."
    return 0
  fi
  if [ -n "${NEMOCLAW_PROVIDER:-}" ]; then
    if [ "$platform" = "DGX Station" ]; then clear_station_express_resume; fi
    info "Detected ${platform}. Skipping express prompt (NEMOCLAW_PROVIDER=${NEMOCLAW_PROVIDER} already set)."
    return 0
  fi
  if [ "$platform" = "DGX Station" ] && load_station_express_resume; then
    info "Detected DGX Station. Resuming the accepted express install after host preparation."
    activate_express_install "$platform"
    return 0
  fi
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    info "Detected ${platform}. Skipping express prompt (--non-interactive set)."
    return 0
  fi
  local reply=""
  if [ -t 0 ]; then
    info "Detected ${platform}."
    describe_express_install "$platform"
    printf "  Run express install with these settings? [Y/n]: "
    if ! IFS= read -r reply; then
      if [ "${STATION_DEEPSEEK:-}" = "1" ]; then
        fail_station_deepseek_terminal_required
      fi
      info "Skipping express install (unable to read from TTY)."
      return 0
    fi
  elif { exec 3</dev/tty; } 2>/dev/null; then
    info "Detected ${platform}."
    describe_express_install "$platform"
    printf "  Run express install with these settings? [Y/n]: "
    if ! IFS= read -r reply <&3; then
      exec 3<&-
      if [ "${STATION_DEEPSEEK:-}" = "1" ]; then
        fail_station_deepseek_terminal_required
      fi
      info "Skipping express install (unable to read from TTY)."
      return 0
    fi
    exec 3<&-
  else
    info "Detected ${platform}. Skipping express prompt (no TTY)."
    return 0
  fi
  reply="$(printf "%s" "$reply" | tr '[:upper:]' '[:lower:]')"
  case "$reply" in
    "" | y | yes)
      info "Using express install for ${platform}."
      activate_express_install "$platform"
      ;;
    *)
      info "Skipping express install. Continuing with interactive flow."
      ;;
  esac
}

# Main
# ---------------------------------------------------------------------------
main() {
  # Capture the original argv so ensure_docker can forward it across a
  # self re-exec under sg(1) when the docker group needs activating in a
  # non-interactive run (#4414).
  _NEMOCLAW_INSTALLER_ARGS=("$@")

  # Parse flags
  NON_INTERACTIVE=""
  # #7009: record what put the run in non-interactive mode so conflict errors
  # (e.g. validate_station_deepseek_override) can name the trigger. main()
  # exports NON_INTERACTIVE into NEMOCLAW_NON_INTERACTIVE below, so the origin
  # cannot be recovered from the env at error time — track it here instead.
  NON_INTERACTIVE_SOURCE=""
  ACCEPT_THIRD_PARTY_SOFTWARE=""
  FRESH=""
  STATION_DEEPSEEK=""
  for arg in "$@"; do
    case "$arg" in
      --non-interactive)
        NON_INTERACTIVE=1
        NON_INTERACTIVE_SOURCE="the --non-interactive flag"
        ;;
      --yes-i-accept-third-party-software) ACCEPT_THIRD_PARTY_SOFTWARE=1 ;;
      --fresh) FRESH=1 ;;
      --station-deepseek) STATION_DEEPSEEK=1 ;;
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
  if [ "${NON_INTERACTIVE:-}" = "1" ] && [ -z "${NON_INTERACTIVE_SOURCE:-}" ]; then
    NON_INTERACTIVE_SOURCE="NEMOCLAW_NON_INTERACTIVE=1"
  fi
  ACCEPT_THIRD_PARTY_SOFTWARE="${ACCEPT_THIRD_PARTY_SOFTWARE:-${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}}"
  FRESH="${FRESH:-${NEMOCLAW_FRESH:-}}"

  # If the user explicitly accepted the third-party-software notice, treat
  # that as non-interactive intent for the rest of the run too — show_usage_notice
  # is only one of several phase-3 steps that need a TTY or --non-interactive
  # (run_onboard has the same gate). Without this, ACCEPT_THIRD_PARTY_SOFTWARE=1
  # alone clears the preflight below but the install can still partial-fail at
  # run_onboard with the same TTY error, leaving phases 1/2 on disk anyway.
  #
  # #7008: `--station-deepseek` is the exception — it explicitly selects the
  # interactive DGX Station express prompt, so accepting the notice must NOT
  # imply non-interactive there. The two signals are orthogonal: one accepts a
  # licence, the other opts into an interactive express flow. Inferring
  # non-interactive from the notice would make the express flow reject its own
  # required flag (validate_station_deepseek_override).
  if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ] && [ "${NON_INTERACTIVE:-}" != "1" ] \
    && [ "${STATION_DEEPSEEK:-}" != "1" ]; then
    NON_INTERACTIVE=1
  fi

  export NEMOCLAW_NON_INTERACTIVE="${NON_INTERACTIVE}"
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${ACCEPT_THIRD_PARTY_SOFTWARE}"

  # Validate the gateway port before the banner, notice acceptance, downloads,
  # or any other installer side effect.
  resolve_nemoclaw_gateway_port >/dev/null

  # Explicit express-only flags must fail before license state, Docker, build
  # dependencies, or any other host mutation. maybe_offer_express_install
  # repeats the same authoritative validation at the prompt boundary because
  # it is also exercised directly by sourced-installer callers and tests.
  preflight_explicit_express_flags

  print_banner

  # Fail-fast license-acceptance check (#2671). Headless curl|bash still exits
  # before phase 1 so it cannot leave a half-install behind. Piped installs from
  # a real terminal are different: stdin is the script pipe, but /dev/tty can
  # still collect acceptance before Node.js or the CLI are installed.
  preflight_usage_notice_prompt

  # Offer express install on supported platforms (DGX Spark / Station / WSL).
  # Runs AFTER the third-party notice so the user has explicitly accepted the
  # license before opting into the unattended path. Express only sets the
  # provider/model/policy + non-interactive vars; license acceptance is
  # already recorded by preflight above. Station selection runs its pinned
  # host prerequisite preparation before the generic Docker bootstrap.
  prepare_installer_host

  _INSTALL_START=$SECONDS
  bash "${SCRIPT_DIR}/setup-jetson.sh"

  step 1 "Node.js"
  install_nodejs
  ensure_supported_runtime

  step 2 "${_CLI_DISPLAY} CLI"
  # Ollama and vLLM install/upgrade and model pulls are owned by
  # `nemoclaw onboard` (the install-ollama / install-vllm branches).
  # install.sh stays focused on dependency setup.
  fix_npm_permissions
  preinstall_backup_and_retire_legacy_gateway
  install_nemoclaw
  verify_nemoclaw

  # Gate the onboarding-adjacent steps on the absolute CLI path so a stale
  # shell PATH cache no longer suppresses auto-onboarding (#3276). Falls
  # back to PATH lookup as a safety net for unusual environments.
  local _cli_runner=""
  if [[ -n "$_CLI_PATH" && -x "$_CLI_PATH" ]]; then
    _cli_runner="$_CLI_PATH"
  elif command_exists "$_CLI_BIN"; then
    _cli_runner="$_CLI_BIN"
  fi

  step 3 "Onboarding"
  if [ -n "$_cli_runner" ]; then
    local _registered_sandbox_count=""
    if ! _registered_sandbox_count="$(registered_sandbox_count)"; then
      error "Could not inspect the existing sandbox registry. Onboarding was not started."
    fi
    if [[ "$_registered_sandbox_count" -gt 0 ]]; then
      warn "Existing sandbox sessions detected. Onboarding may disrupt running agents."
      if [[ "${NEMOCLAW_SINGLE_SESSION:-}" == "1" ]]; then
        error "Aborting — NEMOCLAW_SINGLE_SESSION is set. Destroy existing sessions with '${_CLI_BIN} <name> destroy' before reinstalling."
      fi
      warn "Consider destroying existing sessions with '${_CLI_BIN} <name> destroy' first."
      warn "Set NEMOCLAW_SINGLE_SESSION=1 to abort the installer when sessions are active."
    fi
    if run_installer_host_preflight; then
      if ! recover_preexisting_sandboxes_before_onboard "$_cli_runner"; then
        finalize_install
        return 1
      fi
      if [[ "${_PREEXISTING_SANDBOX_RECOVERY_RAN:-false}" == true ]]; then
        if [[ "${_PREEXISTING_SANDBOX_ORPHANED:-false}" == true ]]; then
          # #6520: do not claim recovery when recorded sandboxes are stranded.
          warn "Some recorded sandboxes could not be recovered; skipping generic onboarding."
        else
          info "Existing sandboxes recovered; skipping generic onboarding."
        fi
      else
        run_onboard || error "Onboarding did not complete successfully."
        ONBOARD_RAN=true
        restore_onboard_forward_after_post_checks || error "Hermes host forward restore failed."
      fi
    elif [ "${NON_INTERACTIVE:-}" = "1" ]; then
      error "Skipping onboarding until the host prerequisites above are fixed."
    else
      warn "Skipping onboarding until the host prerequisites above are fixed."
    fi
  else
    warn "Skipping onboarding — could not locate the ${_CLI_BIN} executable on disk."
  fi

  finalize_install
  if [[ "${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]]; then
    clear_station_express_resume
  fi
}

# Print the completion summary, then propagate a fatal/non-zero result when the
# automatic recovery of a pre-existing sandbox failed (#5735, PRA-5). A failed
# recovery can have left an existing sandbox destroyed or backup-only, so the install must not be
# reported as success. print_done() has already shown the affected sandbox and
# recovery guidance (and the "completed with warnings" banner); exiting non-zero
# here is what keeps automation and operators from treating it as a clean
# install. Extracted from main() so it is unit-testable.
finalize_install() {
  print_done
  if [[ "${_UPGRADE_SANDBOXES_FAILED:-false}" == true ]]; then
    error "Installation incomplete: one or more existing sandboxes failed to upgrade. See the recovery guidance above."
  fi
}

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]] || { [[ -z "${BASH_SOURCE[0]:-}" ]] && { [[ "$0" == "bash" ]] || [[ "$0" == "-bash" ]]; }; }; then
  # #4414: When invoked via `curl ... | bash`, BASH_SOURCE is empty and
  # $0="bash". ensure_docker's sg(1) re-exec (#4419) needs a real script
  # file to point bash at; without one it falls back to the legacy
  # newgrp/re-curl path. Stage the installer by re-curling the canonical
  # URL so the sg(1) re-exec has a file to execute. NEMOCLAW_INSTALLER_STAGED
  # carries the staged path forward as both loop guard and cleanup key.
  if [[ -z "${BASH_SOURCE[0]:-}" ]] && [[ -z "${NEMOCLAW_INSTALLER_STAGED:-}" ]]; then
    _installer_url="${NEMOCLAW_INSTALLER_URL:-https://www.nvidia.com/nemoclaw.sh}"
    if _staged="$(mktemp /tmp/nemoclaw-installer-XXXXXX 2>/dev/null)" \
      && curl -fsSL "$_installer_url" -o "$_staged" 2>/dev/null \
      && [[ -s "$_staged" ]] \
      && head -1 "$_staged" | grep -qE '^#!.*(sh|bash)' \
      && bash -n "$_staged" 2>/dev/null; then
      chmod +x "$_staged"
      export NEMOCLAW_INSTALLER_STAGED="$_staged"
      exec bash "$_staged" "$@"
    fi
    # Staging failed (mktemp / curl / empty / bad shebang / syntax check) —
    # fall through to direct main(). The legacy newgrp/re-curl path still applies.
    rm -f "${_staged:-}" 2>/dev/null
  fi
  main "$@"
fi
