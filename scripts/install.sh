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
# Bind the portable installer's temporary Docker CLI selector so only that
# exact value can be removed from the Hermes onboarding child.
unset _PORTABLE_INSTALLER_DOCKER_HOST
_PORTABLE_INSTALLER_DOCKER_HOST=""
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
  # Prefer the .version file stamped during install: it records the exact
  # requested tag, while describe on a shallow clone can resolve a different
  # nearby tag.
  if [[ -f "${repo_root}/.version" ]]; then
    local file_ver
    file_ver="$(cat "${repo_root}/.version")"
    if [[ -n "$file_ver" ]]; then
      printf "%s" "$file_ver"
      return
    fi
  fi
  # Fall back to git tags (dev clones and CI have no .version)
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

# Map an install ref to the version string to stamp into .version. Prints the
# semver for an immutable version tag; prints nothing for mutable (lkg/latest)
# or non-version refs so callers fall back to git describe.
resolve_stamped_version() {
  local ref="${1:-}" version=""
  case "$ref" in
    refs/tags/*) version="${ref#refs/tags/}" ;;
    *) version="$ref" ;;
  esac
  version="${version#v}"
  if is_mutable_install_ref "$ref" \
    || ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    return 0
  fi
  printf "%s" "$version"
}

clone_nemoclaw_ref() {
  local ref="$1" dest="$2"

  (
    # Git applies the process umask when it creates the authoritative source checkout.
    umask 022
    git init --quiet "$dest"
    git -C "$dest" remote add origin https://github.com/NVIDIA/NemoClaw.git
    if ! git -C "$dest" fetch --quiet --depth 1 origin "+${ref}:refs/nemoclaw-install/target"; then
      error "Requested install ref '$ref' is not available from https://github.com/NVIDIA/NemoClaw.git. Check NEMOCLAW_INSTALL_TAG/NEMOCLAW_INSTALL_REF and try again."
    fi
    git -C "$dest" -c advice.detachedHead=false checkout --quiet --detach refs/nemoclaw-install/target
  )
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
error_with_status() {
  local status="$1"
  shift
  printf "${C_RED}[ERROR]${C_RESET} %s\n" "$*" >&2
  exit "$status"
}
error() { error_with_status 1 "$@"; }
ok() { printf "  ${C_GREEN}✓${C_RESET}  %s\n" "$*"; }

resolve_nemoclaw_gateway_port() {
  local port="${NEMOCLAW_GATEWAY_PORT:-8080}"
  port="${port#"${port%%[![:space:]]*}"}"
  port="${port%"${port##*[![:space:]]}"}"
  if [[ ! "$port" =~ ^0*([0-9]{1,5})$ ]]; then
    error "NEMOCLAW_GATEWAY_PORT must be an integer between 1024 and 65535."
  fi
  port="$((10#${BASH_REMATCH[1]}))"
  if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
    error "NEMOCLAW_GATEWAY_PORT must be an integer between 1024 and 65535."
  fi
  if [ "$port" -ge 18789 ] && [ "$port" -le 18799 ]; then
    error "NEMOCLAW_GATEWAY_PORT must not overlap the 18789-18799 dashboard port range."
  fi
  case "$port" in
    8000 | 8081 | 11434 | 11435 | 11436 | 11437 | 11438)
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
    NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT
  )
  local -a configured_ports=(
    "${NEMOCLAW_DASHBOARD_PORT:-18789}"
    "${NEMOCLAW_VLLM_PORT:-8000}"
    "${NEMOCLAW_OLLAMA_PORT:-11434}"
    "${NEMOCLAW_OLLAMA_PROXY_PORT:-11435}"
    "${NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT:-11436}"
    "${NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT:-11437}"
    "${NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT:-11438}"
  )
  local i configured_port
  for i in "${!configured_ports[@]}"; do
    configured_port="${configured_ports[$i]}"
    configured_port="${configured_port#"${configured_port%%[![:space:]]*}"}"
    configured_port="${configured_port%"${configured_port##*[![:space:]]}"}"
    if [[ "$configured_port" =~ ^0*8081$ ]]; then
      error "${configured_names[$i]} must not overlap the fixed llama.cpp inference port (8081)."
    fi
    if [[ "$configured_port" =~ ^[0-9]+$ ]] && [ "$port" -eq "$configured_port" ]; then
      error "NEMOCLAW_GATEWAY_PORT conflicts with ${configured_names[$i]} ($configured_port)."
    fi
  done
  printf "%s" "$port"
}

nemoclaw_state_root() {
  local home="${HOME%/}"
  [ -n "$home" ] || home="/"
  if [ "$home" = "/" ]; then
    printf "/.nemoclaw"
  else
    printf "%s/.nemoclaw" "$home"
  fi
}

nemoclaw_state_dir() {
  local port root
  port="$(resolve_nemoclaw_gateway_port)" || return 1
  root="$(nemoclaw_state_root)" || return 1
  if [ "$port" -eq 8080 ]; then
    printf "%s" "$root"
  else
    printf "%s/gateways/%s" "$root" "$port"
  fi
}

assert_nemoclaw_state_path_safe() {
  local target="$1" root current relative component
  root="$(nemoclaw_state_root)" || return 1
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
  root="$(nemoclaw_state_root)" || return 1
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

# Read the API port the named sandbox was registered with. Each Hermes sandbox
# allocates its own, so the forward must target this sandbox's port rather than
# the default a sibling sandbox may already hold.
resolve_hermes_api_port() {
  local registry_file
  registry_file="$(nemoclaw_state_dir)/sandboxes.json"
  if [[ ! -f "$registry_file" ]] || ! command_exists node; then
    return 1
  fi
  node -e '
    const fs = require("fs");
    try {
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const sandboxes = data.sandboxes;
      const name = process.argv[2];
      if (
        !sandboxes ||
        typeof sandboxes !== "object" ||
        Array.isArray(sandboxes) ||
        !Object.prototype.hasOwnProperty.call(sandboxes, name)
      ) {
        throw new Error("sandbox state is unavailable");
      }
      const entry = sandboxes[name];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("sandbox state is malformed");
      }
      if (!Object.prototype.hasOwnProperty.call(entry, "hermesApiPort")) {
        process.stdout.write("8642");
      } else {
        const port = entry.hermesApiPort;
        if (!Number.isInteger(port) || port < 8642 || port > 8652) {
          throw new Error("Hermes API port is malformed");
        }
        process.stdout.write(String(port));
      }
    } catch {
      process.exitCode = 1;
    }
  ' "$registry_file" "$1" 2>/dev/null
}

restore_onboard_forward_after_post_checks() {
  local sandbox_name agent_name agent_display port openshell_bin openshell_dir attempt selected_state_dir state_dir pid_file watcher_script watcher_pid start_diagnostic diagnostic_file
  sandbox_name="$(resolve_default_sandbox_name)"
  agent_name="$(resolve_onboarded_agent)"
  agent_display="$(agent_display_name "$agent_name")"

  case "$agent_name" in
    hermes)
      if ! port="$(resolve_hermes_api_port "$sandbox_name")"; then
        error "Could not restore the Hermes forward because the registered API port for sandbox '$sandbox_name' is unavailable or invalid."
      fi
      ;;
    *) return 0 ;;
  esac

  if [[ -n "${NEMOCLAW_OPENSHELL_BIN:-}" && -x "$NEMOCLAW_OPENSHELL_BIN" ]]; then
    openshell_bin="$NEMOCLAW_OPENSHELL_BIN"
  elif command_exists openshell; then
    openshell_bin="$(command -v openshell)"
  else
    return 0
  fi
  if [[ "$openshell_bin" != /* ]]; then
    openshell_dir="${openshell_bin%/*}"
    [[ "$openshell_dir" == "$openshell_bin" ]] && openshell_dir="."
    openshell_dir="$(cd -- "$openshell_dir" && pwd -P)" || return 1
    openshell_bin="${openshell_dir}/${openshell_bin##*/}"
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

  redact_forward_start_diagnostic() {
    local redactor
    redactor="$(resolve_repo_root)/dist/lib/security/redact.js"
    if command_exists node && [[ -f "$redactor" ]] \
      && node -e '
        const fs = require("fs");
        const { redactFull } = require(process.argv[1]);
        process.stdout.write(redactFull(fs.readFileSync(0, "utf8")));
      ' "$redactor" 2>/dev/null; then
      return 0
    fi
    printf "<REDACTED>"
  }

  sanitize_forward_start_diagnostic() {
    if command_exists node && node -e '
      const fs = require("fs");
      const encoded = fs.readFileSync(0).toString("latin1")
        .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/g, "")
        .replace(/\x9D[\s\S]*?(?:\x07|\x1B\\|\x9C|$)/g, "")
        .replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1B[@-_]/g, "");
      const diagnostic = Buffer.from(encoded, "latin1").toString("utf8")
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
      process.stdout.write(diagnostic);
    ' 2>/dev/null; then
      return 0
    fi
    printf "<REDACTED>"
  }

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

  start_diagnostic=""
  diagnostic_file="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-forward-start-XXXXXX" 2>/dev/null)" \
    || diagnostic_file=""

  for attempt in 1 2 3; do
    stop_agent_forward_if_owned
    if [ "$attempt" -gt 1 ]; then
      sleep 2
    fi
    if [[ -n "$diagnostic_file" ]]; then
      "$openshell_bin" forward start --background "$port" "$sandbox_name" \
        >"$diagnostic_file" 2>&1 || true
      start_diagnostic="$(sanitize_forward_start_diagnostic <"$diagnostic_file" | awk '
        {
          gsub(/[[:space:]]+/, " ")
          sub(/^ /, "")
          sub(/ $/, "")
          if ($0 != "") joined = (joined == "" ? $0 : joined "; " $0)
        }
        END { printf "%s", joined }
      ' 2>/dev/null || true)"
      start_diagnostic="$(
        printf "%s" "$start_diagnostic" | redact_forward_start_diagnostic
      )"
      if [[ "${#start_diagnostic}" -gt 300 ]]; then
        start_diagnostic="${start_diagnostic:0:300} [truncated]"
      fi
    else
      "$openshell_bin" forward start --background "$port" "$sandbox_name" >/dev/null 2>&1 || true
    fi
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
function listedStatus() {
  const listed = spawnSync(openshellBin, ["forward", "list"], { encoding: "utf-8" });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return null;
  for (const line of listed.stdout.split("\n")) {
    const columns = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim().split(/\s+/);
    if (columns[0] === sandboxName && columns[2] === port) {
      return (columns[4] || "").toLowerCase();
    }
  }
  return "";
}
function tick() {
  if (healthy()) return;
  const status = listedStatus();
  if (status === null) return;
  if (status === "dead") {
    run(["forward", "stop", port, sandboxName]);
    run(["forward", "start", "--background", port, sandboxName]);
    return;
  }
  if (status === "") run(["forward", "start", "--background", port, sandboxName]);
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
      [[ -n "$diagnostic_file" ]] && rm -f "$diagnostic_file"
      return 0
    fi
    watcher_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if ! command_exists curl && [[ -n "$watcher_pid" ]] && kill -0 "$watcher_pid" >/dev/null 2>&1; then
      [[ -n "$diagnostic_file" ]] && rm -f "$diagnostic_file"
      return 0
    fi
    if [[ -n "$watcher_pid" ]]; then
      kill "$watcher_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
  done
  [[ -n "$diagnostic_file" ]] && rm -f "$diagnostic_file"

  warn "Could not restore ${agent_display} host forward on port ${port}."
  if [[ -n "$start_diagnostic" ]]; then
    warn "OpenShell reported: ${start_diagnostic}"
  fi
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
  printf "    --defer-onboarding   Install Hermes without onboarding when NVIDIA inference credentials are absent\n"
  printf "                          Use only with NEMOCLAW_AGENT=hermes, no registered sandboxes, no local model profile,\n"
  printf "                          and the build, cloud, or routed NVIDIA hosted provider\n"
  printf "    --fresh              Discard any failed/interrupted onboarding session and start over\n"
  printf "    --station-deepseek   Use DeepSeek V4 Flash for DGX Station express install (interactive terminal required)\n"
  printf "    --force-station-install Bypass only the DGX release-metadata allowlist for Station GB300 express install\n"
  printf "    --version, -v        Print installer version and exit\n"
  printf "    --help, -h           Show this help message and exit\n\n"
  printf "  ${C_DIM}Environment:${C_RESET}\n"
  printf "    NVIDIA_INFERENCE_API_KEY                API key (skips credential prompt)\n"
  printf "    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 Same as --yes-i-accept-third-party-software\n"
  printf "    NEMOCLAW_NON_INTERACTIVE=1    Same as --non-interactive\n"
  printf "    NEMOCLAW_DEFER_ONBOARDING=1   Same as --defer-onboarding\n"
  printf "                                  Use only with NEMOCLAW_AGENT=hermes, no registered sandboxes, no local model profile,\n"
  printf "                                  and the build, cloud, or routed NVIDIA hosted provider\n"
  printf "    NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt Allow sudo prompts during non-interactive onboarding\n"
  printf "    NEMOCLAW_FRESH=1              Same as --fresh\n"
  printf "    NEMOCLAW_NO_EXPRESS=1         Skip the Express prompt on detected platforms\n"
  printf "    NEMOCLAW_SANDBOX_NAME         Sandbox name to create/use\n"
  printf "    HF_TOKEN                      Optional Hugging Face read token for managed-vLLM downloads\n"
  printf "                                  Create one at https://huggingface.co/settings/tokens and export it before curl | bash.\n"
  printf "    HUGGING_FACE_HUB_TOKEN        Compatibility alias for HF_TOKEN\n"
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
  printf "                                  | hermes-provider | llama-cpp | install-llama-cpp\n"
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
  local notice_json version title prompt notice_body answer answer_lc answer_trimmed
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
  while true; do
    printf "  %s" "${prompt:-Type 'yes' to accept the NemoClaw license and third-party software notice and continue [no]: }"
    if ! IFS= read -r answer; then
      printf "\n  Installation cancelled\n" >&2
      return 1
    fi
    answer_lc="$(printf "%s" "$answer" | tr '[:upper:]' '[:lower:]')"
    if [[ "$answer_lc" == "yes" ]]; then
      break
    fi
    answer_trimmed="$(printf "%s" "$answer_lc" | tr -d '[:space:]')"
    if [[ "$answer_trimmed" == y* ]]; then
      printf "  Did you mean 'yes'? Type the full word 'yes' to accept.\n" >&2
      continue
    fi
    printf "  Installation cancelled\n" >&2
    return 1
  done

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
_NEMOCLAW_CLI_INSTALL_PREPARED=false
_NEMOCLAW_CLI_INSTALL_MODE=""
_OPENSHELL_INSTALL_REQUIRED_BEFORE_RECOVERY=false
_PREEXISTING_SANDBOX_COUNT=0
_PREEXISTING_SANDBOX_RECOVERY_RAN=false
# #6520: set when the automatic recovery pass exited 0 but skipped recorded
# sandboxes it could not observe on the selected gateway (e.g. their gateway
# and Docker image were removed by a prior uninstall while sandboxes.json was
# preserved). The final summary must not claim those sandboxes were recovered.
_PREEXISTING_SANDBOX_ORPHANED=false
_LEGACY_MANAGED_RECOVERY_NAMES_JSON="[]"
# OpenShell v0.0.106 routes sandbox and workspace identities through labels
# capped at 19 characters. Keep this installer-only raw-registry preflight in
# sync with NAME_MAX_LENGTH in nemoclaw/src/shared/sandbox-name.cts. The
# current CLI cannot be prepared safely until legacy names are checked.
_OPENSHELL_SANDBOX_NAME_MAX_LENGTH=19
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

prefer_homebrew_openshell() {
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  command -v brew >/dev/null 2>&1 || return 1
  if [[ "${1:-}" != "verified-install" ]]; then
    macos_openshell_homebrew_gateway_service_installed || return 1
  fi

  local brew_prefix openshell_bin gateway_bin
  brew_prefix="$(brew --prefix 2>/dev/null)" || return 1
  [ -n "$brew_prefix" ] || return 1
  openshell_bin="${brew_prefix%/}/bin/openshell"
  gateway_bin="${brew_prefix%/}/bin/openshell-gateway"
  [ -x "$openshell_bin" ] && [ -x "$gateway_bin" ] || return 1
  export NEMOCLAW_OPENSHELL_BIN="$openshell_bin"
  export NEMOCLAW_OPENSHELL_GATEWAY_BIN="$gateway_bin"
  export PATH="${brew_prefix%/}/bin:$PATH"
}

observed_macos_openshell_install_method() {
  if command -v brew >/dev/null 2>&1; then
    printf '%s\n' "homebrew"
  else
    printf '%s\n' "standalone"
  fi
}

prefer_user_local_openshell() {
  local local_bin="${XDG_BIN_HOME:-${HOME}/.local/bin}"
  local openshell_bin="${local_bin}/openshell"
  local gateway_bin="${local_bin}/openshell-gateway"
  if [[ "${1:-}" == "verified-install" ]]; then
    [[ "$local_bin" == /* ]] || return 1
    [[ -x "$openshell_bin" && -x "$gateway_bin" ]] || return 1
    export NEMOCLAW_OPENSHELL_BIN="$openshell_bin"
    export NEMOCLAW_OPENSHELL_GATEWAY_BIN="$gateway_bin"
    if [[ ":$PATH:" != *":$local_bin:"* ]]; then
      export PATH="$local_bin:$PATH"
    fi
    return 0
  fi
  if [[ -x "$openshell_bin" ]]; then
    export NEMOCLAW_OPENSHELL_BIN="$openshell_bin"
    if [[ ":$PATH:" != *":$local_bin:"* ]]; then
      export PATH="$local_bin:$PATH"
    fi
  fi
}

NEMOCLAW_GATEWAY_SERVICE_MARKER="NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1"
NEMOCLAW_GATEWAY_SERVICE_MARKER_LINE="# ${NEMOCLAW_GATEWAY_SERVICE_MARKER}"
NEMOCLAW_GATEWAY_SERVICE_NAME="nemoclaw-openshell-gateway"
UPSTREAM_OPENSHELL_GATEWAY_SERVICE_BIN=""
UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR=""

upstream_openshell_gateway_user_service_installed() {
  [[ "$(uname -s)" == "Linux" ]] || return 1
  [[ -f /usr/local/lib/systemd/user/openshell-gateway.service ]] \
    || [[ -f /usr/lib/systemd/user/openshell-gateway.service ]] \
    || [[ -f /lib/systemd/user/openshell-gateway.service ]]
}

resolve_openshell_gateway_bin_for_user_service() {
  local service_name="${1:-}" exec_start gateway_bin
  local -a gateway_bins=()
  case "$service_name" in
    openshell-gateway.service | "${NEMOCLAW_GATEWAY_SERVICE_NAME}.service") ;;
    *) return 1 ;;
  esac
  exec_start="$(systemctl --user show "$service_name" --property=ExecStart --value 2>/dev/null)" \
    || return 1
  while IFS= read -r gateway_bin; do
    gateway_bins+=("$gateway_bin")
  done < <(
    printf '%s\n' "$exec_start" \
      | grep -oE 'path=[^ ;}]+' \
      | sed 's/^path=//'
  )
  [[ "${#gateway_bins[@]}" -eq 1 ]] || return 1
  gateway_bin="${gateway_bins[0]}"
  [[ "$gateway_bin" == /*/openshell-gateway && -x "$gateway_bin" ]] || return 1
  printf '%s\n' "$gateway_bin"
}

systemd_user_manager_unavailable_diagnostic() {
  local diagnostic="${1:-}" line recognized=0
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in
      "") ;;
      "Failed to connect to bus: No medium found" | \
        "Failed to connect to bus: Host is down" | \
        "Failed to connect to bus: No such file or directory" | \
        "System has not been booted with systemd as init system (PID 1). Can't operate." | \
        "XDG_RUNTIME_DIR is not set in the environment." | \
        "Failed to connect to bus: \$DBUS_SESSION_BUS_ADDRESS and \$XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)")
        recognized=1
        ;;
      *) return 1 ;;
    esac
  done <<<"$diagnostic"
  [[ "$recognized" -eq 1 ]]
}

trusted_upstream_openshell_gateway_unit_for_service() {
  case "${1:-}" in
    /usr/local/lib/systemd/user/openshell-gateway.service | \
      /usr/lib/systemd/user/openshell-gateway.service | \
      /lib/systemd/user/openshell-gateway.service)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

trusted_upstream_openshell_gateway_bin_for_service() {
  case "${1:-}" in
    /usr/local/bin/openshell-gateway | /usr/bin/openshell-gateway)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

inspect_upstream_openshell_gateway_user_service() {
  local service_output service_status line fragment_path="" exec_start="" gateway_bin
  local fragment_count=0 exec_start_count=0
  local -a gateway_bins=()
  UPSTREAM_OPENSHELL_GATEWAY_SERVICE_BIN=""
  UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR=""

  if service_output="$(LC_ALL=C systemctl --user show openshell-gateway.service \
    --property=FragmentPath --property=ExecStart 2>&1)"; then
    :
  else
    service_status=$?
    UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR="systemctl --user show openshell-gateway.service failed: ${service_output:-exit ${service_status}}"
    if systemd_user_manager_unavailable_diagnostic "$service_output"; then
      return 2
    fi
    return 1
  fi

  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in
      FragmentPath=*)
        fragment_path="${line#FragmentPath=}"
        fragment_count=$((fragment_count + 1))
        ;;
      ExecStart=*)
        exec_start="${line#ExecStart=}"
        exec_start_count=$((exec_start_count + 1))
        ;;
      "") ;;
      *)
        UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR="The effective upstream OpenShell gateway service returned unexpected metadata."
        return 1
        ;;
    esac
  done <<<"$service_output"

  if [[ "$fragment_count" -ne 1 || "$exec_start_count" -ne 1 ]]; then
    UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR="The effective upstream OpenShell gateway service did not return one FragmentPath and one ExecStart value."
    return 1
  fi
  if ! trusted_upstream_openshell_gateway_unit_for_service "$fragment_path"; then
    UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR="The effective upstream OpenShell gateway unit path is not trusted: ${fragment_path:-<empty>}"
    return 1
  fi

  while IFS= read -r gateway_bin; do
    gateway_bins+=("$gateway_bin")
  done < <(
    printf '%s\n' "$exec_start" \
      | grep -oE 'path=[^ ;}]+' \
      | sed 's/^path=//'
  )
  if [[ "${#gateway_bins[@]}" -ne 1 ]]; then
    UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR="The effective upstream OpenShell gateway service did not return one executable path."
    return 1
  fi
  gateway_bin="${gateway_bins[0]}"
  if ! trusted_upstream_openshell_gateway_bin_for_service "$gateway_bin"; then
    UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR="The effective upstream OpenShell gateway executable path is not trusted: $gateway_bin"
    return 1
  fi
  if [[ ! -x "$gateway_bin" ]]; then
    UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR="The effective upstream OpenShell gateway executable is unavailable: $gateway_bin"
    return 1
  fi

  UPSTREAM_OPENSHELL_GATEWAY_SERVICE_BIN="$gateway_bin"
}

resolve_upstream_openshell_gateway_bin_for_service() {
  if inspect_upstream_openshell_gateway_user_service; then
    printf '%s\n' "$UPSTREAM_OPENSHELL_GATEWAY_SERVICE_BIN"
  else
    return $?
  fi
}

openshell_binary_version() {
  local binary="${1:-}" version_output
  [[ -x "$binary" ]] || return 1
  version_output="$("$binary" --version 2>/dev/null)" || return 1
  printf '%s\n' "$version_output" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

require_compatible_upstream_openshell_gateway_service() {
  local nemoclaw_gateway_bin upstream_gateway_bin nemoclaw_version upstream_version inspect_status
  if inspect_upstream_openshell_gateway_user_service; then
    upstream_gateway_bin="$UPSTREAM_OPENSHELL_GATEWAY_SERVICE_BIN"
  else
    inspect_status=$?
    if [[ "$inspect_status" -eq 2 ]]; then
      return 2
    fi
    error "Could not inspect the effective upstream OpenShell gateway user service. ${UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR} Repair that OpenShell installation, then rerun the installer."
  fi
  nemoclaw_gateway_bin="$(resolve_openshell_gateway_bin_for_service)" \
    || error "Could not locate the NemoClaw OpenShell gateway binary before checking the existing upstream service."
  if ! trusted_openshell_gateway_bin_for_service "$nemoclaw_gateway_bin"; then
    error "OpenShell gateway user service binary path is not a trusted install path: $nemoclaw_gateway_bin"
  fi
  nemoclaw_version="$(openshell_binary_version "$nemoclaw_gateway_bin")" \
    || error "Could not determine the NemoClaw OpenShell gateway version at $nemoclaw_gateway_bin."
  upstream_version="$(openshell_binary_version "$upstream_gateway_bin")" \
    || error "Could not determine the existing upstream OpenShell gateway version at $upstream_gateway_bin."
  if [[ "$nemoclaw_version" != "$upstream_version" ]]; then
    error "OpenShell gateway version mismatch: NemoClaw installed ${nemoclaw_version} at ${nemoclaw_gateway_bin}, but the existing upstream user service uses ${upstream_version} at ${upstream_gateway_bin}. Align or remove the upstream OpenShell package (for apt installs: sudo apt remove openshell), then rerun the installer."
  fi
}

macos_openshell_homebrew_gateway_service_installed() {
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  command -v brew >/dev/null 2>&1 || return 1
  brew list --formula openshell >/dev/null 2>&1 || return 1
  brew info --json=v2 openshell 2>/dev/null \
    | grep -Eq '"tap"[[:space:]]*:[[:space:]]*"nvidia/openshell"'
}

resolve_openshell_gateway_bin_for_service() {
  local gateway_bin="${NEMOCLAW_OPENSHELL_GATEWAY_BIN:-}"
  if [[ -n "$gateway_bin" && -x "$gateway_bin" ]]; then
    printf "%s\n" "$gateway_bin"
    return 0
  fi

  gateway_bin="$(command -v openshell-gateway 2>/dev/null || true)"
  [[ -n "$gateway_bin" && -x "$gateway_bin" ]] || return 1
  printf "%s\n" "$gateway_bin"
}

trusted_openshell_gateway_bin_for_service() {
  local gateway_bin="${1:-}"
  local user_bin_home="${XDG_BIN_HOME:-${HOME}/.local/bin}"
  if [[ "$user_bin_home" != /* ]]; then
    user_bin_home="${HOME}/.local/bin"
  fi
  user_bin_home="${user_bin_home%/}"
  case "$gateway_bin" in
    "${user_bin_home}/openshell-gateway" | /usr/local/bin/openshell-gateway | /usr/bin/openshell-gateway)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_nemoclaw_openshell_gateway_user_service() {
  local service_path="${1:-}"
  [[ -f "$service_path" ]] || return 1
  grep -Fxq "$NEMOCLAW_GATEWAY_SERVICE_MARKER_LINE" "$service_path"
}

openshell_user_config_home() {
  if [[ -n "${XDG_CONFIG_HOME:-}" && "$XDG_CONFIG_HOME" == /* ]]; then
    printf '%s\n' "$XDG_CONFIG_HOME"
  else
    printf '%s\n' "${HOME}/.config"
  fi
}

enabled_openshell_gateway_user_service_activation_path() {
  local user_config_home user_data_home runtime_dir unit_root activation_dir service_name activation_path
  local config_dirs data_dirs directory
  local -a unit_roots=()
  if [[ -n "${SYSTEMD_UNIT_PATH:-}" ]]; then
    printf 'SYSTEMD_UNIT_PATH=%q\n' "$SYSTEMD_UNIT_PATH"
    return 2
  fi
  user_config_home="$(openshell_user_config_home)"
  user_data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"
  if [[ "$user_data_home" != /* ]]; then
    printf '%s\n' "$user_data_home"
    return 2
  fi
  unit_roots+=(
    "${user_config_home}/systemd/user"
    "${user_config_home}/systemd/user.control"
    "${user_data_home%/}/systemd/user"
    "/etc/systemd/user"
    "/run/systemd/user"
    "/usr/local/lib/systemd/user"
    "/usr/lib/systemd/user"
    "/lib/systemd/user"
  )
  config_dirs="${XDG_CONFIG_DIRS:-/etc/xdg}"
  data_dirs="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
  local IFS=:
  for directory in $config_dirs $data_dirs; do
    [[ -n "$directory" ]] || continue
    if [[ "$directory" != /* ]]; then
      printf '%s\n' "$directory"
      return 2
    fi
    unit_roots+=("${directory%/}/systemd/user")
  done
  runtime_dir="${XDG_RUNTIME_DIR:-}"
  if [[ "$runtime_dir" != /* && "${UID:-}" =~ ^[0-9]+$ ]]; then
    runtime_dir="/run/user/${UID}"
  fi
  if [[ "$runtime_dir" == /* ]]; then
    unit_roots+=(
      "${runtime_dir%/}/systemd/user.control"
      "${runtime_dir%/}/systemd/transient"
      "${runtime_dir%/}/systemd/generator.early"
      "${runtime_dir%/}/systemd/user"
      "${runtime_dir%/}/systemd/generator"
      "${runtime_dir%/}/systemd/generator.late"
    )
  fi

  for unit_root in "${unit_roots[@]}"; do
    if [[ -e "$unit_root" || -L "$unit_root" ]]; then
      if [[ ! -d "$unit_root" || ! -r "$unit_root" || ! -x "$unit_root" ]]; then
        printf '%s\n' "$unit_root"
        return 2
      fi
    fi
    for activation_dir in "$unit_root"/*.wants "$unit_root"/*.requires "$unit_root"/*.upholds; do
      if [[ -L "$activation_dir" && ! -d "$activation_dir" ]]; then
        printf '%s\n' "$activation_dir"
        return 2
      fi
      [[ -d "$activation_dir" ]] || continue
      if [[ ! -r "$activation_dir" || ! -x "$activation_dir" ]]; then
        printf '%s\n' "$activation_dir"
        return 2
      fi
      for service_name in openshell-gateway "${NEMOCLAW_GATEWAY_SERVICE_NAME}"; do
        activation_path="${activation_dir}/${service_name}.service"
        if [[ -e "$activation_path" || -L "$activation_path" ]]; then
          printf '%s\n' "$activation_path"
          return 0
        fi
      done
    done
  done
  return 1
}

install_nemoclaw_openshell_gateway_user_service() {
  [[ "$(uname -s)" == "Linux" ]] || return 0
  [[ "$(resolve_nemoclaw_gateway_port)" -eq 8080 ]] || return 0

  local service_dir
  service_dir="$(openshell_user_config_home)/systemd/user"
  local service_path="${service_dir}/${NEMOCLAW_GATEWAY_SERVICE_NAME}.service"
  local service_template="${NEMOCLAW_SOURCE_ROOT}/scripts/lib/openshell-gateway.service.in"

  if [[ -L "$service_path" ]]; then
    error "Refusing to replace symlinked OpenShell gateway user service: $service_path"
  fi

  if upstream_openshell_gateway_user_service_installed; then
    if [[ -f "$service_path" ]] && ! is_nemoclaw_openshell_gateway_user_service "$service_path"; then
      error "Refusing to replace non-NemoClaw OpenShell gateway user service: $service_path"
    fi
    local compatibility_status activation_path activation_status
    if require_compatible_upstream_openshell_gateway_service; then
      info "OpenShell upstream gateway user service is staged; onboarding will select and start it."
      return 0
    else
      compatibility_status=$?
    fi
    if [[ "$compatibility_status" -ne 2 ]]; then
      error "Could not determine whether the effective upstream OpenShell gateway user service is compatible."
    fi
    if activation_path="$(enabled_openshell_gateway_user_service_activation_path)"; then
      error "The systemd user manager is unavailable, but $activation_path can activate a gateway user service that can later claim port 8080. Restore the systemd user manager and inspect or disable that service before rerunning NemoClaw. The installer did not change the unit or activation path."
    else
      activation_status=$?
      if [[ "$activation_status" -eq 2 ]]; then
        error "The systemd user manager is unavailable, and the installer could not inspect OpenShell gateway activation configuration at $activation_path. Restore the default unit search path or access to that location, then rerun NemoClaw."
      fi
    fi
    warn "The systemd user manager is unavailable. No enabled OpenShell gateway user service activation path was found, so onboarding will keep the existing standalone gateway on port 8080."
    return 0
  fi

  local gateway_bin
  if ! gateway_bin="$(resolve_openshell_gateway_bin_for_service)"; then
    warn "OpenShell gateway binary was not found; the default managed user service was not staged."
    return 0
  fi

  case "$gateway_bin" in
    *[[:space:]]*)
      error "OpenShell gateway user service binary path contains whitespace: $gateway_bin"
      ;;
    /*) ;;
    *)
      error "OpenShell gateway user service binary path is not absolute: $gateway_bin"
      ;;
  esac
  if ! trusted_openshell_gateway_bin_for_service "$gateway_bin"; then
    error "OpenShell gateway user service binary path is not a trusted install path: $gateway_bin"
  fi

  if [[ -f "$service_path" ]] && ! is_nemoclaw_openshell_gateway_user_service "$service_path"; then
    error "Refusing to replace non-NemoClaw OpenShell gateway user service: $service_path"
  fi
  if [[ ! -f "$service_template" || -L "$service_template" ]]; then
    error "OpenShell gateway user service template is unavailable: $service_template"
  fi

  if ! {
    mkdir -p "$service_dir" \
      && chmod 700 "$service_dir" \
      && node - "$service_path" "$service_template" "$gateway_bin" "$NEMOCLAW_GATEWAY_SERVICE_MARKER_LINE" <<'NODE'
const fs = require("node:fs");

const [servicePath, templatePath, gatewayBin, managedMarker] = process.argv.slice(2);
const noFollow = fs.constants.O_NOFOLLOW;
const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;

if (typeof noFollow !== "number") {
  console.error("O_NOFOLLOW is unavailable");
  process.exit(1);
}

function errnoCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : null;
}

function fail(message) {
  throw new Error(message);
}

function openServiceFile() {
  try {
    return fs.openSync(servicePath, fs.constants.O_RDWR | noFollow | nonblock);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      fail(`Refusing to replace symlinked OpenShell gateway user service: ${servicePath}`);
    }
    if (errnoCode(error) !== "ENOENT") throw error;
  }

  try {
    return fs.openSync(
      servicePath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow | nonblock,
      0o600,
    );
  } catch (error) {
    if (errnoCode(error) === "ELOOP" || errnoCode(error) === "EEXIST") {
      fail(
        `Refusing to replace OpenShell gateway user service because it changed during validation: ${servicePath}`,
      );
    }
    throw error;
  }
}

function assertServiceIdentity(descriptor) {
  const opened = fs.fstatSync(descriptor);
  const current = fs.lstatSync(servicePath);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1 ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    fail(
      `Refusing to replace OpenShell gateway user service because it changed during validation: ${servicePath}`,
    );
  }
}

let descriptor;
try {
  descriptor = openServiceFile();
  assertServiceIdentity(descriptor);
  const existing = fs.readFileSync(descriptor, "utf8");
  if (existing && !existing.split(/\r?\n/u).includes(managedMarker)) {
    fail(`Refusing to replace non-NemoClaw OpenShell gateway user service: ${servicePath}`);
  }
  const contents = fs
    .readFileSync(templatePath, "utf8")
    .replaceAll("@OPENSHELL_GATEWAY_BIN@", gatewayBin);
  assertServiceIdentity(descriptor);
  const bytes = Buffer.from(contents, "utf8");
  const written = fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
  if (written !== bytes.length) {
    fail("Short write while installing OpenShell gateway user service");
  }
  fs.ftruncateSync(descriptor, bytes.length);
  fs.fchmodSync(descriptor, 0o600);
  assertServiceIdentity(descriptor);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor);
}
NODE
  }; then
    error "Could not install OpenShell gateway user service at $service_path"
  fi

  info "Installed OpenShell gateway user service at $service_path"
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
  local explicit_openshell_bin="${NEMOCLAW_OPENSHELL_BIN:-}"
  local platform macos_install_method="" observed_install_method=""
  platform="$(uname -s)" || return 1
  if truthy_env "${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}"; then
    info "Deferring OpenShell CLI installation until after pre-upgrade backup."
    return 0
  fi
  if [[ "$mode" == "if-missing" ]] && command_exists openshell; then
    if [[ "$platform" == "Darwin" ]] && command -v brew >/dev/null 2>&1 \
      && ! macos_openshell_homebrew_gateway_service_installed; then
      info "OpenShell CLI exists but the macOS Homebrew gateway service is missing."
    else
      if [[ "$platform" == "Darwin" ]] && ! command -v brew >/dev/null 2>&1; then
        warn "Homebrew is not installed; using the standalone OpenShell gateway without reboot persistence."
      fi
      prefer_homebrew_openshell || prefer_user_local_openshell
      # Service discovery uses the selected OpenShell PATH, but a source-checkout
      # caller's explicit executable selection remains authoritative for onboarding.
      if [[ "$explicit_openshell_bin" == /* && -f "$explicit_openshell_bin" && -x "$explicit_openshell_bin" ]]; then
        export NEMOCLAW_OPENSHELL_BIN="$explicit_openshell_bin"
      fi
      install_nemoclaw_openshell_gateway_user_service
      return 0
    fi
  fi
  if [[ "$platform" == "Darwin" ]]; then
    macos_install_method="$(observed_macos_openshell_install_method)" || return 1
  fi
  if ! _NEMOCLAW_OPENSHELL_INSTALL_METHOD="$macos_install_method" \
    spin "Installing OpenShell CLI" bash "${NEMOCLAW_SOURCE_ROOT}/scripts/install-openshell.sh"; then
    return 1
  fi
  if [[ "$platform" == "Darwin" ]]; then
    observed_install_method="$(observed_macos_openshell_install_method)" || return 1
    [[ "$observed_install_method" == "$macos_install_method" ]] \
      || error "The macOS OpenShell installation method changed while installation was running. The installer stopped before selecting OpenShell binaries or recovering the gateway."
    case "$macos_install_method" in
      homebrew)
        # install-openshell.sh returned success only after verifying and installing
        # the pinned formula, so this does not re-read the untrusted tap formula.
        prefer_homebrew_openshell verified-install \
          || error "The verified Homebrew OpenShell installation did not provide executable CLI and gateway binaries. The installer stopped before gateway recovery."
        ;;
      standalone)
        prefer_user_local_openshell verified-install \
          || error "The verified standalone OpenShell installation did not provide trusted executable user-local CLI and gateway binaries. The installer stopped before gateway recovery."
        warn "Homebrew is not installed; using the verified standalone OpenShell gateway without reboot persistence."
        ;;
      *)
        error "The macOS OpenShell installation method could not be verified. The installer stopped before selecting OpenShell binaries or recovering the gateway."
        ;;
    esac
  else
    prefer_user_local_openshell
  fi
  install_nemoclaw_openshell_gateway_user_service
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
[[ "\$(command -v node 2>/dev/null)" == "$node_path" ]] || export PATH="$node_dir:\$PATH"
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
    rm -f "$nvm_tmp"
    error "No SHA-256 tool available (sha256sum/shasum)"
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

  if [[ ":$PATH:" != *":$HOME/.npm-global/bin:"* ]]; then
    export PATH="$HOME/.npm-global/bin:$PATH"
  fi
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

installer_payload_revision() {
  local revision=""
  revision="$(git -C "${SCRIPT_DIR}/.." rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || return 1
  [[ "$revision" =~ ^[0-9a-f]{40,64}$ ]] || return 1
  printf '%s' "$revision"
}

path_resolves_within() {
  local parent="$1" candidate="$2"
  node -e '
    const fs = require("fs");
    const path = require("path");
    try {
      const parent = fs.realpathSync(process.argv[1]);
      const candidate = fs.realpathSync(process.argv[2]);
      const relative = path.relative(parent, candidate);
      process.exit(
        relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? 0 : 1,
      );
    } catch {
      process.exit(1);
    }
  ' "$parent" "$candidate"
}

resolve_cli_runner_within_source() {
  local source_root="$1" candidate="" npm_bin=""
  if command_exists "$_CLI_BIN"; then
    candidate="$(command -v "$_CLI_BIN")"
    if is_real_nemoclaw_cli "$candidate" "$_CLI_BIN" \
      && path_resolves_within "$source_root" "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  fi

  npm_bin="$(resolve_npm_bin)" || true
  candidate="${npm_bin:+${npm_bin}/${_CLI_BIN}}"
  if [[ -n "$candidate" && -x "$candidate" ]] \
    && is_real_nemoclaw_cli "$candidate" "$_CLI_BIN" \
    && path_resolves_within "$source_root" "$candidate"; then
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}

is_reusable_managed_nemoclaw_install() {
  local source_root="$1" expected_revision current_revision identity_file identity_revision
  local identity_version cli_runner version_output

  [[ "${NEMOCLAW_BOOTSTRAP_PAYLOAD:-}" == "1" ]] || return 1
  ! truthy_env "${NEMOCLAW_REINSTALL_CLI:-}" || return 1
  [[ -d "$source_root" && ! -L "$source_root" && -O "$source_root" ]] || return 1
  [[ -d "${source_root}/.git" && ! -L "${source_root}/.git" ]] || return 1
  grep -q '"name"[[:space:]]*:[[:space:]]*"nemoclaw"' "${source_root}/package.json" 2>/dev/null || return 1

  expected_revision="$(installer_payload_revision)" || return 1
  current_revision="$(git -C "$source_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" || return 1
  [[ "$current_revision" == "$expected_revision" ]] || return 1
  git -C "$source_root" diff --quiet --ignore-submodules -- || return 1
  git -C "$source_root" diff --cached --quiet --ignore-submodules -- || return 1
  [[ -d "${source_root}/node_modules" && -d "${source_root}/nemoclaw/node_modules" ]] || return 1

  identity_file="${source_root}/dist/build-identity.json"
  [[ -f "$identity_file" && -s "${source_root}/dist/lib/onboard/preflight.js" ]] || return 1
  [[ -s "${source_root}/nemoclaw/dist/index.js" ]] || return 1
  identity_revision="$(json_string_field "$identity_file" sourceRevision)"
  identity_version="$(json_string_field "$identity_file" nemoclawVersion)"
  [[ "$identity_revision" == "$expected_revision" ]] || return 1
  [[ "$identity_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$ ]] || return 1

  cli_runner="$(resolve_cli_runner_within_source "$source_root")" || return 1
  version_output="$("$cli_runner" --version 2>/dev/null)" || return 1
  [[ "$version_output" == "${_CLI_BIN} v${identity_version}" ]]
}

restore_managed_source_lockfile() {
  local source_root="$1"
  [[ -d "${source_root}/.git" && ! -L "${source_root}/.git" ]] || return 0
  git -C "$source_root" checkout -- package-lock.json 2>/dev/null
}

finish_nemoclaw_install() {
  # A backup-preparation pass defers OpenShell but still prepares the CLI. The
  # later install pass completes only the OpenShell policy for that source mode.
  # Once an out-of-range gateway has been retired, install its replacement
  # before recovery can restart the service, including from a source checkout.
  case "${_NEMOCLAW_CLI_INSTALL_MODE:-}" in
    source | managed) ;;
    *) error "The prepared ${_CLI_DISPLAY} CLI has no installation mode." ;;
  esac
  if [[ "${_OPENSHELL_INSTALL_REQUIRED_BEFORE_RECOVERY:-false}" == true ]]; then
    local old_defer="${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}"
    local defer_was_set="${NEMOCLAW_DEFER_OPENSHELL_INSTALL+1}"
    local defer_declaration="" defer_was_exported=false
    if [[ -n "$defer_was_set" ]]; then
      defer_declaration="$(declare -p NEMOCLAW_DEFER_OPENSHELL_INSTALL 2>/dev/null || true)"
      [[ "$defer_declaration" == declare\ -x* ]] && defer_was_exported=true
    fi
    local openshell_install_status=0
    unset NEMOCLAW_DEFER_OPENSHELL_INSTALL
    maybe_install_openshell_during_install force || openshell_install_status=$?
    if [[ -n "$defer_was_set" ]]; then
      NEMOCLAW_DEFER_OPENSHELL_INSTALL="$old_defer"
      [[ "$defer_was_exported" == true ]] && export NEMOCLAW_DEFER_OPENSHELL_INSTALL
    fi
    if [[ "$openshell_install_status" -ne 0 ]]; then
      local retry_gateway_port retry_gateway_port_env=""
      retry_gateway_port="$(resolve_nemoclaw_gateway_port)"
      if [ "$retry_gateway_port" -ne 8080 ]; then
        retry_gateway_port_env="NEMOCLAW_GATEWAY_PORT=${retry_gateway_port} "
      fi
      error "Could not install the OpenShell version pinned by the prepared source after retiring the gateway. The installer preserved the sandbox backups and did not start recovery. Rerun the installer with ${retry_gateway_port_env}NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1 to reuse the prepared upgrade state and retry the OpenShell install."
    fi
    _OPENSHELL_INSTALL_REQUIRED_BEFORE_RECOVERY=false
  else
    case "${_NEMOCLAW_CLI_INSTALL_MODE:-}" in
      source) maybe_install_openshell_during_install if-missing ;;
      managed) maybe_install_openshell_during_install force ;;
    esac
  fi
  refresh_path
  ensure_nemoclaw_shim || true
}

install_nemoclaw() {
  command_exists git || error "git was not found on PATH."
  local repo_root package_json
  repo_root="$(resolve_repo_root)"
  package_json="${repo_root}/package.json"
  # Tell prepare not to run npm link — the installer handles linking explicitly.
  export NEMOCLAW_INSTALLING=1

  if [[ "${_NEMOCLAW_CLI_INSTALL_PREPARED:-false}" == true ]]; then
    info "${_CLI_DISPLAY} CLI was already prepared during this installer run — reusing it."
    unset NEMOCLAW_REINSTALL_CLI
    finish_nemoclaw_install
    return 0
  fi

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
    spin "Linking ${_CLI_DISPLAY} CLI" bash -c "cd \"$NEMOCLAW_SOURCE_ROOT\" && npm link --ignore-scripts"

    _NEMOCLAW_CLI_INSTALL_MODE=source
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
    local nemoclaw_src
    ensure_nemoclaw_state_dir >/dev/null \
      || error "Could not prepare owner-only NemoClaw state for the managed CLI installation."
    nemoclaw_src="$(nemoclaw_state_root)/source"
    NEMOCLAW_SOURCE_ROOT="$nemoclaw_src"
    if is_reusable_managed_nemoclaw_install "$nemoclaw_src"; then
      info "Reusing the installed ${_CLI_DISPLAY} CLI at the selected revision."
    else
      rm -rf "$nemoclaw_src"
      mkdir -p "$(dirname "$nemoclaw_src")"
      spin "Cloning ${_CLI_DISPLAY} source" clone_nemoclaw_ref "$release_ref" "$nemoclaw_src"
      # Fetch version tags into the shallow clone so `git describe --tags
      # --match "v*"` works at runtime (the shallow clone only has the
      # single ref we asked for).
      git -C "$nemoclaw_src" fetch --depth=1 origin 'refs/tags/v*:refs/tags/v*' 2>/dev/null || true
      # Stamp .version from the requested ref so the recorded version matches the
      # installed tag, even when a shallow clone cannot name it via describe.
      local stamped_version
      stamped_version="$(resolve_stamped_version "$release_ref")"
      if [[ -n "$stamped_version" ]]; then
        printf '%s' "$stamped_version" >"$nemoclaw_src/.version"
      else
        git -C "$nemoclaw_src" describe --tags --match 'v*' 2>/dev/null \
          | sed 's/^v//' >"$nemoclaw_src/.version" || true
      fi
      if [[ -z "${NEMOCLAW_AGENT:-}" || "${NEMOCLAW_AGENT}" == "openclaw" ]]; then
        spin "Preparing OpenClaw package" bash -c "$(declare -f info warn resolve_openclaw_version pre_extract_openclaw); pre_extract_openclaw \"\$1\"" _ "$nemoclaw_src" \
          || warn "Pre-extraction failed — npm install may fail if openclaw tarball is broken"
      fi
      spin "Installing ${_CLI_DISPLAY} dependencies" bash -c "cd \"$nemoclaw_src\" && npm install --ignore-scripts"
      spin "Building ${_CLI_DISPLAY} CLI modules" bash -c "cd \"$nemoclaw_src\" && npm run --if-present build:cli"
      spin "Building ${_CLI_DISPLAY} plugin" bash -c "cd \"$nemoclaw_src\"/nemoclaw && npm ci --ignore-scripts && npm run build"
      spin "Linking ${_CLI_DISPLAY} CLI" bash -c "cd \"$nemoclaw_src\" && npm link --ignore-scripts"
      restore_managed_source_lockfile "$nemoclaw_src" \
        || warn "Could not restore package-lock.json in ${nemoclaw_src} — the next install re-clones that checkout instead of reusing it."
    fi
    _NEMOCLAW_CLI_INSTALL_MODE=managed
  fi

  _NEMOCLAW_CLI_INSTALL_PREPARED=true
  unset NEMOCLAW_REINSTALL_CLI
  finish_nemoclaw_install
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

  # The active npm prefix can differ from the CLI installation prefix. The
  # user-local shim can remain executable when the active prefix has no CLI.
  # Probe the shim before reporting that installation failed (#8311).
  if [[ -x "$NEMOCLAW_SHIM_DIR/$_CLI_BIN" ]] \
    && is_real_nemoclaw_cli "$NEMOCLAW_SHIM_DIR/$_CLI_BIN" "$_CLI_BIN"; then
    _CLI_PATH="$NEMOCLAW_SHIM_DIR/$_CLI_BIN"
    record_cli_resolution_state "$_CLI_PATH" "$npm_bin"

    # record_cli_resolution_state clears the refresh flag when the shim
    # directory is on the initial PATH. A different command can resolve first.
    # In that case, NEMOCLAW_READY_NOW must remain false.
    if [[ "$(command -v "$_CLI_BIN" 2>/dev/null)" -ef "$_CLI_PATH" ]]; then
      NEMOCLAW_READY_NOW=true
      info "Verified: ${_CLI_BIN} is available at $_CLI_PATH"
      return 0
    fi

    NEMOCLAW_CURRENT_SHELL_NEEDS_PATH_REFRESH=true
    NEMOCLAW_RECOVERY_EXPORT_DIR="${NEMOCLAW_RECOVERY_EXPORT_DIR:-$NEMOCLAW_SHIM_DIR}"
    NEMOCLAW_RECOVERY_PROFILE="${NEMOCLAW_RECOVERY_PROFILE:-$(detect_shell_profile)}"
    warn "Found ${_CLI_BIN} at $_CLI_PATH but this shell's PATH does not yet resolve it."
    warn "Running onboarding via the absolute path; refresh your shell PATH afterwards (commands below)."
    return 0
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
  node - "$reg_file" "$field" "$gateway_port" "$scope" "$_OPENSHELL_SANDBOX_NAME_MAX_LENGTH" <<'NODE'
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
const maxNameLength = Number(process.argv[6]);
if (!Number.isInteger(maxNameLength) || maxNameLength < 1) process.exit(1);
// Keep this raw-registry predicate in sync with isRouteOnlySandboxReservation()
// in src/lib/state/registry.ts.
const sandboxes = entries.filter(
  ([, entry]) => !(entry.pendingRouteReservation === true && entry.createdAt === undefined),
);

if (process.argv[3] === "count") {
  process.stdout.write(String(sandboxes.length));
  process.exit(0);
}
if (process.argv[3] === "incompatible-names") {
  const compatiblePattern = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
  const incompatible = sandboxes
    .map(([name]) => name)
    .filter(
      (name) =>
        name.length > maxNameLength || !compatiblePattern.test(name) || name.includes("--"),
    )
    .sort();
  process.stdout.write(JSON.stringify(incompatible));
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
  local old_defer="${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}"
  local defer_was_set="${NEMOCLAW_DEFER_OPENSHELL_INSTALL+1}"
  local defer_declaration="" defer_was_exported=false
  if [[ -n "$defer_was_set" ]]; then
    defer_declaration="$(declare -p NEMOCLAW_DEFER_OPENSHELL_INSTALL 2>/dev/null || true)"
    [[ "$defer_declaration" == declare\ -x* ]] && defer_was_exported=true
  fi
  info "Preparing current ${_CLI_DISPLAY} CLI for pre-upgrade backup…"
  export NEMOCLAW_DEFER_OPENSHELL_INSTALL=1
  install_nemoclaw
  unset NEMOCLAW_DEFER_OPENSHELL_INSTALL
  if [[ -n "$defer_was_set" ]]; then
    NEMOCLAW_DEFER_OPENSHELL_INSTALL="$old_defer"
    [[ "$defer_was_exported" == true ]] && export NEMOCLAW_DEFER_OPENSHELL_INSTALL
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

# Return nonzero when OpenShell is absent or its version command fails.
installed_openshell_version() {
  command_exists openshell || return 1
  local version_output
  version_output="$(openshell --version 2>/dev/null)" || return 1
  printf "%s\n" "$version_output" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

# Fail closed when OpenShell is present but cannot report its version. An absent
# binary is valid because OpenShell installation can be deferred.
require_reportable_openshell_version() {
  command_exists openshell || return 0
  [ -n "$(installed_openshell_version 2>/dev/null || true)" ] && return 0
  error "OpenShell is present on PATH but could not report its version. Refusing to start onboarding with an undeterminable OpenShell version — reinstall a supported OpenShell (run scripts/install-openshell.sh) or remove the broken binary, then rerun the installer."
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

resolve_current_openshell_version_range() {
  local source_root="${NEMOCLAW_SOURCE_ROOT:-$(resolve_repo_root)}"
  local blueprint="${source_root}/nemoclaw-blueprint/blueprint.yaml"
  local min_version="" max_version=""
  [ -f "$blueprint" ] || return 1
  min_version="$(sed -nE 's/^min_openshell_version:[[:space:]]*["'"'"']([0-9]+\.[0-9]+\.[0-9]+)["'"'"'][[:space:]]*$/\1/p' "$blueprint")"
  max_version="$(sed -nE 's/^max_openshell_version:[[:space:]]*["'"'"']([0-9]+\.[0-9]+\.[0-9]+)["'"'"'][[:space:]]*$/\1/p' "$blueprint")"
  [[ "$min_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ "$max_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  version_gte "$max_version" "$min_version" || return 1
  printf '%s %s\n' "$min_version" "$max_version"
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

openshell_incompatible_sandbox_names_json() {
  local reg_file="$1"
  local scope="legacy"
  if [ "$(resolve_nemoclaw_gateway_port)" -ne 8080 ] \
    && [ "$reg_file" = "$(nemoclaw_state_dir)/sandboxes.json" ]; then
    scope="selected"
  fi
  inspect_sandbox_registry_for_upgrade "$reg_file" incompatible-names "$scope"
}

require_openshell_compatible_sandbox_names() {
  local reg_file="$1" incompatible_json="" incompatible_count="0"
  if ! incompatible_json="$(openshell_incompatible_sandbox_names_json "$reg_file")"; then
    error "Could not validate existing sandbox names for the OpenShell upgrade. Existing gateway and sandboxes were left unchanged."
  fi
  incompatible_count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$incompatible_json")"
  if [ "$incompatible_count" -eq 0 ] 2>/dev/null; then
    return 0
  fi

  cat <<EOF

  ${incompatible_count} existing sandbox name(s) cannot be recreated by OpenShell 0.0.106:
EOF
  while IFS= read -r sandbox_name; do
    [[ -n "$sandbox_name" ]] && printf "    %s\n" "$sandbox_name"
  done < <(node -e '
    const preview = (value) => {
      const raw = String(value);
      const prefix = raw.slice(0, 80);
      let escaped = "\"";
      for (let index = 0; index < prefix.length; index += 1) {
        const codeUnit = prefix.charCodeAt(index);
        if (codeUnit === 0x22) escaped += "\\\"";
        else if (codeUnit === 0x5c) escaped += "\\\\";
        else if (codeUnit >= 0x20 && codeUnit <= 0x7e) escaped += prefix[index];
        else escaped += "\\u" + codeUnit.toString(16).padStart(4, "0");
      }
      return escaped + (raw.length > 80 ? "...\"" : "\"");
    };
    for (const name of JSON.parse(process.argv[1])) console.log(preview(name));
  ' "$incompatible_json")
  cat <<EOF

  OpenShell 0.0.106 caps routed sandbox names at
  ${_OPENSHELL_SANDBOX_NAME_MAX_LENGTH} characters and rejects consecutive
  hyphens. Current NemoClaw names must use 1-${_OPENSHELL_SANDBOX_NAME_MAX_LENGTH}
  lowercase letters, numbers, and single internal hyphens, starting with a
  letter and ending with a letter or number. NemoClaw does not rename durable
  sandbox identity automatically.

  The installer stopped before preparing the current CLI, starting a new
  backup, retiring the gateway, installing OpenShell, or recreating a sandbox.
  Use the currently installed NemoClaw and OpenShell runtime to transfer the
  required state into a replacement sandbox with a compatible name. After you
  verify the replacement, destroy each incompatible sandbox and rerun the
  installer. If you already retired the gateway manually, restore the prior
  OpenShell runtime and gateway before migrating the sandbox state.

EOF
  error "OpenShell 0.0.106 upgrade blocked by incompatible existing sandbox names."
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

trusted_macos_openshell_gateway_process() {
  [ "$(uname -s)" = "Darwin" ] || return 1

  local pid="$1" gateway_port="$2" expected_generation="${3:-}"
  local gateway_name gateway_command gateway_exe gateway_lsof_output
  local process_generation_before process_generation_after
  local observation_diagnostics_file observation_status observation_valid
  local user_bin_home brew_prefix trusted_brew_gateway
  command_exists ps || return 1
  command_exists lsof || return 1

  gateway_name="$(nemoclaw_gateway_name)" || return 1
  observation_diagnostics_file="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-process-observation-XXXXXX" 2>/dev/null)" \
    || return 1
  _cleanup_files+=("$observation_diagnostics_file")
  observation_valid=true

  observation_status=0
  process_generation_before="$(ps -p "$pid" -o lstart= 2>"$observation_diagnostics_file")" \
    || observation_status=$?
  if [ "$observation_status" -ne 0 ] || [ -s "$observation_diagnostics_file" ] || [ -z "$process_generation_before" ]; then
    observation_valid=false
  fi

  if $observation_valid; then
    : >"$observation_diagnostics_file"
    observation_status=0
    gateway_command="$(ps -p "$pid" -o args= 2>"$observation_diagnostics_file")" \
      || observation_status=$?
    if [ "$observation_status" -ne 0 ] || [ -s "$observation_diagnostics_file" ] \
      || [ "$gateway_command" != "openshell-gateway[nemoclaw=${gateway_name};port=${gateway_port}]" ]; then
      observation_valid=false
    fi
  fi

  if $observation_valid; then
    : >"$observation_diagnostics_file"
    observation_status=0
    gateway_lsof_output="$(lsof -a -p "$pid" -d txt -Fn 2>"$observation_diagnostics_file")" \
      || observation_status=$?
    if [ "$observation_status" -ne 0 ] || [ -s "$observation_diagnostics_file" ] \
      || [[ "$gateway_lsof_output" != "p${pid}"$'\n'* ]]; then
      observation_valid=false
    else
      gateway_exe="$(printf '%s\n' "$gateway_lsof_output" | sed -n '/^n\// { s/^n//; p; }' | head -1)"
      [ -n "$gateway_exe" ] || observation_valid=false
    fi
  fi

  if $observation_valid; then
    : >"$observation_diagnostics_file"
    observation_status=0
    process_generation_after="$(ps -p "$pid" -o lstart= 2>"$observation_diagnostics_file")" \
      || observation_status=$?
    if [ "$observation_status" -ne 0 ] || [ -s "$observation_diagnostics_file" ] \
      || [ "$process_generation_after" != "$process_generation_before" ]; then
      observation_valid=false
    fi
  fi

  rm -f "$observation_diagnostics_file"
  _cleanup_files=("${_cleanup_files[@]/$observation_diagnostics_file/}")
  $observation_valid || return 1
  if [ -n "$expected_generation" ] && [ "$process_generation_before" != "$expected_generation" ]; then
    return 1
  fi

  user_bin_home="${XDG_BIN_HOME:-${HOME}/.local/bin}"
  if [ "${user_bin_home#/}" = "$user_bin_home" ]; then
    user_bin_home="${HOME}/.local/bin"
  fi
  case "$gateway_exe" in
    "${user_bin_home%/}/openshell-gateway" | /usr/local/bin/openshell-gateway | /usr/bin/openshell-gateway)
      printf '%s\n' "$process_generation_before"
      return 0
      ;;
  esac

  command_exists brew || return 1
  brew_prefix="$(brew --prefix 2>/dev/null || true)"
  [ -n "$brew_prefix" ] || return 1
  trusted_brew_gateway="${brew_prefix%/}/opt/openshell/bin/openshell-gateway"
  [ -e "$trusted_brew_gateway" ] || return 1
  trusted_brew_gateway="$(cd -P "$(dirname "$trusted_brew_gateway")" 2>/dev/null && printf '%s/%s\n' "$PWD" "$(basename "$trusted_brew_gateway")")" \
    || return 1
  [ "$gateway_exe" = "$trusted_brew_gateway" ] || return 1
  printf '%s\n' "$process_generation_before"
}

stop_legacy_openshell_gateway_process() {
  local platform
  platform="$(uname -s)"
  case "$platform" in
    Darwin | Linux) ;;
    *) return 1 ;;
  esac

  local gateway_port runtime_dir pid_file pid gateway_exe listener_pids attempt process_generation
  local listener_diagnostics_file listener_status listener_observation_valid
  gateway_port="$(resolve_nemoclaw_gateway_port)" || return 2
  if [ -n "${NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR:-}" ]; then
    runtime_dir="${NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR}"
  elif [ "$gateway_port" -eq 8080 ]; then
    runtime_dir="${HOME}/.local/state/nemoclaw/openshell-docker-gateway"
  else
    runtime_dir="${HOME}/.local/state/nemoclaw/openshell-docker-gateway-${gateway_port}"
  fi
  pid_file="${runtime_dir}/openshell-gateway.pid"
  [ -f "$pid_file" ] || return 1
  if [ -L "$pid_file" ] || ! [ -O "$pid_file" ]; then
    error "Refusing to retire the legacy OpenShell gateway from an untrusted PID file: ${pid_file}"
  fi

  IFS= read -r pid <"$pid_file" || return 2
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
    || error "Refusing to retire the legacy OpenShell gateway from an invalid PID file: ${pid_file}"
  if ! kill -0 "$pid" 2>/dev/null; then
    if [ "$platform" = "Darwin" ]; then
      command_exists lsof \
        || error "Could not verify gateway port ${gateway_port} because lsof is unavailable. The PID file, OpenShell registration, and sandbox backups were preserved."
      listener_diagnostics_file="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-lsof-XXXXXX" 2>/dev/null)" \
        || error "Could not prepare gateway port verification. The PID file, OpenShell registration, and sandbox backups were preserved."
      _cleanup_files+=("$listener_diagnostics_file")
      listener_status=0
      listener_pids="$(lsof -nP -iTCP:"${gateway_port}" -sTCP:LISTEN -t 2>"$listener_diagnostics_file")" \
        || listener_status=$?
      listener_observation_valid=false
      # lsof uses status 1 for both no matches and some operational failures.
      if [ ! -s "$listener_diagnostics_file" ]; then
        case "$listener_status" in
          0) [ -n "$listener_pids" ] && listener_observation_valid=true ;;
          1) [ -z "$listener_pids" ] && listener_observation_valid=true ;;
        esac
      fi
      rm -f "$listener_diagnostics_file"
      _cleanup_files=("${_cleanup_files[@]/$listener_diagnostics_file/}")
      $listener_observation_valid \
        || error "Could not verify gateway port ${gateway_port} because lsof did not produce a conclusive listener observation. The PID file, OpenShell registration, and sandbox backups were preserved."
      [ -z "$listener_pids" ] \
        || error "Refusing to retire the legacy OpenShell gateway from stale PID file ${pid_file}: gateway port ${gateway_port} still has listener PID(s): $(printf '%s' "$listener_pids" | tr '\n' ' '). Stop the listener or restore the correct owned PID file, then retry; sandbox backups were preserved."
    fi
    rm -f "$pid_file"
    return 0
  fi

  if [ "$platform" = "Darwin" ]; then
    process_generation="$(trusted_macos_openshell_gateway_process "$pid" "$gateway_port")" \
      || error "Refusing to stop PID ${pid}: the recorded macOS process is not the expected NemoClaw OpenShell gateway."
    if ! trusted_macos_openshell_gateway_process "$pid" "$gateway_port" "$process_generation" >/dev/null; then
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$pid_file"
        return 0
      fi
      error "Refusing to stop PID ${pid}: the recorded macOS process changed or could not be verified immediately before signaling. The PID file, OpenShell registration, and sandbox backups were preserved."
    fi
  else
    gateway_exe="$(readlink "/proc/${pid}/exe" 2>/dev/null || true)"
    [ "${gateway_exe##*/}" = "openshell-gateway" ] \
      || error "Refusing to stop PID ${pid}: the recorded process is not openshell-gateway."
  fi

  kill "$pid" 2>/dev/null \
    || error "Could not stop the recorded legacy OpenShell gateway process ${pid}."
  for attempt in {1..50}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    if [ "$platform" = "Darwin" ] \
      && ! trusted_macos_openshell_gateway_process "$pid" "$gateway_port" "$process_generation" >/dev/null; then
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$pid_file"
        return 0
      fi
      error "Refusing to forcibly terminate PID ${pid}: the recorded macOS process changed or could not be verified after SIGTERM. The PID file, OpenShell registration, and sandbox backups were preserved."
    fi
    kill -KILL "$pid" 2>/dev/null \
      || error "Could not terminate the recorded legacy OpenShell gateway process ${pid}."
    for attempt in {1..10}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  kill -0 "$pid" 2>/dev/null \
    && error "The recorded legacy OpenShell gateway process ${pid} did not stop."
  rm -f "$pid_file"
}

stop_macos_openshell_gateway_user_service() {
  [ "$(uname -s)" = "Darwin" ] || return 1

  local gateway_port service_label service_path service_domain service_program
  local brew_prefix expected_program active_service active_program
  gateway_port="$(resolve_nemoclaw_gateway_port)" || return 1
  [ "$gateway_port" -eq 8080 ] || return 1
  command_exists brew || return 1
  command_exists launchctl || return 1
  command_exists plutil || return 1

  service_label="homebrew.mxcl.openshell"
  service_path="${HOME}/Library/LaunchAgents/${service_label}.plist"
  [ -f "$service_path" ] || return 1
  if [ -L "$service_path" ] || ! [ -O "$service_path" ]; then
    error "Refusing to retire the OpenShell gateway from an untrusted macOS user service: ${service_path}"
  fi

  service_program="$(plutil -extract ProgramArguments.0 raw -o - "$service_path" 2>/dev/null || true)"
  [ "$(plutil -extract Label raw -o - "$service_path" 2>/dev/null || true)" = "$service_label" ] \
    || error "Refusing to retire an OpenShell gateway from a macOS user service with an unexpected label: ${service_path}"
  brew_prefix="$(brew --prefix 2>/dev/null || true)"
  [ -n "$brew_prefix" ] || return 1
  expected_program="${brew_prefix%/}/opt/openshell/libexec/openshell-gateway-homebrew-service"
  [ "$service_program" = "$expected_program" ] && [ -x "$service_program" ] \
    || error "Refusing to retire an OpenShell gateway from a macOS user service with an untrusted executable: ${service_program:-<empty>}"

  service_domain="gui/$(id -u)/${service_label}"
  active_service="$(launchctl print "$service_domain" 2>/dev/null)" || return 1
  active_program="$(printf '%s\n' "$active_service" | sed -n 's/^[[:space:]]*program = //p' | head -1)"
  [ "$active_program" = "$expected_program" ] \
    || error "Refusing to retire an OpenShell gateway from an active macOS user service with an untrusted executable: ${active_program:-<empty>}"
  launchctl bootout "$service_domain" >/dev/null 2>&1 \
    || error "Could not stop the trusted OpenShell Homebrew gateway user service. Run 'launchctl print ${service_domain}' for details."
  launchctl print "$service_domain" >/dev/null 2>&1 \
    && error "The trusted OpenShell Homebrew gateway user service remained active after the stop command."
  return 0
}

stop_nemoclaw_openshell_gateway_user_service() {
  [ "$(uname -s)" = "Linux" ] || return 1

  local gateway_port service_name service_path fragment_path gateway_bin
  gateway_port="$(resolve_nemoclaw_gateway_port)" || return 1
  [ "$gateway_port" -eq 8080 ] || return 1
  command_exists systemctl || return 1

  service_name="${NEMOCLAW_GATEWAY_SERVICE_NAME}.service"
  service_path="$(openshell_user_config_home)/systemd/user/${service_name}"
  [ -f "$service_path" ] || return 1
  if [ -L "$service_path" ] || ! [ -O "$service_path" ]; then
    error "Refusing to retire the OpenShell gateway from an untrusted user service: ${service_path}"
  fi
  is_nemoclaw_openshell_gateway_user_service "$service_path" \
    || error "Refusing to retire the OpenShell gateway from a non-NemoClaw user service: ${service_path}"
  systemctl --user is-active --quiet "$service_name" 2>/dev/null || return 1

  fragment_path="$(systemctl --user show "$service_name" --property=FragmentPath --value 2>/dev/null)" \
    || return 1
  [ "$fragment_path" = "$service_path" ] \
    || error "Refusing to retire the OpenShell gateway because the active user service does not match ${service_path}."
  gateway_bin="$(resolve_openshell_gateway_bin_for_user_service "$service_name")" \
    || return 1
  trusted_openshell_gateway_bin_for_service "$gateway_bin" \
    || error "Refusing to retire an OpenShell gateway user service with an untrusted binary: ${gateway_bin}"

  systemctl --user stop "$service_name" \
    || error "Could not stop the trusted NemoClaw OpenShell gateway user service. Run 'systemctl --user status ${service_name}' for details."
  systemctl --user is-active --quiet "$service_name" 2>/dev/null \
    && error "The trusted NemoClaw OpenShell gateway user service remained active after the stop command."
  return 0
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
  require_openshell_compatible_sandbox_names "$reg_file"
  if truthy_env "${NEMOCLAW_OPENSHELL_UPGRADE_PREPARED:-}"; then
    if [[ "${NEMOCLAW_SINGLE_SESSION:-}" == "1" ]]; then
      error "Aborting — NEMOCLAW_SINGLE_SESSION is set. Destroy existing sessions with '${_CLI_BIN} <name> destroy' before reinstalling."
    fi
    confirm_legacy_managed_image_recovery "$reg_file"
    info "Using manually prepared OpenShell gateway upgrade state."
    _OPENSHELL_INSTALL_REQUIRED_BEFORE_RECOVERY=true
    export NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE=1
    return 0
  fi
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
  # The replacement gateway may report legacy rows as Ready even when their
  # state is no longer inspectable. Reuse this validated backup for every stale
  # or non-Ready recreate instead of attempting a second live backup.
  export NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE=1

  # Retire a backed-up gateway before install-openshell replaces an out-of-range
  # component set. Leaving the old gateway process alive makes the new CLI's
  # schema preflight fail before sandbox recovery can recreate it.
  local supported_range="" min_openshell_version="" max_openshell_version=""
  if ! supported_range="$(resolve_current_openshell_version_range)"; then
    error "Could not resolve the current OpenShell version range. Existing gateway and sandbox state were left unchanged after backup."
  fi
  read -r min_openshell_version max_openshell_version <<<"$supported_range"
  [ -n "$old_openshell_version" ] \
    || error "Could not determine the installed OpenShell version. The installer stopped after backup without retiring the gateway."
  if ! version_gte "$old_openshell_version" "$min_openshell_version" \
    || ! version_gte "$max_openshell_version" "$old_openshell_version"; then
    info "Retiring OpenShell ${old_openshell_version} gateway before installing current OpenShell…"
    if [ "$gateway_name" = "nemoclaw" ]; then
      openshell gateway destroy -g "$gateway_name" >/dev/null 2>&1 \
        || openshell gateway destroy >/dev/null 2>&1 \
        || { { stop_nemoclaw_openshell_gateway_user_service \
          || stop_macos_openshell_gateway_user_service \
          || stop_legacy_openshell_gateway_process; } \
          && { openshell gateway remove "$gateway_name" >/dev/null 2>&1 \
            || warn "The legacy gateway process stopped, but its OpenShell registration could not be removed; onboarding will replace the stale registration."; }; } \
        || error "Could not retire the legacy OpenShell gateway after backup. Installed OpenShell lifecycle commands failed, and no trusted active user service or PID-file gateway could be stopped. The installer stopped with the sandbox backups preserved."
    else
      openshell gateway destroy -g "$gateway_name" >/dev/null 2>&1 \
        || { { stop_nemoclaw_openshell_gateway_user_service \
          || stop_macos_openshell_gateway_user_service \
          || stop_legacy_openshell_gateway_process; } \
          && { openshell gateway remove "$gateway_name" >/dev/null 2>&1 \
            || warn "Legacy gateway ${gateway_name} stopped, but its OpenShell registration could not be removed; onboarding will replace only that stale registration."; }; } \
        || error "Could not retire legacy gateway ${gateway_name} after backup. Installed OpenShell lifecycle commands failed, and no trusted active user service or PID-file gateway could be stopped. The installer stopped with the sandbox backups preserved."
    fi
    _OPENSHELL_INSTALL_REQUIRED_BEFORE_RECOVERY=true
  fi
}

# ---------------------------------------------------------------------------
# 5. Onboard
# ---------------------------------------------------------------------------

# Check whether sudo can run without prompting. If it cannot, validate the
# user's credentials through a terminal. Print the non-prompting sudo invocation
# that the caller must use.
#
# `sudo -v` validates the user's credentials rather than a specific command, so
# on hosts whose sudoers mix a password-based entry (Ubuntu's %sudo group) with
# a NOPASSWD drop-in it still demands a password even though `sudo <command>`
# runs passwordless. Callers with no terminal to answer that prompt — the deploy
# notebook, CI — stall there instead of repairing the spec (NVBug 6570793).
#
# A successful `sudo -n true` probe proves only that sudo can run `true` without
# prompting at that moment. It does not establish that the later systemctl,
# mkdir, or nvidia-ctk commands can run without prompting. Every later command
# therefore uses `sudo -n` and establishes its own authorization without
# another prompt. After an answered `sudo -v`, the credential timestamp lets
# those exact commands run noninteractively. If sudoers does not retain the
# timestamp, the command fails instead of prompting again.
#
# Terminal availability follows the installer's existing model — stdin when it
# is a TTY, else /dev/tty when it can be opened — so the documented
# `curl … | bash` install still prompts instead of skipping the repair.
# The printed invocation is this function's only stdout; anything else it emits
# must go to stderr or the caller would run it as a command.
authorize_sudo() {
  if sudo -n true >/dev/null 2>&1; then
    printf 'sudo -n'
    return 0
  fi
  if installer_non_interactive \
    && [ "${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" != "prompt" ]; then
    return 1
  fi
  if [ -t 0 ]; then
    sudo -v >&2 || return 1
    printf 'sudo -n'
    return 0
  fi
  if { exec 3</dev/tty; } 2>/dev/null; then
    info "Installer stdin is piped; validating sudo credentials through /dev/tty..." >&2
    if ! sudo -v <&3 >&2; then
      exec 3<&-
      return 1
    fi
    exec 3<&-
    printf 'sudo -n'
    return 0
  fi
  return 1
}

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
    local authorized_sudo=""
    info "You may be asked for your password to authorize these host-level admin changes."
    info "NemoClaw does not store your password."
    if ! authorized_sudo="$(authorize_sudo)"; then
      warn "Could not obtain sudo credentials for NVIDIA CDI refresh service repair."
      return 0
    fi
    read -r -a sudo_cmd <<<"$authorized_sudo"
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
    local authorized_sudo=""
    info "You may be asked for your password to authorize these host-level admin changes."
    info "NemoClaw does not store your password."
    if ! authorized_sudo="$(authorize_sudo)"; then
      warn "Could not obtain sudo credentials for NVIDIA CDI device spec generation."
      return 0
    fi
    read -r -a sudo_cmd <<<"$authorized_sudo"
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
  local gateway_management_module="${NEMOCLAW_SOURCE_ROOT}/dist/lib/onboard/gateway-management.js"
  local portable_profile_module="${NEMOCLAW_SOURCE_ROOT}/dist/lib/onboard/experimental/portable-profile.js"
  local host_readiness_module="${NEMOCLAW_SOURCE_ROOT}/dist/lib/readiness/host.js"
  local onboard_admission_module="${NEMOCLAW_SOURCE_ROOT}/dist/lib/readiness/onboard-admission.js"
  if ! command_exists node \
    || [[ ! -f "$preflight_module" ]] \
    || [[ ! -f "$gateway_management_module" ]] \
    || [[ ! -f "$host_readiness_module" ]] \
    || [[ ! -f "$onboard_admission_module" ]]; then
    return 0
  fi

  repair_installer_nvidia_cdi_spec "$preflight_module"

  local output status
  if output="$(
    # shellcheck disable=SC2016
    node -e '
      const preflightPath = process.argv[1];
      const hostReadinessPath = process.argv[2];
      const onboardAdmissionPath = process.argv[3];
      const gatewayManagementPath = process.argv[4];
      const portableProfilePath = process.argv[5];
      let explicitlySelectedPortableProfile = false;
      try {
        const portableProfile = require(portableProfilePath);
        if (typeof portableProfile.isPortableExperimentalProfile === "function") {
          explicitlySelectedPortableProfile = Boolean(
            portableProfile.isPortableExperimentalProfile()
          );
        }
      } catch {}
      try {
        const { assessHost, planHostAdvisories } = require(preflightPath);
        const { createHostReadinessReport } = require(hostReadinessPath);
        const { evaluateOnboardReadinessAdmission } = require(onboardAdmissionPath);
        const { loadGatewayManagementDeclaration } = require(gatewayManagementPath);
        const host = assessHost();
        const actions = planHostAdvisories(host);
        const gatewayManagement = loadGatewayManagementDeclaration();
        const allowStorageRemediation =
          gatewayManagement.ok &&
          (gatewayManagement.declaration === null ||
            gatewayManagement.declaration?.mode === "nemoclaw-managed");
        const readiness = createHostReadinessReport(
          { nemoclawVersion: "installer", sourceRevision: "installer" },
          {
            assess: () => host,
            detectGpu: () => null,
            detectHostGpuPlatform: () => host.hostGpuPlatform,
            detectNvidiaDriverVersion: () => host.nvidiaDriverVersion,
            collectPlatformIdentity: () => ({}),
          }
        );
        const admission = evaluateOnboardReadinessAdmission(readiness, {
          explicitlyOptedOutGpuPassthrough: false,
          allowUnsupportedRuntime: explicitlySelectedPortableProfile,
          // The installer starts a NemoClaw-managed onboarding flow. Let the
          // authoritative onboarding gate apply supported storage remediation,
          // but only when the gateway declaration confirms NemoClaw ownership.
          allowStorageRemediation,
        });
        const infoLines = [];
        const actionLines = [];
        const stableIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
        const stableIds = (values) => [
          ...new Set(
            (Array.isArray(values) ? values : []).filter(
              (value) =>
                typeof value === "string" &&
                value.length <= 128 &&
                stableIdPattern.test(value)
            )
          ),
        ];
        const findingIds = admission.admitted ? [] : stableIds(admission.findingIds);
        const capabilityIds = admission.admitted ? [] : stableIds(admission.capabilityIds);
        if (host.runtime && host.runtime !== "unknown") {
          infoLines.push(`Detected container runtime: ${host.runtime}`);
        }
        if (host.isWsl) {
          infoLines.push("Running under WSL");
        }
        if (!admission.admitted) {
          if (findingIds.length > 0) {
            actionLines.push(`Admission finding IDs: ${findingIds.join(", ")}`);
          }
          if (capabilityIds.length > 0) {
            actionLines.push(`Admission capability IDs: ${capabilityIds.join(", ")}`);
          }
        }
        for (const action of actions) {
          actionLines.push(`- ${action.title}: ${action.reason}`);
          for (const command of action.commands || []) {
            actionLines.push(`  ${command}`);
          }
        }
        if (!admission.admitted) {
          const findingById = new Map(
            (Array.isArray(readiness.findings) ? readiness.findings : []).map((finding) => [
              finding.id,
              finding,
            ])
          );
          for (const findingId of findingIds) {
            const finding = findingById.get(findingId);
            actionLines.push(
              finding?.summary
                ? `- ${finding.summary}`
                : `- Readiness finding: ${findingId}`
            );
          }
          for (const capabilityId of capabilityIds) {
            actionLines.push(
              `- NemoClaw could not confirm the required readiness capability ${capabilityId}.`
            );
          }
        }
        if (infoLines.length > 0) {
          process.stdout.write(`__INFO__\n${infoLines.join("\n")}\n`);
        }
        if (actionLines.length > 0) {
          process.stdout.write(`__ACTIONS__\n${actionLines.join("\n")}`);
        }
        process.exit(admission.admitted ? 0 : 10);
      } catch {
        process.exit(0);
      }
    ' "$preflight_module" "$host_readiness_module" "$onboard_admission_module" "$gateway_management_module" "$portable_profile_module"
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
  local recovery_status=0 recovery_pass=1
  if [ -n "$recovery_log" ]; then
    _cleanup_files+=("$recovery_log")
  fi
  while [ "$recovery_pass" -le 2 ]; do
    recovery_status=0
    if [ -n "$recovery_log" ]; then
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
    [ "$recovery_status" -eq 0 ] || break
    if [ "$recovery_pass" -eq 1 ]; then
      # #7091: the replaced gateway can briefly retain the old supervisor's
      # Ready row before that sandbox exits. Recheck beyond the observed
      # eight-second failure window so the validated backup recovery path sees
      # the real phase instead of letting the installer report false success.
      info "Verifying pre-existing sandboxes remain healthy…"
      sleep 10
    fi
    recovery_pass=$((recovery_pass + 1))
  done
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

validate_deferred_hermes_onboarding_request() {
  [[ "${DEFER_ONBOARDING:-}" == "1" ]] || return 0

  if [[ "${NEMOCLAW_AGENT:-openclaw}" != "hermes" ]]; then
    error "--defer-onboarding currently requires NEMOCLAW_AGENT=hermes."
  fi
  if [[ "${NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE:-}" == "1" ]]; then
    error "--defer-onboarding does not support a local model profile."
  fi
  case "${NEMOCLAW_PROVIDER:-build}" in
    build | cloud | routed) ;;
    *)
      error "--defer-onboarding currently supports NVIDIA hosted inference only. Use NEMOCLAW_PROVIDER=build, cloud, or routed."
      ;;
  esac
}

should_defer_hermes_onboarding() {
  local registered_sandbox_count="${1:-0}"
  local provider_key="${NEMOCLAW_PROVIDER_KEY:-}"
  [[ "${DEFER_ONBOARDING:-}" == "1" ]] || return 1
  [[ "${NEMOCLAW_AGENT:-openclaw}" == "hermes" ]] || return 1
  [[ "$registered_sandbox_count" == "0" ]] || return 1
  [[ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]] || return 1
  [[ -z "${NVIDIA_API_KEY:-}" ]] || return 1

  provider_key="${provider_key#"${provider_key%%[![:space:]]*}"}"
  provider_key="${provider_key%"${provider_key##*[![:space:]]}"}"
  provider_key="$(printf '%s' "$provider_key" | tr '[:upper:]' '[:lower:]')"
  # Keep this list aligned with PROVIDER_KEY_ROUTE_VALUES in
  # src/lib/onboard/providers.ts. These values select a route; they are not
  # inference credentials.
  case "$provider_key" in
    "" | inference | cloud | nim | vllm | open-router | openrouterai | anthropiccompatible | hermes | hermes-provider | hermesprovider | nous | nous-portal | build | openrouter | openai | anthropic | gemini | ollama | llama-cpp | install-llama-cpp | custom | nim-local | routed | install-vllm | install-ollama | install-windows-ollama | start-windows-ollama) ;;
    *) return 1 ;;
  esac
}

run_onboard() {
  show_usage_notice
  info "Running ${_CLI_BIN} onboard…"
  local -a onboard_cmd=(onboard)
  if [[ "${NEMOCLAW_EXPERIMENTAL_PROFILE:-}" == "portable" ]]; then
    onboard_cmd+=(--experimental-profile portable)
  fi
  local installer_auto_fresh_receipt_generation=""
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
    # "failed" (last run reported a step failure — user must choose), "complete"
    # (durably finished; the CLI may still have Station receipt retirement to
    # reconcile), "skip" (missing / non-resumable), or "corrupt".
    local session_state
    session_state="$(
      node -e '
        const fs = require("fs");
        let out = "skip";
        try {
          const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          if (data && data.status === "complete" && data.resumable === false) {
            out = "complete";
          } else if (!data || data.resumable === false) {
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
            const installerGeneration =
              process.env.NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION || "";
            const stationIntentHasGeneration =
              data.stationExpressIntent &&
              Object.prototype.hasOwnProperty.call(
                data.stationExpressIntent,
                "receiptGeneration",
              );
            const exactStationAttempt =
              /^[0-9a-f]{32}$/.test(installerGeneration) &&
              stationIntentHasGeneration &&
              data.stationExpressIntent.receiptGeneration === installerGeneration;
            const conflictingStationAttempt =
              /^[0-9a-f]{32}$/.test(installerGeneration) &&
              stationIntentHasGeneration &&
              !exactStationAttempt;
            // A Station session carries its sandbox name in the correlated
            // intent, so it can safely resume even before sandbox creation.
            // Using --fresh here would discard the still-needed receipt.
            out = conflictingStationAttempt
              ? "station-mismatch"
              : sandboxCreated || exactStationAttempt
                ? "resume"
                : "fresh-recover";
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
      complete) ;;
      station-mismatch)
        error "DGX Station Express resume state belongs to a different installer receipt. Refusing to discard either attempt automatically. Run '${_CLI_BIN} onboard --fresh' only if you intend to discard the saved Station recovery state."
        ;;
      resume)
        info "Found an interrupted onboarding session — resuming it."
        onboard_cmd+=(--resume)
        ;;
      fresh-recover)
        # #5626: interrupted before sandbox creation; nothing to resume.
        info "Found an interrupted onboarding session with no sandbox yet — starting fresh."
        onboard_cmd+=(--fresh)
        # Bind this automatic reset to the loaded Station receipt so the CLI
        # clears only the unrelated session, not the accepted reboot choice.
        # An explicit user --fresh never sets this internal child marker.
        installer_auto_fresh_receipt_generation="${NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION:-}"
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
  fi

  local invoke_bin="$cli_invoke"
  local -a invoke_args=("${onboard_cmd[@]}")
  if [[ "${NEMOCLAW_EXPERIMENTAL_PROFILE:-}" == "portable" &&
    "${NEMOCLAW_AGENT:-openclaw}" == "hermes" &&
    -n "$_PORTABLE_INSTALLER_DOCKER_HOST" &&
    "${DOCKER_HOST:-}" == "$_PORTABLE_INSTALLER_DOCKER_HOST" ]]; then
    invoke_bin="/usr/bin/env"
    invoke_args=(-u DOCKER_HOST "$cli_invoke" "${onboard_cmd[@]}")
  fi

  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    NEMOCLAW_INSTALLER_AUTO_FRESH_RECEIPT_GENERATION="$installer_auto_fresh_receipt_generation" \
      "$invoke_bin" "${invoke_args[@]}" || status=$?
  elif [ -t 0 ]; then
    NEMOCLAW_INSTALLER_AUTO_FRESH_RECEIPT_GENERATION="$installer_auto_fresh_receipt_generation" \
      "$invoke_bin" "${invoke_args[@]}" || status=$?
  elif { exec 3</dev/tty; } 2>/dev/null; then
    info "Installer stdin is piped; attaching onboarding to /dev/tty…"
    NEMOCLAW_INSTALLER_AUTO_FRESH_RECEIPT_GENERATION="$installer_auto_fresh_receipt_generation" \
      "$invoke_bin" "${invoke_args[@]}" <&3 || status=$?
    exec 3<&-
  else
    error "Interactive onboarding requires a TTY. Re-run in a terminal or set NEMOCLAW_NON_INTERACTIVE=1 with --yes-i-accept-third-party-software."
  fi
  return "$status"
}

fail_onboarding() {
  local status="${1:-1}"
  if [ "$status" -ne 130 ]; then
    status=1
  fi
  error_with_status "$status" "Onboarding did not complete successfully."
}

station_express_receipt_retirement_pending() {
  command_exists node || return 1
  local session_file
  session_file="$(nemoclaw_state_dir)/onboard-session.json"
  [[ -f "$session_file" ]] || return 1
  node -e '
    const fs = require("fs");
    try {
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(
        data &&
          Object.prototype.hasOwnProperty.call(data, "stationExpressReceiptRetirement") &&
          data.stationExpressReceiptRetirement !== null
          ? 0
          : 1,
      );
    } catch {
      process.exit(1);
    }
  ' "$session_file" >/dev/null 2>&1
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
    if ! curl -fsSL --proto '=https' --proto-redir '=https' https://get.docker.com -o "$docker_tmp"; then
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
        # Station Express selects or restores its mode before this re-exec. The
        # child treats the derived provider as explicit intent, so remove it.
        # The child restores the saved mode and derives the provider again.
        if [ "${_STATION_INSTALL_MODE:-}" = "express" ]; then
          unset NEMOCLAW_PROVIDER
        fi
        exec sg docker -c "$cmd"
      fi
    fi
    printf "\n"
    info "Docker group membership is not active in this shell yet. To finish:"
    info "  1) Run: newgrp docker   (or log out and log back in)"
    if [[ "${_STATION_LOCAL_VLLM_SELECTED:-}" == "1" ]]; then
      info "  2) Re-run: $(station_local_vllm_resume_command)"
    else
      info "  2) Re-run: curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"
    fi
    exit 0
  fi

  if ! docker info >/dev/null 2>&1; then
    error "Docker is installed but not reachable. Try: sudo systemctl start docker"
  fi
}

# Select the rootless Podman API socket reported for the current user. This
# must run before ensure_docker and the installer host preflight: both use
# the Docker CLI, with DOCKER_HOST overriding its daemon to Podman's user
# socket. The CLI's portable host preparation later applies the networking and
# local-registry configuration required by the OpenShell Podman driver.
prepare_portable_experimental_runtime_override() {
  [[ "${NEMOCLAW_EXPERIMENTAL_PROFILE:-}" == "portable" ]] || return 0
  [[ "$(uname -s)" == "Linux" ]] \
    || error "The portable experimental profile requires Linux."
  command_exists podman \
    || error "The portable experimental profile requires rootless Podman on PATH."
  command_exists docker \
    || error "The portable experimental profile requires the Docker CLI on PATH."
  command_exists systemctl \
    || error "The portable experimental profile requires systemctl --user to manage the rootless Podman socket."

  systemctl --user enable --now podman.socket >/dev/null \
    || error "Could not start the rootless Podman API socket with 'systemctl --user enable --now podman.socket'."

  local podman_socket=""
  podman_socket="$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null)" \
    || error "Could not resolve the rootless Podman API socket with 'podman info'."
  case "$podman_socket" in
    unix:///*) export DOCKER_HOST="$podman_socket" ;;
    /*) export DOCKER_HOST="unix://${podman_socket}" ;;
    *) error "Podman reported an invalid rootless API socket path: ${podman_socket:-empty}" ;;
  esac
  _PORTABLE_INSTALLER_DOCKER_HOST="$DOCKER_HOST"

  info "Portable profile selected rootless Podman through DOCKER_HOST=${DOCKER_HOST}."
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

# Detect DGX Spark / DGX Station from firmware (DMI first, devicetree fallback),
# N1x from its protected FastOS and PCI identity, and Windows WSL from the host
# environment. Used to gate the express install prompt; only platforms with an
# accepted default are offered.
is_station_gb300_product() {
  local product=${1:-}
  [[ "$product" =~ (^|[^[:alnum:]])[Ss][Tt][Aa][Tt][Ii][Oo][Nn]([^[:alnum:]]|$) &&
    "$product" =~ (^|[^[:alnum:]])[Gg][Bb]300([^[:alnum:]]|$) ]]
}

classify_dgx_station_release() {
  local helper="${SCRIPT_DIR}/prepare-dgx-station-host.sh"
  [[ -f "$helper" ]] || error "DGX Station host preparation helper is missing: ${helper}"
  bash "$helper" --classify-dgx-release
}

N1X_FASTOS_RELEASE_MAX_BYTES=4096

n1x_fastos_release_path() {
  printf "/etc/fastos-release"
}

n1x_pci_devices_path() {
  printf "/sys/bus/pci/devices"
}

n1x_fastos_release_metadata_is_trusted() {
  local metadata=${1:-}
  local file_mode_hex="" uid="" gid="" mode="" size="" device="" inode=""
  IFS=: read -r file_mode_hex uid gid mode size device inode <<<"$metadata"
  [[ "$file_mode_hex" =~ ^[0-9a-fA-F]+$ ]] || return 1
  (((16#$file_mode_hex & 16#f000) == 16#8000)) || return 1
  [[ "$uid" = "0" && "$gid" = "0" ]] || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ && "$size" =~ ^[0-9]+$ ]] || return 1
  ((10#$size > 0 && 10#$size <= N1X_FASTOS_RELEASE_MAX_BYTES)) || return 1
  ((8#$mode & 022)) && return 1
  [[ "$device" =~ ^[0-9]+$ && "$inode" =~ ^[0-9]+$ ]]
}

n1x_fastos_release_contents_are_valid() {
  local contents=${1:-}
  local expected_name=${2:-'N1x FASTOS'}
  local line="" name_count=0
  [[ "$contents" != *$'\r'* ]] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "NAME=\"${expected_name}\"") ((name_count += 1)) ;;
      NAME=*) return 1 ;;
    esac
  done <<<"$contents"
  [ "$name_count" -eq 1 ]
}

n1x_opened_fastos_release_has_nul() {
  local bytes=""
  command -v od >/dev/null 2>&1 || return 2
  bytes="$(LC_ALL=C od -An -v -tx1 -N $((N1X_FASTOS_RELEASE_MAX_BYTES + 1)) <&9)" \
    || return 2
  case " $bytes " in
    *" 00 "*) return 0 ;;
    *) return 1 ;;
  esac
}

n1x_fastos_release_is_trusted() {
  fastos_release_is_trusted_for_name 'N1x FASTOS'
}

fastos_release_is_trusted_for_name() {
  local expected_name=${1:?expected FastOS marker name is required}
  local marker="" before="" opened="" after="" contents=""
  marker="$(n1x_fastos_release_path)"
  [ -e "$marker" ] && [ ! -L "$marker" ] || return 1
  before="$(stat -c '%f:%u:%g:%a:%s:%d:%i' "$marker" 2>/dev/null)" || return 1
  n1x_fastos_release_metadata_is_trusted "$before" || return 1
  exec 9<"$marker" || return 1
  opened="$(stat -Lc '%f:%u:%g:%a:%s:%d:%i' /proc/self/fd/9 2>/dev/null)" || {
    exec 9<&-
    return 1
  }
  after="$(stat -c '%f:%u:%g:%a:%s:%d:%i' "$marker" 2>/dev/null)" || {
    exec 9<&-
    return 1
  }
  if [ "$before" != "$opened" ] || [ "$before" != "$after" ]; then
    exec 9<&-
    return 1
  fi
  if n1x_opened_fastos_release_has_nul; then
    exec 9<&-
    return 1
  elif [ "$?" -ne 1 ]; then
    exec 9<&-
    return 1
  fi
  exec 9<&-
  exec 9<"$marker" || return 1
  opened="$(stat -Lc '%f:%u:%g:%a:%s:%d:%i' /proc/self/fd/9 2>/dev/null)" || {
    exec 9<&-
    return 1
  }
  after="$(stat -c '%f:%u:%g:%a:%s:%d:%i' "$marker" 2>/dev/null)" || {
    exec 9<&-
    return 1
  }
  if [ "$before" != "$opened" ] || [ "$before" != "$after" ]; then
    exec 9<&-
    return 1
  fi
  contents="$(head -c $((N1X_FASTOS_RELEASE_MAX_BYTES + 1)) <&9)"
  exec 9<&-
  [ "${#contents}" -le "$N1X_FASTOS_RELEASE_MAX_BYTES" ] || return 1
  n1x_fastos_release_contents_are_valid "$contents" "$expected_name"
}

spark_fastos_release_is_trusted() {
  fastos_release_is_trusted_for_name 'DGX SPARK FASTOS'
}

n1x_pci_identity_is_valid() {
  local vendor="" pci_class=""
  vendor="$(printf "%s" "${1:-}" | tr '[:upper:]' '[:lower:]')"
  pci_class="$(printf "%s" "${2:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "$vendor" = "0x10de" && "$pci_class" =~ ^0x03[0-9a-f]{4}$ ]]
}

n1x_has_pci_gpu() {
  local pci_root="" pci_device="" vendor="" pci_class="" scanned=0
  pci_root="$(n1x_pci_devices_path)"
  [ -d "$pci_root" ] || return 1
  for pci_device in "$pci_root"/*; do
    [ -d "$pci_device" ] || continue
    ((scanned += 1))
    [ "$scanned" -le 256 ] || return 1
    vendor="$(head -c 65 "$pci_device/vendor" 2>/dev/null)" || continue
    pci_class="$(head -c 65 "$pci_device/class" 2>/dev/null)" || continue
    if [ "${#vendor}" -gt 64 ] || [ "${#pci_class}" -gt 64 ]; then
      continue
    fi
    vendor="${vendor//[[:space:]]/}"
    pci_class="${pci_class//[[:space:]]/}"
    n1x_pci_identity_is_valid "$vendor" "$pci_class" && return 0
  done
  return 1
}

is_n1x_host() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ] || return 1
  case "$(uname -m 2>/dev/null)" in
    arm64 | aarch64) ;;
    *) return 1 ;;
  esac
  n1x_fastos_release_is_trusted && n1x_has_pci_gpu
}

detect_express_platform() {
  local model="" release_state=""
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
    *DGX*Spark*)
      printf "DGX Spark"
      return
      ;;
  esac
  if spark_fastos_release_is_trusted; then
    printf "DGX Spark"
    return
  fi
  if is_station_gb300_product "$model"; then
    release_state="$(classify_dgx_station_release)"
    case "$release_state" in
      generic-ubuntu | supported-dgx-os | supported-colossus-baseos | supported-ai-developer-tools)
        printf "DGX Station"
        ;;
      *)
        if [ "${FORCE_STATION_INSTALL:-}" = "1" ]; then
          printf "DGX Station"
        else
          printf "Unsupported DGX Station OS"
        fi
        ;;
    esac
    return
  fi
  if is_n1x_host; then
    printf "N1x"
    return
  fi
  case "$model" in
    *DGX*Station*) printf "Unsupported DGX Station generation" ;;
    *) ;;
  esac
}

validate_express_platform_boundary() {
  case "${1:-}" in
    "Unsupported DGX Station OS")
      if [ "${NEMOCLAW_NO_EXPRESS:-}" = "1" ] || [ -n "${NEMOCLAW_PROVIDER:-}" ]; then return 0; fi
      error "This DGX Station OS image is outside the recognized Station Express release-metadata boundary. Station Express accepts generic Ubuntu 24.04 ARM64, OTA-form DGX OS 7.2.0, 7.4.0, or 7.5.0, an explicitly qualified Station factory image, or the no-OTA DGX OS 7.6.x profile with DGX_PRETTY_NAME=\"NVIDIA DGX GB300WS\" or DGX_PRETTY_NAME=\"NVIDIA DGX Server\"."
      ;;
    "Unsupported DGX Station generation")
      if [ "${NEMOCLAW_NO_EXPRESS:-}" = "1" ] || [ -n "${NEMOCLAW_PROVIDER:-}" ]; then return 0; fi
      error "This DGX Station generation is outside the validated Station GB300 express boundary."
      ;;
  esac
}

STATION_ULTRA_VLLM_MODEL="nemotron-3-ultra-550b-a55b"
STATION_ULTRA_SERVED_MODEL="nvidia/nemotron-3-ultra-550b-a55b"
STATION_ULTRA_DUAL_SERVED_MODEL="nemotron-ultra"
STATION_ULTRA_LEGACY_VLLM_IMAGE="vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416"
STATION_DEEPSEEK_VLLM_MODEL="deepseek-v4-flash"
STATION_DEEPSEEK_SERVED_MODEL="deepseek-ai/DeepSeek-V4-Flash"
_SELECTED_EXPRESS_PLATFORM=""
_EXPRESS_WSL_PROVIDER_PENDING=""
_STATION_EXPRESS_RESUME_REVISION=""
_STATION_EXPRESS_MODEL_WAS_EXPLICIT=0
_STATION_EXPRESS_DEFERRED_MANAGED_PAIR=0
_STATION_EXPRESS_MIGRATING_LEGACY_HEAD=0
_STATION_INSTALL_MODE=""
_STATION_EXPRESS_RESUME_LOADED=""
_STATION_EXPRESS_RESUME_GENERATION=""
_STATION_EXPRESS_RESUME_GATEWAY_PORT=""
_STATION_EXPRESS_RESUME_DASHBOARD_PORT=""
_STATION_EXPRESS_RESUME_VLLM_PORT=""

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

fail_force_station_terminal_required() {
  error "--force-station-install selects the DGX Station express prompt, which needs an interactive terminal. Re-run from a terminal (for a curl|bash pipe, /dev/tty must be available), or omit --force-station-install."
}

validate_force_station_install_override() {
  local platform="$1" release_state
  if [ "${FORCE_STATION_INSTALL:-}" != "1" ]; then
    return 0
  fi
  if [ "$platform" != "DGX Station" ]; then
    error "--force-station-install requires DGX Station GB300 hardware (detected: ${platform:-unsupported platform})."
  fi
  release_state="$(classify_dgx_station_release)"
  case "$release_state" in
    generic-ubuntu | supported-dgx-os | supported-colossus-baseos | supported-ai-developer-tools)
      error "--force-station-install is only for unrecognized DGX Station release metadata. This host is already supported (${release_state}); omit --force-station-install."
      ;;
  esac
  if [ "${NEMOCLAW_NO_EXPRESS:-}" = "1" ]; then
    error "--force-station-install cannot be combined with NEMOCLAW_NO_EXPRESS=1. Remove one override."
  fi
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    local trigger_note=""
    if [ -n "${NON_INTERACTIVE_SOURCE:-}" ]; then
      trigger_note=" (triggered by: ${NON_INTERACTIVE_SOURCE})"
    fi
    error "--force-station-install selects the DGX Station express prompt and cannot be combined with non-interactive mode${trigger_note}."
  fi
  if [ -n "${NEMOCLAW_PROVIDER:-}" ]; then
    error "--force-station-install conflicts with NEMOCLAW_PROVIDER=${NEMOCLAW_PROVIDER}. Remove the provider override to use Station express install."
  fi
  if ! express_prompt_can_read_tty; then
    fail_force_station_terminal_required
  fi
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
  validate_force_station_install_override "$platform"
  validate_station_deepseek_override "$platform"
}

configure_station_express_model() {
  local selected_model
  selected_model="$(normalize_station_vllm_model "${NEMOCLAW_VLLM_MODEL:-}")"
  _STATION_EXPRESS_MODEL_WAS_EXPLICIT=0
  if [ "${STATION_DEEPSEEK:-}" = "1" ]; then
    _STATION_EXPRESS_MODEL_WAS_EXPLICIT=1
    NEMOCLAW_VLLM_MODEL="$STATION_DEEPSEEK_VLLM_MODEL"
    NEMOCLAW_MODEL="$STATION_DEEPSEEK_SERVED_MODEL"
  elif [ -z "$selected_model" ]; then
    if [ "${_STATION_INSTALL_MODE:-}" = "express" ] || [ -n "${NEMOCLAW_DGX_STATION_PEER:-}" ]; then
      # Station Express keeps its single-host Ultra default. Pair qualification
      # changes only the serving topology. An explicit peer also selects Ultra
      # for a provider-driven, non-interactive pair setup.
      NEMOCLAW_VLLM_MODEL="$STATION_ULTRA_VLLM_MODEL"
      NEMOCLAW_MODEL="$STATION_ULTRA_SERVED_MODEL"
    else
      # A direct provider selection outside Express keeps the Station profile
      # default unless the operator selects a model or peer.
      unset NEMOCLAW_VLLM_MODEL
    fi
  else
    [ "$selected_model" != "auto" ] \
      || error "NEMOCLAW_VLLM_MODEL=auto is reserved for DGX Station reboot-resume state. Unset NEMOCLAW_VLLM_MODEL to request automatic selection."
    _STATION_EXPRESS_MODEL_WAS_EXPLICIT=1
    case "$selected_model" in
      "$STATION_ULTRA_VLLM_MODEL" | "nvidia/nvidia-nemotron-3-ultra-550b-a55b-nvfp4")
        NEMOCLAW_MODEL="$STATION_ULTRA_SERVED_MODEL"
        ;;
      "$STATION_ULTRA_SERVED_MODEL" | "$STATION_ULTRA_DUAL_SERVED_MODEL")
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
  if [ -n "${NEMOCLAW_VLLM_MODEL:-}" ]; then
    export NEMOCLAW_VLLM_MODEL
  fi
  if [ -n "${NEMOCLAW_MODEL:-}" ]; then
    export NEMOCLAW_MODEL
  fi
}

station_dual_model_requested() {
  local selected_model
  selected_model="$(normalize_station_vllm_model "${NEMOCLAW_VLLM_MODEL:-}")"
  case "$selected_model" in
    "$STATION_ULTRA_VLLM_MODEL" | "$STATION_ULTRA_SERVED_MODEL" | "$STATION_ULTRA_DUAL_SERVED_MODEL" | "nvidia/nvidia-nemotron-3-ultra-550b-a55b-nvfp4")
      return 0
      ;;
    "")
      [ "${_STATION_INSTALL_MODE:-}" = "express" ] || [ -n "${NEMOCLAW_DGX_STATION_PEER:-}" ]
      ;;
    *)
      return 1
      ;;
  esac
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

validate_station_express_resume_agent() {
  case "${1:-}" in
    openclaw | hermes | langchain-deepagents-code) return 0 ;;
    *) return 1 ;;
  esac
}

validate_station_express_resume_sandbox() {
  local sandbox="${1:-}"
  [[ ${#sandbox} -le $_OPENSHELL_SANDBOX_NAME_MAX_LENGTH ]] \
    && [[ "$sandbox" != *--* ]] \
    && { [[ "$sandbox" =~ ^[a-z]$ ]] || [[ "$sandbox" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]]; }
}

validate_station_express_resume_policy_tier() {
  case "${1:-}" in
    restricted | balanced | open | personal) return 0 ;;
    *) return 1 ;;
  esac
}

validate_station_express_resume_revision() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]]
}

validate_station_install_mode() {
  [[ "${1:-}" == "express" || "${1:-}" == "provider" ]]
}

validate_station_express_resume_generation() {
  [[ "${1:-}" =~ ^[0-9a-f]{32}$ ]]
}

validate_station_express_resume_port() {
  local port="${1:-}"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ]
}

station_express_resume_port_value() {
  local env_name="$1" fallback="$2" port
  case "$env_name" in
    NEMOCLAW_GATEWAY_PORT | NEMOCLAW_DASHBOARD_PORT | NEMOCLAW_VLLM_PORT) ;;
    *) error "Unsupported DGX Station express resume port field: ${env_name}" ;;
  esac
  port="${!env_name:-$fallback}"
  port="${port#"${port%%[![:space:]]*}"}"
  port="${port%"${port##*[![:space:]]}"}"
  validate_station_express_resume_port "$port" \
    || error "${env_name} must be an integer between 1024 and 65535."
  printf '%s' "$((10#$port))"
}

validate_station_express_resume_ports_distinct() {
  local gateway_port="$1" dashboard_port="$2" vllm_port="$3"
  gateway_port="$((10#$gateway_port))"
  dashboard_port="$((10#$dashboard_port))"
  vllm_port="$((10#$vllm_port))"
  [[ "$gateway_port" != "$dashboard_port" ]] \
    || error "NEMOCLAW_GATEWAY_PORT conflicts with NEMOCLAW_DASHBOARD_PORT (${gateway_port})."
  [[ "$gateway_port" != "$vllm_port" ]] \
    || error "NEMOCLAW_GATEWAY_PORT conflicts with NEMOCLAW_VLLM_PORT (${gateway_port})."
  [[ "$dashboard_port" != "$vllm_port" ]] \
    || error "NEMOCLAW_DASHBOARD_PORT conflicts with NEMOCLAW_VLLM_PORT (${dashboard_port})."
}

station_express_resume_generation() {
  local generation
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    IFS= read -r generation </proc/sys/kernel/random/uuid \
      || error "Could not generate a DGX Station express resume receipt identity."
  elif command_exists uuidgen; then
    generation="$(uuidgen)" \
      || error "Could not generate a DGX Station express resume receipt identity."
  elif command_exists openssl; then
    generation="$(openssl rand -hex 16)" \
      || error "Could not generate a DGX Station express resume receipt identity."
  else
    error "Could not generate a DGX Station express resume receipt identity."
  fi
  generation="${generation//-/}"
  generation="$(printf '%s' "$generation" | tr '[:upper:]' '[:lower:]')"
  validate_station_express_resume_generation "$generation" \
    || error "Generated DGX Station express resume receipt identity is invalid."
  printf '%s' "$generation"
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
  assert_station_express_resume_directory_safe "$state_dir"
  [[ -f "$state_file" && -O "$state_file" ]] \
    || error "DGX Station express resume state must be a regular file owned by the current user: ${state_file}"
  mode="$(portable_file_mode "$state_file")" \
    || error "Could not inspect DGX Station express resume state permissions: ${state_file}"
  [[ "$mode" == "600" ]] || error "DGX Station express resume state must have mode 0600: ${state_file}"
}

assert_station_express_resume_directory_safe() {
  local state_dir=$1 root current relative component mode
  root="$(nemoclaw_state_root)" || return 1
  assert_nemoclaw_state_path_safe "$state_dir"
  current="$root"
  relative="${state_dir#"$root"}"
  relative="${relative#/}"
  while :; do
    [[ -d "$current" && ! -L "$current" && -O "$current" ]] \
      || error "DGX Station express resume directory is not owned by the current user: ${current}"
    mode="$(portable_file_mode "$current")" \
      || error "Could not inspect DGX Station express resume directory permissions: ${current}"
    (((8#$mode & 0077) == 0)) \
      || error "DGX Station express resume directory must not be accessible by group or other users: ${current}"
    [[ -n "$relative" ]] || break
    component="${relative%%/*}"
    current="${current}/${component}"
    if [[ "$relative" == "$component" ]]; then
      relative=''
    else
      relative="${relative#*/}"
    fi
  done
}

load_station_express_resume() {
  local state_file revision_line model_line generation_line agent_line sandbox_line policy_tier_line
  local gateway_port_line dashboard_port_line vllm_port_line mode_line
  local line_count saved_revision saved_model saved_mode current_revision
  local saved_agent saved_sandbox saved_policy_tier current_agent
  local saved_gateway_port saved_dashboard_port saved_vllm_port current_gateway_port
  local requested_model="${NEMOCLAW_VLLM_MODEL:-}" requested_mode="${_STATION_INSTALL_MODE:-}"
  state_file="$(station_express_resume_file)" || return 1
  assert_nemoclaw_state_path_safe "$state_file"
  [[ -e "$state_file" || -L "$state_file" ]] || return 1
  assert_station_express_resume_file_safe "$state_file"
  line_count="$(wc -l <"$state_file" | tr -d '[:space:]')"
  revision_line="$(sed -n '1p' "$state_file")"
  model_line="$(sed -n '2p' "$state_file")"
  generation_line="$(sed -n '3p' "$state_file")"
  agent_line="$(sed -n '4p' "$state_file")"
  sandbox_line="$(sed -n '5p' "$state_file")"
  policy_tier_line="$(sed -n '6p' "$state_file")"
  gateway_port_line="$(sed -n '7p' "$state_file")"
  dashboard_port_line="$(sed -n '8p' "$state_file")"
  vllm_port_line="$(sed -n '9p' "$state_file")"
  mode_line="$(sed -n '10p' "$state_file")"
  saved_revision="${revision_line#revision=}"
  saved_model="${model_line#model=}"
  if [[ "$line_count" == "3" && "$generation_line" == mode=* ]]; then
    # Compatibility with the pre-receipt dual-Station draft state.
    saved_mode="${generation_line#mode=}"
    _STATION_EXPRESS_RESUME_GENERATION="$(station_express_resume_generation)"
    saved_agent=openclaw
    saved_sandbox=my-assistant
    saved_policy_tier=balanced
  elif [[ "$line_count" == "3" ]]; then
    _STATION_EXPRESS_RESUME_GENERATION="${generation_line#generation=}"
    saved_mode=express
    saved_agent=openclaw
    saved_sandbox=my-assistant
    saved_policy_tier=balanced
  elif [[ "$line_count" == "6" ]]; then
    _STATION_EXPRESS_RESUME_GENERATION="${generation_line#generation=}"
    saved_mode=express
    saved_agent="${agent_line#agent=}"
    saved_sandbox="${sandbox_line#sandbox=}"
    saved_policy_tier="${policy_tier_line#policy_tier=}"
  elif [[ "$line_count" == "9" || "$line_count" == "10" ]]; then
    _STATION_EXPRESS_RESUME_GENERATION="${generation_line#generation=}"
    saved_mode=express
    saved_agent="${agent_line#agent=}"
    saved_sandbox="${sandbox_line#sandbox=}"
    saved_policy_tier="${policy_tier_line#policy_tier=}"
    saved_gateway_port="${gateway_port_line#gateway_port=}"
    saved_dashboard_port="${dashboard_port_line#dashboard_port=}"
    saved_vllm_port="${vllm_port_line#vllm_port=}"
    if [[ "$line_count" == "10" ]]; then
      saved_mode="${mode_line#mode=}"
    fi
  else
    error "DGX Station express resume state is invalid. Remove ${state_file} and rerun the installer."
  fi
  if [[ "$revision_line" != "revision=${saved_revision}" || "$model_line" != "model=${saved_model}" ]] \
    || { [[ "$generation_line" != mode=* ]] && [[ "$generation_line" != "generation=${_STATION_EXPRESS_RESUME_GENERATION}" ]]; } \
    || { [[ "$line_count" != "3" ]] && [[ "$agent_line" != "agent=${saved_agent}" || "$sandbox_line" != "sandbox=${saved_sandbox}" || "$policy_tier_line" != "policy_tier=${saved_policy_tier}" ]]; } \
    || { [[ "$line_count" == "9" || "$line_count" == "10" ]] && [[ "$gateway_port_line" != "gateway_port=${saved_gateway_port}" || "$dashboard_port_line" != "dashboard_port=${saved_dashboard_port}" || "$vllm_port_line" != "vllm_port=${saved_vllm_port}" ]]; } \
    || { [[ "$line_count" == "10" ]] && [[ "$mode_line" != "mode=${saved_mode}" ]]; } \
    || ! validate_station_express_resume_revision "$saved_revision" \
    || ! validate_station_express_resume_model "$saved_model" \
    || ! validate_station_express_resume_generation "$_STATION_EXPRESS_RESUME_GENERATION" \
    || ! validate_station_express_resume_agent "$saved_agent" \
    || ! validate_station_express_resume_sandbox "$saved_sandbox" \
    || ! validate_station_express_resume_policy_tier "$saved_policy_tier" \
    || ! validate_station_install_mode "$saved_mode" \
    || { [[ "$line_count" == "9" || "$line_count" == "10" ]] && { ! validate_station_express_resume_port "$saved_gateway_port" || ! validate_station_express_resume_port "$saved_dashboard_port" || ! validate_station_express_resume_port "$saved_vllm_port"; }; }; then
    error "DGX Station express resume state is invalid. Remove ${state_file} and rerun the installer."
  fi
  current_gateway_port="$(resolve_nemoclaw_gateway_port)"
  if [[ "$line_count" != "9" && "$line_count" != "10" ]]; then
    saved_gateway_port="$current_gateway_port"
    saved_dashboard_port="$(station_express_resume_port_value NEMOCLAW_DASHBOARD_PORT 18789)"
    saved_vllm_port="$(station_express_resume_port_value NEMOCLAW_VLLM_PORT 8000)"
  fi
  validate_station_express_resume_ports_distinct \
    "$saved_gateway_port" "$saved_dashboard_port" "$saved_vllm_port"
  _STATION_EXPRESS_RESUME_REVISION="$saved_revision"
  _STATION_EXPRESS_RESUME_AGENT="$saved_agent"
  _STATION_EXPRESS_RESUME_SANDBOX="$saved_sandbox"
  _STATION_EXPRESS_RESUME_POLICY_TIER="$saved_policy_tier"
  _STATION_EXPRESS_RESUME_GATEWAY_PORT="$saved_gateway_port"
  _STATION_EXPRESS_RESUME_DASHBOARD_PORT="$saved_dashboard_port"
  _STATION_EXPRESS_RESUME_VLLM_PORT="$saved_vllm_port"
  current_revision="$(station_installer_revision)"
  if [[ "$current_revision" != "$saved_revision" ]]; then
    error "DGX Station Express resume requires NemoClaw revision ${saved_revision}, but this installer is ${current_revision}. Rerun with: $(station_express_resume_command)"
  fi
  if [ -n "$requested_mode" ] && [ "$requested_mode" != "$saved_mode" ]; then
    error "DGX Station resume state was accepted in ${saved_mode} mode; refusing to resume it in ${requested_mode} mode. Rerun the exact accepted installer command."
  fi
  _STATION_INSTALL_MODE="$saved_mode"
  current_agent="${NEMOCLAW_AGENT:-openclaw}"
  if [[ "$current_agent" != "$saved_agent" ]]; then
    error "DGX Station express resume requires NEMOCLAW_AGENT=${saved_agent}. Rerun the exact command printed after host preparation."
  fi
  if [[ "$line_count" == "9" || "$line_count" == "10" ]]; then
    if [[ "$current_gateway_port" != "$saved_gateway_port" ]]; then
      error "DGX Station express resume requires NEMOCLAW_GATEWAY_PORT=${saved_gateway_port}. Rerun the exact command printed after host preparation."
    fi
    if [[ -n "${NEMOCLAW_DASHBOARD_PORT:-}" ]] \
      && [[ "$(station_express_resume_port_value NEMOCLAW_DASHBOARD_PORT 18789)" != "$saved_dashboard_port" ]]; then
      error "DGX Station express resume requires NEMOCLAW_DASHBOARD_PORT=${saved_dashboard_port}. Rerun the exact command printed after host preparation."
    fi
    if [[ -n "${NEMOCLAW_VLLM_PORT:-}" ]] \
      && [[ "$(station_express_resume_port_value NEMOCLAW_VLLM_PORT 8000)" != "$saved_vllm_port" ]]; then
      error "DGX Station express resume requires NEMOCLAW_VLLM_PORT=${saved_vllm_port}. Rerun the exact command printed after host preparation."
    fi
  fi
  NEMOCLAW_SANDBOX_NAME="$saved_sandbox"
  NEMOCLAW_POLICY_TIER="$saved_policy_tier"
  NEMOCLAW_GATEWAY_PORT="$saved_gateway_port"
  NEMOCLAW_DASHBOARD_PORT="$saved_dashboard_port"
  NEMOCLAW_VLLM_PORT="$saved_vllm_port"
  _STATION_EXPRESS_RESUME_LOADED=1
  export NEMOCLAW_SANDBOX_NAME
  export NEMOCLAW_POLICY_TIER
  export NEMOCLAW_GATEWAY_PORT
  export NEMOCLAW_DASHBOARD_PORT
  export NEMOCLAW_VLLM_PORT
  export NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION="$_STATION_EXPRESS_RESUME_GENERATION"
  if [ -n "$(normalize_station_vllm_model "$requested_model")" ]; then
    NEMOCLAW_VLLM_MODEL="$requested_model"
    export NEMOCLAW_VLLM_MODEL
    if station_dual_pair_resume_pending && ! station_dual_model_requested; then
      error "A dual-DGX Station pair resume is pending; refusing to replace its model with '${requested_model}' before the exact pair is revalidated. Rerun with the accepted dual-Station model or remove the override."
    fi
  elif [ "$saved_model" = "auto" ]; then
    unset NEMOCLAW_VLLM_MODEL
  else
    NEMOCLAW_VLLM_MODEL="$saved_model"
    export NEMOCLAW_VLLM_MODEL
  fi
}

save_station_express_resume() {
  local state_file state_dir temp_file revision generation
  local model="${NEMOCLAW_VLLM_MODEL:-auto}" agent="${NEMOCLAW_AGENT:-openclaw}"
  local sandbox="${NEMOCLAW_SANDBOX_NAME:-my-assistant}" policy_tier="${NEMOCLAW_POLICY_TIER:-balanced}"
  local gateway_port dashboard_port vllm_port mode="${_STATION_INSTALL_MODE:-express}"
  validate_station_express_resume_model "$model" || error "Cannot save an invalid DGX Station express model selector."
  validate_station_express_resume_agent "$agent" || error "Cannot save an invalid DGX Station express agent."
  validate_station_express_resume_sandbox "$sandbox" || error "Cannot save an invalid DGX Station express sandbox name."
  validate_station_express_resume_policy_tier "$policy_tier" || error "Cannot save an invalid DGX Station express policy tier."
  validate_station_install_mode "$mode" || error "Cannot save an invalid DGX Station installer resume mode."
  gateway_port="$(resolve_nemoclaw_gateway_port)"
  dashboard_port="$(station_express_resume_port_value NEMOCLAW_DASHBOARD_PORT 18789)"
  vllm_port="$(station_express_resume_port_value NEMOCLAW_VLLM_PORT 8000)"
  validate_station_express_resume_ports_distinct "$gateway_port" "$dashboard_port" "$vllm_port"
  NEMOCLAW_GATEWAY_PORT="$gateway_port"
  NEMOCLAW_DASHBOARD_PORT="$dashboard_port"
  NEMOCLAW_VLLM_PORT="$vllm_port"
  export NEMOCLAW_GATEWAY_PORT
  export NEMOCLAW_DASHBOARD_PORT
  export NEMOCLAW_VLLM_PORT
  revision="$(station_installer_revision)"
  state_file="$(station_express_resume_file)" || error "Could not resolve NemoClaw state for DGX Station express resume."
  state_dir="$(ensure_nemoclaw_state_dir)" || error "Could not prepare NemoClaw state for DGX Station express resume."
  assert_nemoclaw_state_path_safe "$state_file"
  generation="${_STATION_EXPRESS_RESUME_GENERATION:-}"
  if ! validate_station_express_resume_generation "$generation"; then
    generation="$(station_express_resume_generation)"
  fi
  temp_file="$(mktemp "${state_file}.tmp.XXXXXX")" || error "Could not create DGX Station express resume state under ${state_dir}."
  chmod 600 "$temp_file" || {
    rm -f "$temp_file"
    error "Could not secure DGX Station express resume state under ${state_dir}."
  }
  if ! printf 'revision=%s\nmodel=%s\ngeneration=%s\nagent=%s\nsandbox=%s\npolicy_tier=%s\ngateway_port=%s\ndashboard_port=%s\nvllm_port=%s\nmode=%s\n' \
    "$revision" "$model" "$generation" "$agent" "$sandbox" "$policy_tier" \
    "$gateway_port" "$dashboard_port" "$vllm_port" "$mode" >"$temp_file"; then
    rm -f "$temp_file"
    error "Could not write DGX Station express resume state under ${state_dir}."
  fi
  if ! mv -f "$temp_file" "$state_file"; then
    rm -f "$temp_file"
    error "Could not publish DGX Station express resume state under ${state_dir}."
  fi
  assert_station_express_resume_file_safe "$state_file"
  _STATION_EXPRESS_RESUME_REVISION="$revision"
  _STATION_EXPRESS_RESUME_GENERATION="$generation"
  _STATION_EXPRESS_RESUME_AGENT="$agent"
  _STATION_EXPRESS_RESUME_SANDBOX="$sandbox"
  _STATION_EXPRESS_RESUME_POLICY_TIER="$policy_tier"
  _STATION_EXPRESS_RESUME_GATEWAY_PORT="$gateway_port"
  _STATION_EXPRESS_RESUME_DASHBOARD_PORT="$dashboard_port"
  _STATION_EXPRESS_RESUME_VLLM_PORT="$vllm_port"
  _STATION_INSTALL_MODE="$mode"
}

station_express_resume_command() {
  local provider_assignment=""
  if [ "${_STATION_INSTALL_MODE:-express}" = "provider" ]; then
    provider_assignment="NEMOCLAW_PROVIDER=install-vllm "
  fi
  printf 'curl -fsSL https://www.nvidia.com/nemoclaw.sh | %sNEMOCLAW_INSTALL_TAG=%s NEMOCLAW_AGENT=%s NEMOCLAW_SANDBOX_NAME=%s NEMOCLAW_POLICY_TIER=%s NEMOCLAW_GATEWAY_PORT=%s NEMOCLAW_DASHBOARD_PORT=%s NEMOCLAW_VLLM_PORT=%s bash' \
    "$provider_assignment" "$_STATION_EXPRESS_RESUME_REVISION" "$_STATION_EXPRESS_RESUME_AGENT" \
    "$_STATION_EXPRESS_RESUME_SANDBOX" "$_STATION_EXPRESS_RESUME_POLICY_TIER" \
    "$_STATION_EXPRESS_RESUME_GATEWAY_PORT" "$_STATION_EXPRESS_RESUME_DASHBOARD_PORT" \
    "$_STATION_EXPRESS_RESUME_VLLM_PORT"
  if [ "${FORCE_STATION_INSTALL:-}" = "1" ]; then
    printf ' -s -- --force-station-install'
  fi
}

load_station_vllm_conflict_helpers() {
  declare -F handle_station_vllm_conflict >/dev/null 2>&1 && return 0
  local helper="${SCRIPT_DIR}/lib/station-vllm-conflict.sh"
  [[ -f "$helper" ]] || error "Station vLLM conflict helper is missing: ${helper}"
  # shellcheck source=lib/station-vllm-conflict.sh
  . "$helper"
}

clear_station_express_resume() {
  local state_file state_dir claim claim_name claim_mode entry entry_mode unexpected_entry
  state_file="$(station_express_resume_file)" || return 0
  assert_nemoclaw_state_path_safe "$state_file"
  state_dir="$(dirname "$state_file")"
  [[ -e "$state_dir" || -L "$state_dir" ]] || return 0
  assert_station_express_resume_directory_safe "$state_dir"
  if [[ -e "$state_file" || -L "$state_file" ]]; then
    assert_station_express_resume_file_safe "$state_file"
    rm -f "$state_file"
  fi
  for claim in "${state_file}.retiring-"*; do
    [[ -e "$claim" || -L "$claim" ]] || continue
    assert_nemoclaw_state_path_safe "$claim"
    claim_name="${claim##*/}"
    [[ "$claim_name" =~ ^station-express-resume\.retiring-[0-9a-f]{32}-[A-Za-z0-9]+$ ]] \
      || error "DGX Station express receipt retirement claim is malformed: ${claim_name}"
    [[ -d "$claim" && ! -L "$claim" && -O "$claim" ]] \
      || error "Refusing invalid DGX Station express receipt retirement claim: ${claim}"
    claim_mode="$(portable_file_mode "$claim")" \
      || error "Could not inspect DGX Station express receipt retirement claim permissions: ${claim}"
    (((8#$claim_mode & 0077) == 0)) \
      || error "DGX Station express receipt retirement claim must be owner-only: ${claim}"
    unexpected_entry="$(find "$claim" -mindepth 1 -maxdepth 1 ! -name receipt ! -name retired -print -quit)" \
      || error "Could not inspect DGX Station express receipt retirement claim: ${claim}"
    [[ -z "$unexpected_entry" ]] \
      || error "DGX Station express receipt retirement claim contains unexpected state: ${claim}"
    for entry in "$claim/receipt" "$claim/retired"; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      assert_nemoclaw_state_path_safe "$entry"
      [[ -f "$entry" && ! -L "$entry" && -O "$entry" ]] \
        || error "Refusing invalid DGX Station express receipt retirement claim entry: ${entry}"
      entry_mode="$(portable_file_mode "$entry")" \
        || error "Could not inspect DGX Station express receipt retirement claim entry permissions: ${entry}"
      [[ "$entry_mode" == "600" ]] \
        || error "DGX Station express receipt retirement claim entry must have mode 0600: ${entry}"
    done
    for entry in "$claim/receipt" "$claim/retired"; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      rm -f "$entry"
    done
    rmdir "$claim" \
      || error "DGX Station express receipt retirement claim contains unexpected state: ${claim}"
  done
}

# Report the container runtime's operating-system string (e.g. "Docker Desktop"
# or "Ubuntu 24.04.4 LTS"). Bounded with a hard timeout so a wedged,
# misconfigured, or dead-DOCKER_HOST daemon cannot hang the interactive express
# prompt: this runs from describe_express_install before ensure_docker, and WSL
# skips ensure_docker entirely. Empty on timeout or error.
express_wsl_docker_operating_system() {
  timeout 10 docker info --format '{{.OperatingSystem}}' 2>/dev/null
}

# Resolve Docker's effective context name: the DOCKER_CONTEXT override if set,
# otherwise the persisted currentContext from Docker's config (what
# `docker context use` writes). A missing config or a config with no
# currentContext uses Docker's "default"; an unreadable or unparseable config
# fails closed as non-local.
express_wsl_docker_active_context() {
  if [ -n "${DOCKER_CONTEXT:-}" ]; then
    printf '%s' "${DOCKER_CONTEXT}"
    return 0
  fi
  local cfg="${DOCKER_CONFIG:-${HOME:-}/.docker}/config.json"
  local ctx="" parse_status=0
  if [ ! -e "$cfg" ]; then
    printf '%s' "default"
    return 0
  fi
  if [ -e "$cfg" ] && [ ! -r "$cfg" ]; then
    printf '%s' "__unknown__"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    ctx="$(
      node - "$cfg" <<'NODE'
const fs = require("node:fs");

let config;
try {
  config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch {
  process.exit(1);
}
if (config === null || typeof config !== "object" || Array.isArray(config)) process.exit(1);
if (!Object.prototype.hasOwnProperty.call(config, "currentContext")) process.exit(2);
if (typeof config.currentContext !== "string") process.exit(1);
process.stdout.write(config.currentContext);
NODE
    )" || parse_status=$?
    if [ "$parse_status" -eq 0 ]; then
      printf '%s' "$ctx"
      return 0
    fi
    if [ "$parse_status" -eq 2 ]; then
      printf '%s' "default"
      return 0
    fi
    printf '%s' "__unknown__"
    return 0
  fi
  printf '%s' "__unknown__"
}

# True only when the Docker CLI targets the LOCAL default daemon: the active
# context is "default" and no DOCKER_HOST override is set. A DOCKER_HOST, a
# DOCKER_CONTEXT override, or a persisted currentContext other than "default"
# (a context name like desktop-linux is not proof of a local endpoint — it can be
# pointed at a remote daemon) can reach a remote Docker Desktop whose sandbox
# containers cannot reach this machine's Windows-host Ollama (PRA-1). Fails closed
# (non-local) on any non-default, unreadable, or unparseable context.
express_wsl_docker_target_is_local() {
  [ -z "${DOCKER_HOST:-}" ] || return 1
  [ "$(express_wsl_docker_active_context)" = "default" ]
}

# Windows-host Ollama only works through LOCAL Docker Desktop WSL integration
# (host.docker.internal routes to the Windows host). Native Docker Engine (#3695),
# a remote/unknown target, or a failed probe can't reach it, so use WSL-local
# Ollama instead; the onboard provider setup fronts that loopback daemon with
# the sandbox auth proxy when containers cannot reach host loopback (#7318).
express_wsl_can_use_windows_host_ollama() {
  express_wsl_docker_target_is_local || return 1
  express_wsl_docker_operating_system | grep -qi 'docker desktop'
}

# Select the accepted N1x WSL llama.cpp candidate only when Windows product
# identity, WSL architecture, Docker Desktop locality, and the 48 GB GPU class
# all match. Later readiness still requires container GPU proof before launch.
express_wsl_can_use_n1x_managed_llama_cpp() {
  express_wsl_can_use_windows_host_ollama || return 1
  [ "$(uname -m 2>/dev/null | tr -d '[:space:]')" = "aarch64" ] || return 1
  command_exists timeout || return 1
  command_exists powershell.exe || return 1
  command_exists nvidia-smi || return 1

  local product_name=""
  local memory_mb=""
  product_name="$(timeout 10s powershell.exe -NoProfile -NonInteractive -Command '(Get-CimInstance Win32_ComputerSystem).Model' 2>/dev/null | tr -d '\r' | head -n 1)"
  case "$product_name" in
    *"RTX Spark N1X"*) ;;
    *) return 1 ;;
  esac

  memory_mb="$(timeout 10s nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d '[:space:]')"
  case "$memory_mb" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$memory_mb" -ge 48000 ]
}

# True when a readable Docker configuration decides the context but no Node.js can
# parse it yet. The express prompt runs before install_nodejs, so treating that
# window as non-local pinned WSL-local Ollama on hosts whose Docker Desktop
# topology supports Windows-host Ollama, and onboarding then rejected the
# preselected provider (#8199). Selection waits for the runtime instead.
express_wsl_docker_context_needs_node() {
  [ -z "${DOCKER_HOST:-}" ] || return 1
  [ -z "${DOCKER_CONTEXT:-}" ] || return 1
  local cfg="${DOCKER_CONFIG:-${HOME:-}/.docker}/config.json"
  [ -e "$cfg" ] && [ -r "$cfg" ] || return 1
  ! command_exists node
}

# Choose between Windows-host and WSL-local Ollama, or defer when only the
# missing Node.js runtime blocks the decision.
select_express_wsl_provider() {
  _EXPRESS_WSL_PROVIDER_PENDING=""
  unset NEMOCLAW_LLAMACPP_RECIPE
  if express_wsl_can_use_n1x_managed_llama_cpp; then
    export NEMOCLAW_PROVIDER=install-llama-cpp
    export NEMOCLAW_LLAMACPP_RECIPE=llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1
    return 0
  fi
  if express_wsl_can_use_windows_host_ollama; then
    export NEMOCLAW_PROVIDER=install-windows-ollama
    return 0
  fi
  if express_wsl_docker_context_needs_node; then
    _EXPRESS_WSL_PROVIDER_PENDING=1
    return 0
  fi
  export NEMOCLAW_PROVIDER=install-ollama
}

# Finish a deferred Windows WSL selection once install_nodejs has provided the
# runtime that reads the Docker configuration.
resolve_pending_express_wsl_provider() {
  [ "${_EXPRESS_WSL_PROVIDER_PENDING:-}" = "1" ] || return 0
  _EXPRESS_WSL_PROVIDER_PENDING=""
  select_express_wsl_provider
  case "${NEMOCLAW_PROVIDER:-}" in
    install-llama-cpp)
      info "Express install will configure managed Qwen 3.6 35B with llama.cpp on N1x WSL."
      ;;
    install-windows-ollama)
      info "Express install will configure Windows-host Ollama through host.docker.internal."
      ;;
    *)
      info "Express install will configure WSL-local Ollama."
      ;;
  esac
}

select_spark_express_inference() {
  local input_fd="${1:-0}"
  local reply=""

  unset _SPARK_EXPRESS_INFERENCE_SELECTION
  if [ -n "${NEMOCLAW_MODEL:-}" ] || [ -n "${NEMOCLAW_VLLM_MODEL:-}" ]; then
    return 0
  fi

  printf "  Choose the DGX Spark inference setup:\n"
  printf "    1) Managed vLLM with automatic serving-profile selection (default)\n"
  printf "    2) Qwen3.6 35B-A3B NVFP4 with the fixed catalog-backed vLLM profile\n"
  while true; do
    printf "  Choose 1 or 2 [1]: "
    if ! IFS= read -r -u "$input_fd" reply; then
      return 1
    fi
    reply="$(printf "%s" "$reply" | tr '[:upper:]' '[:lower:]')"
    case "$reply" in
      "" | 1)
        _SPARK_EXPRESS_INFERENCE_SELECTION="managed-vllm"
        return 0
        ;;
      2)
        _SPARK_EXPRESS_INFERENCE_SELECTION="fixed-vllm"
        return 0
        ;;
      *)
        warn "Choose 1 or 2."
        ;;
    esac
  done
}

activate_express_install() {
  local platform="$1"
  _SELECTED_EXPRESS_PLATFORM="$platform"
  if [ "$platform" = "DGX Station" ]; then
    _STATION_INSTALL_MODE="express"
  fi
  NON_INTERACTIVE=1
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt
  export NEMOCLAW_YES=1
  export NEMOCLAW_POLICY_MODE=suggested
  unset NEMOCLAW_STATION_EXPRESS
  case "$platform" in
    "DGX Spark")
      export NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      if [ "${_SPARK_EXPRESS_INFERENCE_SELECTION:-managed-vllm}" = "fixed-vllm" ]; then
        if [ -n "${NEMOCLAW_PROVIDER:-}" ] || [ -n "${NEMOCLAW_MODEL:-}" ] \
          || [ -n "${NEMOCLAW_VLLM_MODEL:-}" ] \
          || [ -n "${NEMOCLAW_VLLM_EXTRA_ARGS_JSON:-}" ]; then
          error "The fixed DGX Spark vLLM profile does not accept provider, model, or serve-argument overrides."
        fi
        unset NEMOCLAW_PROVIDER
        export NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE=1
        export NEMOCLAW_LOCAL_MODEL_RUNTIME=vllm
      else
        unset NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE NEMOCLAW_LOCAL_MODEL_RUNTIME
        export NEMOCLAW_PROVIDER=install-vllm
        if [ -n "${NEMOCLAW_VLLM_MODEL:-}" ]; then
          export NEMOCLAW_VLLM_MODEL
        fi
      fi
      ;;
    "N1x")
      export NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      unset NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE NEMOCLAW_LOCAL_MODEL_RUNTIME
      export NEMOCLAW_PROVIDER=install-vllm
      ;;
    "DGX Station")
      export NEMOCLAW_STATION_EXPRESS=1
      if [ -n "${_STATION_EXPRESS_RESUME_GENERATION:-}" ]; then
        export NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION="$_STATION_EXPRESS_RESUME_GENERATION"
      else
        unset NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION
      fi
      export NEMOCLAW_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      export NEMOCLAW_PROVIDER=install-vllm
      configure_station_express_model
      ;;
    "Windows WSL")
      select_express_wsl_provider
      ;;
  esac
}

resume_loaded_station_install() {
  local platform="$1"
  if [ "$_STATION_INSTALL_MODE" = "provider" ]; then
    _SELECTED_EXPRESS_PLATFORM="$platform"
    export NEMOCLAW_PROVIDER=install-vllm
    configure_station_express_model
    info "Detected DGX Station. Resuming the accepted managed-vLLM provider setup after host preparation."
  else
    info "Detected DGX Station. Resuming the accepted express install after host preparation."
    activate_express_install "$platform"
  fi
}

run_station_host_preparation() {
  # Public curl|bash starts in the root bootstrap, which clones the complete
  # selected ref before executing this payload. Keep the sibling lookup and
  # fail-closed check so Station preparation cannot drift from that ref.
  local helper="${SCRIPT_DIR}/prepare-dgx-station-host.sh"
  local -a helper_args=(--apply)
  [[ -f "$helper" ]] || error "DGX Station host preparation helper is missing: ${helper}"
  if [ "${FORCE_STATION_INSTALL:-}" = "1" ]; then
    helper_args+=(--force-station-install)
  fi
  bash "$helper" "${helper_args[@]}" 2>&1 | filter_station_host_preparation_output
}

filter_station_host_preparation_output() {
  local line detail
  while IFS= read -r line; do
    case "$line" in
      *" version="*" log="*)
        info "DGX Station host preparation log: ${line##* log=}"
        ;;
      *" WARNING: "*)
        detail="${line#* WARNING: }"
        warn "$detail"
        ;;
      *" ERROR: "*)
        printf '%s\n' "$line" >&2
        ;;
    esac
  done
}

station_local_default_docker() {
  (
    unset DOCKER_HOST DOCKER_CONTEXT
    docker --context default "$@"
  )
}

station_managed_dual_head_running() {
  command_exists docker || return 1

  local inspection name running managed role schema cluster launch_contract api_fingerprint transaction
  inspection="$(
    station_local_default_docker container inspect --format \
      '{{.Name}} {{.State.Running}} {{index .Config.Labels "com.nvidia.nemoclaw.managed-vllm"}} {{index .Config.Labels "com.nvidia.nemoclaw.vllm-role"}} {{index .Config.Labels "com.nvidia.nemoclaw.vllm-launch-schema"}} {{index .Config.Labels "com.nvidia.nemoclaw.vllm-cluster"}} {{index .Config.Labels "com.nvidia.nemoclaw.vllm-launch-contract"}} {{index .Config.Labels "com.nvidia.nemoclaw.vllm-api-key-fingerprint"}} {{index .Config.Labels "com.nvidia.nemoclaw.vllm-transaction"}}' \
      nemoclaw-vllm 2>/dev/null
  )" || return 1
  read -r name running managed role schema cluster launch_contract api_fingerprint transaction <<<"$inspection"
  [[ "$name" == "/nemoclaw-vllm" &&
    "$running" == "true" &&
    "$managed" == "true" &&
    "$role" == "head" &&
    ("$schema" == "2" || "$schema" == "3") &&
    "$cluster" =~ ^[a-f0-9]{64}$ &&
    "$launch_contract" =~ ^[a-f0-9]{64}$ &&
    "$api_fingerprint" =~ ^[a-f0-9]{64}$ &&
    "$transaction" =~ ^[a-f0-9]{32}$ ]]
}

station_migratable_legacy_single_head_running() {
  command_exists docker || return 1

  local inspection name running image managed role endpoint cluster gpu schema launch_contract api_fingerprint transaction
  inspection="$(
    station_local_default_docker container inspect --format \
      '{{.Name}}|{{.State.Running}}|{{.Config.Image}}|{{with index .Config.Labels "com.nvidia.nemoclaw.managed-vllm"}}{{.}}{{else}}-{{end}}|{{with index .Config.Labels "com.nvidia.nemoclaw.vllm-role"}}{{.}}{{else}}-{{end}}|{{with index .Config.Labels "com.nvidia.nemoclaw.vllm-endpoint"}}{{.}}{{else}}-{{end}}|{{with index .Config.Labels "com.nvidia.nemoclaw.vllm-cluster"}}{{.}}{{else}}-{{end}}|{{with index .Config.Labels "com.nvidia.nemoclaw.vllm-gpu"}}{{.}}{{else}}-{{end}}|{{with index .Config.Labels "com.nvidia.nemoclaw.vllm-launch-schema"}}{{.}}{{else}}-{{end}}|{{with index .Config.Labels "com.nvidia.nemoclaw.vllm-launch-contract"}}{{.}}{{else}}-{{end}}|{{with index .Config.Labels "com.nvidia.nemoclaw.vllm-api-key-fingerprint"}}{{.}}{{else}}-{{end}}|{{with index .Config.Labels "com.nvidia.nemoclaw.vllm-transaction"}}{{.}}{{else}}-{{end}}' \
      nemoclaw-vllm 2>/dev/null
  )" || return 1
  IFS='|' read -r name running image managed role endpoint cluster gpu schema launch_contract api_fingerprint transaction <<<"$inspection"
  [[ "$name" == "/nemoclaw-vllm" &&
    "$running" == "true" &&
    "$image" == "$STATION_ULTRA_LEGACY_VLLM_IMAGE" &&
    "$managed" == "true" &&
    "$role" == "-" &&
    "$endpoint" == "-" &&
    "$cluster" == "-" &&
    "$gpu" == "-" &&
    "$schema" == "-" &&
    "$launch_contract" == "-" &&
    "$api_fingerprint" == "-" &&
    "$transaction" == "-" ]]
}

ensure_station_express_host() {
  [[ "${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]] || return 0

  _STATION_EXPRESS_DEFERRED_MANAGED_PAIR=0
  _STATION_EXPRESS_MIGRATING_LEGACY_HEAD=0
  if station_dual_model_requested && station_managed_dual_head_running; then
    # The host-preparation helper intentionally refuses active workloads. Only
    # this complete dual-head ownership contract may defer local preparation;
    # the post-Node coordinator revalidates the reciprocal physical pair before
    # the existing lifecycle is allowed to reuse it.
    _STATION_EXPRESS_DEFERRED_MANAGED_PAIR=1
    info "Found a complete running NemoClaw-managed dual-Station head candidate; deferring host preparation until reciprocal pair and lifecycle validation, including any required launch-schema replacement."
    return 0
  fi
  if station_dual_model_requested && station_migratable_legacy_single_head_running; then
    # This exact frozen legacy head is the only single-host workload that the
    # dual lifecycle can migrate. Bind its controller without running the
    # workload-rejecting host probes, then prepare the newly qualified peer.
    _STATION_EXPRESS_MIGRATING_LEGACY_HEAD=1
    info "Found the exact running legacy single-Station Ultra head; deferring workload-safe controller binding and reciprocal peer preparation."
    return 0
  fi

  # Publish the accepted, secret-free recipe before the helper can mutate the
  # host. The same receipt then binds reboot/login continuation and onboarding
  # recovery to this exact Express attempt.
  save_station_express_resume

  local release_state
  release_state="$(classify_dgx_station_release)"
  case "$release_state" in
    supported-dgx-os | supported-ai-developer-tools)
      info "Validating the Station factory GPU and local container runtime. Host packages and runtime configuration will not be changed."
      ;;
    supported-colossus-baseos)
      info "Validating the pinned BaseOS package inventory and preparing Docker access and CDI. Host packages and the NVIDIA driver will not be changed."
      ;;
    *)
      if [ "${FORCE_STATION_INSTALL:-}" = "1" ]; then
        warn "Proceeding with explicit --force-station-install intent; only DGX release metadata qualification is bypassed. Station GB300 hardware, workload quiescence, and factory-runtime health checks remain required."
        info "Validating the existing Station GPU and local container runtime. Host packages, the NVIDIA driver, and runtime configuration will not be changed."
      else
        info "Checking pinned DGX Station host prerequisites. Exact matches are reused."
      fi
      ;;
  esac
  local status=0
  run_station_host_preparation || status=$?
  case "$status" in
    0)
      ok "DGX Station host prerequisites are ready"
      ;;
    10)
      warn "DGX Station host prerequisites were installed and require a reboot."
      info "Run: sudo reboot"
      info "After signing in again, rerun the accepted Station Express recipe:"
      info "$(station_express_resume_command)"
      exit 10
      ;;
    11)
      warn "Docker access was granted and requires a new login session. A reboot is not required."
      info "After signing in again, rerun the accepted Station Express recipe:"
      info "$(station_express_resume_command)"
      exit 11
      ;;
    12)
      load_station_vllm_conflict_helpers
      handle_station_vllm_conflict
      ;;
    *)
      error "DGX Station host preparation failed. Review the station-bootstrap log above, correct the reported host state, and rerun the installer."
      ;;
  esac
}

station_dual_pair_resume_file() {
  local state_dir
  state_dir="$(nemoclaw_state_dir)" || return 1
  printf '%s/station-dual-pair-resume.json' "$state_dir"
}

station_dual_pair_resume_pending() {
  local state_file
  state_file="$(station_dual_pair_resume_file)" || return 1
  [[ -e "$state_file" || -L "$state_file" ]] || return 1
  assert_nemoclaw_state_path_safe "$state_file"
  return 0
}

validate_station_pair_selection() {
  [[ "${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]] || return 0
  station_dual_model_requested && return 0
  [ -z "${NEMOCLAW_DGX_STATION_PEER:-}" ] \
    || error "NEMOCLAW_DGX_STATION_PEER requires the DGX Station dual-serving model. Unset NEMOCLAW_VLLM_MODEL or select ${STATION_ULTRA_VLLM_MODEL}; the explicit model override remains authoritative."
  station_dual_pair_resume_pending \
    && error "A dual-DGX Station pair resume is pending; refusing to bypass exact pair revalidation with model '${NEMOCLAW_VLLM_MODEL:-}'."
  return 0
}

parse_station_dual_pair_result() {
  # The single-quoted payload is JavaScript, not shell interpolation.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const net = require("node:net");
    const path = require("node:path");
    const fail = () => process.exit(2);
    try {
      const raw = fs.readFileSync(0, "utf8");
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) fail();
      if (value.kind === "single-station") {
        if (typeof value.reason !== "string" || value.reason.length === 0 || value.reason.length > 4096) fail();
        process.stdout.write("single-station\n");
        process.exit(0);
      }
      if (value.kind !== "ready" && value.kind !== "reboot-required") fail();
      const peer = value.peerTarget;
      if (typeof peer !== "string" || peer.length === 0 || peer.length > 286 || peer !== peer.trim()) fail();
      const parts = peer.split("@");
      if (parts.length > 2) fail();
      const user = parts.length === 2 ? parts[0] : "";
      const host = parts[parts.length - 1];
      const safeUser = /^[A-Za-z_][A-Za-z0-9._-]*$/;
      const safeHost = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
      const numericHost = /^[0-9.]+$/.test(host);
      if ((user && !safeUser.test(user)) || (net.isIP(host) !== 4 && (numericHost || !safeHost.test(host)))) fail();
      const identity = value.identity;
      if (!identity || typeof identity !== "object" || Array.isArray(identity)) fail();
      if (identity.peerTarget !== peer || !/^[a-f0-9]{64}$/.test(identity.hostKeyDigest)) fail();
      if (!/^GPU-[A-Za-z0-9-]+$/.test(identity.localGpuUuid) || !/^GPU-[A-Za-z0-9-]+$/.test(identity.peerGpuUuid)) fail();
      if (!Array.isArray(identity.rails) || identity.rails.length !== 2) fail();
      const mac = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
      for (const rail of identity.rails) {
        if (!rail || typeof rail !== "object" || Array.isArray(rail)) fail();
        if (net.isIP(rail.localAddress) !== 4 || net.isIP(rail.peerAddress) !== 4) fail();
        if (!mac.test(rail.localMac) || !mac.test(rail.peerMac)) fail();
      }
      const token = value.sshBinding;
      if (typeof token !== "string" || token.length === 0 || token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token)) fail();
      let handoff;
      try {
        const decoded = Buffer.from(token, "base64url");
        if (decoded.toString("base64url") !== token) fail();
        handoff = JSON.parse(decoded.toString("utf8"));
      } catch {
        fail();
      }
      if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) fail();
      if (JSON.stringify(Object.keys(handoff).sort()) !== JSON.stringify(["bindingFile", "hostKeyDigest"])) fail();
      const bindingFile = handoff.bindingFile;
      if (typeof bindingFile !== "string" || bindingFile.length === 0 || bindingFile.length > 4096 || bindingFile !== bindingFile.trim() || /[\u0000-\u001f\u007f]/.test(bindingFile)) fail();
      if (!path.isAbsolute(bindingFile) || path.normalize(bindingFile) !== bindingFile) fail();
      if (handoff.hostKeyDigest !== identity.hostKeyDigest) fail();
      process.stdout.write(`${value.kind}\n${peer}\n${token}\n`);
    } catch {
      fail();
    }
  '
}

ensure_station_express_pair() {
  [[ "${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]] || return 0
  validate_station_pair_selection
  if ! station_dual_model_requested; then
    return 0
  fi

  local coordinator="${SCRIPT_DIR}/prepare-dual-dgx-station.mts"
  local helper="${SCRIPT_DIR}/prepare-dgx-station-host.sh"
  [[ -f "$coordinator" ]] || error "Dual DGX Station preparation coordinator is missing: ${coordinator}"
  [[ -f "$helper" ]] || error "DGX Station host preparation helper is missing: ${helper}"

  local state_dir state_file revision output parsed kind peer_target ssh_binding status=0
  state_dir="$(ensure_nemoclaw_state_dir)" || error "Could not prepare owner-only NemoClaw state for dual DGX Station discovery."
  state_file="${state_dir}/station-dual-pair-resume.json"
  assert_nemoclaw_state_path_safe "$state_file"
  revision="$(station_installer_revision)"

  local -a pair_command=(
    node --no-warnings --experimental-strip-types "$coordinator"
    --helper "$helper"
    --state "$state_file"
    --revision "$revision"
  )
  if [ -n "${NEMOCLAW_DGX_STATION_PEER:-}" ]; then
    pair_command+=(--explicit-peer "$NEMOCLAW_DGX_STATION_PEER")
  fi
  if [ "${_STATION_EXPRESS_DEFERRED_MANAGED_PAIR:-0}" = "1" ]; then
    pair_command+=(--reuse-existing-managed-pair)
  fi
  if [ "${_STATION_EXPRESS_MIGRATING_LEGACY_HEAD:-0}" = "1" ]; then
    pair_command+=(--migrate-legacy-single-head)
  fi

  info "Checking for one pretrusted reciprocal dual-DGX Station peer on the two direct /30 rail counterparts."
  # Publish the companion mode/model state before the coordinator can persist
  # pair identity and mutate the remote host. A crash, mismatch, or later
  # onboarding failure must resume this exact accepted setup without returning
  # to a prompt or silently falling back.
  save_station_express_resume
  output="$("${pair_command[@]}")" || status=$?
  case "$status" in
    0 | 10) ;;
    *)
      if ! station_dual_pair_resume_pending; then
        clear_station_express_resume
      fi
      error "Dual DGX Station preparation failed. No serving-model or vLLM-image pull was started; review the station-pair diagnostics above and rerun the same revision."
      ;;
  esac
  if ! parsed="$(printf '%s' "$output" | parse_station_dual_pair_result)"; then
    if ! station_dual_pair_resume_pending; then
      clear_station_express_resume
    fi
    error "Dual DGX Station preparation returned invalid result data; refusing to continue."
  fi
  kind="$(printf '%s\n' "$parsed" | sed -n '1p')"
  peer_target="$(printf '%s\n' "$parsed" | sed -n '2p')"
  ssh_binding="$(printf '%s\n' "$parsed" | sed -n '3p')"

  case "$kind" in
    single-station)
      [ "$status" -eq 0 ] \
        || error "Dual DGX Station preparation returned an inconsistent reboot result; refusing to continue."
      [ "${_STATION_EXPRESS_DEFERRED_MANAGED_PAIR:-0}" != "1" ] \
        || error "The running managed dual-Station head could not be matched to its trusted reciprocal peer; refusing single-Station fallback."
      [ "${_STATION_EXPRESS_MIGRATING_LEGACY_HEAD:-0}" != "1" ] \
        || error "The running legacy single-Station head could not be matched to a trusted reciprocal peer; refusing migration and single-Station fallback."
      [ -z "${NEMOCLAW_DGX_STATION_PEER:-}" ] \
        || error "The explicit DGX Station peer could not be qualified; refusing single-Station fallback."
      station_dual_pair_resume_pending \
        && error "Dual DGX Station preparation returned a single-Station result while exact pair resume state is pending; refusing to discard it."
      if [ "${_STATION_EXPRESS_MODEL_WAS_EXPLICIT:-0}" = "0" ]; then
        NEMOCLAW_VLLM_MODEL="$STATION_ULTRA_VLLM_MODEL"
        NEMOCLAW_MODEL="$STATION_ULTRA_SERVED_MODEL"
        export NEMOCLAW_VLLM_MODEL NEMOCLAW_MODEL
      fi
      unset NEMOCLAW_DGX_STATION_SSH_BINDING
      info "No eligible reciprocal dual-DGX Station pair is available; using the existing single-Station Ultra recipe."
      ;;
    ready)
      [ "$status" -eq 0 ] \
        || error "Dual DGX Station preparation returned an inconsistent ready result; refusing to continue."
      station_dual_pair_resume_pending \
        || error "Dual DGX Station preparation returned ready without exact pair resume state; refusing to continue."
      NEMOCLAW_DGX_STATION_PEER="$peer_target"
      NEMOCLAW_DGX_STATION_SSH_BINDING="$ssh_binding"
      export NEMOCLAW_DGX_STATION_PEER NEMOCLAW_DGX_STATION_SSH_BINDING
      NEMOCLAW_MODEL="$STATION_ULTRA_DUAL_SERVED_MODEL"
      export NEMOCLAW_MODEL
      if [ "${_STATION_EXPRESS_MODEL_WAS_EXPLICIT:-0}" = "0" ]; then
        NEMOCLAW_VLLM_MODEL="$STATION_ULTRA_VLLM_MODEL"
        export NEMOCLAW_VLLM_MODEL
      fi
      ok "Trusted reciprocal dual-DGX Station pair is ready (${peer_target})"
      ;;
    reboot-required)
      [ "$status" -eq 10 ] \
        || error "Dual DGX Station preparation returned an inconsistent reboot result; refusing to continue."
      station_dual_pair_resume_pending \
        || error "Dual DGX Station preparation requested a reboot without exact pair resume state; refusing to continue."
      save_station_express_resume
      warn "Peer DGX Station ${peer_target} was prepared and requires a manual reboot."
      info "On peer ${peer_target}, run: sudo reboot"
      info "After the peer is back online, rerun the accepted revision on this Station:"
      info "$(station_express_resume_command)"
      exit 10
      ;;
    *)
      error "Dual DGX Station preparation returned an unsupported result; refusing to continue."
      ;;
  esac
}

clear_station_dual_pair_resume() {
  local state_file coordinator="${SCRIPT_DIR}/prepare-dual-dgx-station.mts"
  state_file="$(station_dual_pair_resume_file)" || return 0
  assert_nemoclaw_state_path_safe "$state_file"
  [[ -e "$state_file" || -L "$state_file" || -e "${state_file}.ssh-binding" || -L "${state_file}.ssh-binding" ]] || return 0
  [[ -f "$coordinator" ]] || error "Dual DGX Station preparation coordinator is missing: ${coordinator}"
  node --no-warnings --experimental-strip-types "$coordinator" --state "$state_file" --clear-state >/dev/null \
    || error "Could not safely clear completed dual DGX Station resume state: ${state_file}"
}

prepare_installer_host() {
  maybe_offer_express_install
  # Reject conflicting explicit Station selections and pending-pair bypasses
  # before the local host-preparation helper can mutate packages or Docker.
  validate_station_pair_selection
  if [[ "${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]]; then
    # Station qualification is deliberately scoped to the local factory
    # runtime. Normalize the Docker target before any preparation probe so an
    # ambient remote context can neither satisfy nor be changed by this path.
    unset DOCKER_HOST
    export DOCKER_CONTEXT=default
  fi
  # Intentional ordering: Station preparation owns the reboot boundary before
  # generic Docker bootstrap; ensure_station_express_host is a no-op elsewhere.
  ensure_station_express_host
  prepare_portable_experimental_runtime_override
  ensure_docker
  ensure_openshell_build_deps
}

# Prompt the user to opt into express install on qualified platforms or the
# Deferred N1x preview. Sets non-interactive + provider/model env vars when accepted. Skipped when
# the user already passed --non-interactive, set NEMOCLAW_PROVIDER, or has
# no TTY.
describe_express_install() {
  local platform="$1"
  local inference_summary=""
  local inference_disclosure=""
  local show_hf_authentication="0"
  local sandbox_summary=""
  local tier="${NEMOCLAW_POLICY_TIER:-balanced}"
  local policy_summary=""

  case "$platform" in
    "DGX Spark")
      if [ "${_SPARK_EXPRESS_INFERENCE_SELECTION:-managed-vllm}" = "fixed-vllm" ]; then
        inference_summary="Qwen3.6 35B-A3B NVFP4 with the fixed catalog-backed vLLM profile"
        inference_disclosure="The serving catalog owns the model, image, and vLLM arguments. The installer rejects provider and model overrides, and the dedicated local-model onboarder rejects vLLM model and serve-argument overrides before starting its managed container. NEMOCLAW_VLLM_PORT may override the host listener."
      elif [ -n "${NEMOCLAW_VLLM_MODEL:-}" ]; then
        inference_summary="managed local vLLM with model ${NEMOCLAW_VLLM_MODEL}"
        inference_disclosure="The explicit model remains authoritative, so this run keeps the existing single-host DGX Spark profile. Managed vLLM pulls the configured image/model and runs only its dedicated container."
      elif [ -n "${NEMOCLAW_MODEL:-}" ]; then
        inference_summary="managed local vLLM with explicit model intent ${NEMOCLAW_MODEL}"
        inference_disclosure="The explicit model remains authoritative, so this run keeps the customizable managed-vLLM path and does not offer the fixed profile."
      else
        inference_summary="managed vLLM with automatic DGX Spark serving-profile selection"
        inference_disclosure="With no explicit inference intent or related runtime, one exactly qualified pretrusted managed cluster topology selects a matching pinned distributed profile. An ordinary no-match keeps the existing single-host DGX Spark profile; any related or ambiguous setup remains untouched and stops installation. Managed vLLM pulls the selected image/model and runs only its dedicated containers. The selected distributed profile is experimental pending physical end-to-end validation."
      fi
      sandbox_summary="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      ;;
    "N1x")
      inference_summary="managed local vLLM with Qwen3.6 35B-A3B NVFP4"
      inference_disclosure="N1x Express is a Deferred preview pending a physical NemoClaw Express E2E run; accepting this prompt is explicit preview intent, not a supported-platform claim. The N1x profile uses one host and does not activate DGX Spark cluster discovery or fixed catalog behavior. Managed vLLM pulls the pinned image and model only after the existing CUDA and CDI readiness checks pass."
      sandbox_summary="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      ;;
    "DGX Station")
      if [ "${STATION_DEEPSEEK:-}" = "1" ]; then
        show_hf_authentication="1"
        inference_summary="managed local vLLM with DeepSeek V4 Flash"
        inference_disclosure="Managed vLLM pulls the configured Station image/model and runs a local inference container."
      elif [ -n "$(printf "%s" "${NEMOCLAW_VLLM_MODEL:-}" | tr -d '[:space:]')" ]; then
        inference_summary="managed local vLLM with model ${NEMOCLAW_VLLM_MODEL}"
        inference_disclosure="Managed vLLM pulls the configured vLLM image/model and runs a local inference container."
        case "$(printf "%s" "${NEMOCLAW_VLLM_MODEL}" | tr '[:upper:]' '[:lower:]')" in
          deepseek-v4-flash | deepseek-ai/deepseek-v4-flash | nemotron-3-ultra-550b-a55b | nvidia/nvidia-nemotron-3-ultra-550b-a55b-nvfp4)
            show_hf_authentication="1"
            ;;
        esac
      else
        show_hf_authentication="1"
        inference_summary="managed local vLLM with NVIDIA Nemotron 3 Ultra 550B and automatic Station topology selection"
        inference_disclosure="A pretrusted reciprocal dual-Station pair selects distributed serving; otherwise NemoClaw uses the existing single-Station Ultra recipe. The pinned image and approximately 352 GB model are pulled only after topology qualification."
      fi
      case "$(classify_dgx_station_release)" in
        supported-dgx-os)
          printf "  Stock DGX OS setup reuses the factory driver and container stack after local GPU device-visibility, CDI, Docker, and Buildx validation. It does not install or replace host packages or rewrite the Docker runtime.\n"
          ;;
        supported-colossus-baseos)
          printf "  Qualified BaseOS setup preserves the factory kernel, driver, DKMS, Docker, and NVIDIA Container Toolkit packages. It verifies their exact inventory, prepares Docker access and packaged CDI, and registers the NVIDIA Docker runtime only when the launch probe proves it is missing, with rollback on failure. It does not install host packages or require a reboot.\n"
          ;;
        supported-ai-developer-tools)
          printf "  Factory Ubuntu with NVIDIA AI Developer Tools reuses its driver and container stack after local GPU, CDI, Docker, and Buildx validation. It may add this account to the Docker group, but does not install or replace host packages, rewrite the Docker runtime, or require a reboot.\n"
          ;;
        *)
          if [ "${FORCE_STATION_INSTALL:-}" = "1" ]; then
            printf "  Explicit --force-station-install intent bypasses only DGX release-metadata qualification. Active agent and unrelated Docker workloads still block Station preparation; an existing vLLM workload receives explicit handling choices. Setup preserves the existing driver and container stack and proceeds only after Station GB300, GPU, ECC, Docker, Buildx, Toolkit, CDI, and container GPU-visibility checks pass.\n"
          else
            printf "  Station host setup reuses exact prerequisite versions, applies the reviewed factory DKMS transition when present, installs missing pinned driver, Docker, and NVIDIA Container Toolkit packages, and may require one reboot.\n"
          fi
          ;;
      esac
      printf "  Host setup may add this trusted local account to the docker group, which grants root-equivalent control. This flow is only for trusted single-user development hosts; shared or managed hosts require an organization-approved Docker access path.\n"
      printf "  DGX Station is Tested with limitations across qualified profiles on one physical DGX Station GB300; dual-Station configurations are not yet validated, and dedicated CI coverage is not available.\n"
      sandbox_summary="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
      ;;
    "Windows WSL")
      if express_wsl_can_use_n1x_managed_llama_cpp; then
        show_hf_authentication="1"
        inference_summary="managed Qwen 3.6 35B with llama.cpp on N1x WSL"
        inference_disclosure="Managed llama.cpp downloads a pinned 20.4 GB GGUF file before it starts the loopback-only authenticated server."
      elif express_wsl_can_use_windows_host_ollama; then
        inference_summary="Windows-host Ollama through host.docker.internal"
      elif express_wsl_docker_context_needs_node; then
        inference_summary="local inference, selected once the installed Node.js runtime reads the Docker configuration"
      else
        inference_summary="WSL-local Ollama, with a sandbox auth proxy when containers cannot reach host loopback"
      fi
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
    personal)
      policy_summary="base sandbox policy plus TCP egress from every sandbox binary to public and private address ranges on destination ports 80 and 443"
      policy_summary="${policy_summary} (excluding unspecified, loopback, and link-local ranges), every maintained applicable preset, and local-inference access when needed"
      ;;
    *)
      policy_summary="base sandbox policy plus tier presets supported by the active agent"
      policy_summary="${policy_summary}, and local-inference access when needed"
      ;;
  esac

  if [ "$platform" = "N1x" ]; then
    printf "  The Deferred N1x preview will configure %s.\n" "$inference_summary"
  else
    printf "  Express install will configure %s.\n" "$inference_summary"
  fi
  if [ -n "$inference_disclosure" ]; then
    printf "  %s\n" "$inference_disclosure"
  fi
  if [ "$show_hf_authentication" = "1" ]; then
    describe_hf_download_authentication
  fi
  printf "  Sandbox name: %s.\n" "$sandbox_summary"
  printf "  It runs onboarding non-interactively, but still prompts for sudo when host setup needs it.\n"
  printf "  Sandbox policy: suggested mode, tier '%s'. This uses the %s.\n" "$tier" "$policy_summary"
}

describe_hf_download_authentication() {
  local hf_token="${HF_TOKEN:-}"
  local hugging_face_hub_token="${HUGGING_FACE_HUB_TOKEN:-}"
  if [[ -n "${hf_token//[[:space:]]/}" || -n "${hugging_face_hub_token//[[:space:]]/}" ]]; then
    printf "  Hugging Face model download: authenticated.\n"
    printf "  The token value is not displayed and is passed only to the temporary model downloader.\n"
    return 0
  fi

  printf "  Hugging Face authentication is optional for this public model but recommended for this large download.\n"
  printf "  Anonymous downloads may be rate-limited with HTTP 429.\n"
  printf "  Create a read token at https://huggingface.co/settings/tokens.\n"
  printf "  Before restarting the installer, run: export HF_TOKEN=<read-token>\n"
  printf "  The token is passed only to the temporary model downloader.\n"
}

maybe_offer_express_install() {
  local platform resume_file
  platform="$(detect_express_platform)"
  validate_express_platform_boundary "$platform"
  validate_force_station_install_override "$platform"
  validate_station_deepseek_override "$platform"

  if [ "$platform" = "DGX Station" ]; then
    resume_file="$(station_express_resume_file)" \
      || error "Cannot resolve the DGX Station express resume state path. Refusing to continue without resume state."
  fi

  # Pair state is written before remote mutation. It therefore outranks every
  # prompt/skip path and must recover the companion exact-revision mode/model
  # state before any generic or single-Station setup can continue.
  if station_dual_pair_resume_pending; then
    [ "$platform" = "DGX Station" ] \
      || error "A dual-DGX Station pair resume is pending, but this host no longer satisfies the DGX Station preparation boundary. Refusing to continue without exact pair revalidation."
    [ "${NEMOCLAW_NO_EXPRESS:-}" != "1" ] \
      || error "A dual-DGX Station pair resume is pending; finish exact pair revalidation before disabling Station setup."
    case "${NEMOCLAW_PROVIDER:-}" in
      "") ;;
      install-vllm) _STATION_INSTALL_MODE="provider" ;;
      *) error "A dual-DGX Station pair resume is pending; finish exact pair revalidation before changing providers." ;;
    esac
    load_station_express_resume \
      || error "Dual-DGX Station pair state exists without its required installer resume state. Refusing to prompt, fall back, or continue; restore the owner-only state from the accepted revision."
    resume_loaded_station_install "$platform"
    return 0
  fi
  # Not on a platform we have an express recipe for — say nothing.
  if [ -z "$platform" ]; then
    return 0
  fi
  # On a detected Express platform but a skip condition applies — explain why so
  # the user understands they could have gotten express otherwise.
  if [ "${NEMOCLAW_NO_EXPRESS:-}" = "1" ]; then
    if [ "$platform" = "N1x" ] && [ "${NEMOCLAW_PROVIDER:-}" != "install-vllm" ]; then
      error "N1x onboarding currently requires explicit Deferred managed-vLLM preview intent. Remove NEMOCLAW_NO_EXPRESS=1 and accept the preview, or set NEMOCLAW_PROVIDER=install-vllm."
    fi
    if [ "$platform" = "DGX Station" ]; then
      station_dual_pair_resume_pending \
        && error "A dual-DGX Station pair resume is pending; finish exact pair revalidation before disabling Station setup."
      clear_station_express_resume
    fi
    info "Detected ${platform}. Skipping express prompt (NEMOCLAW_NO_EXPRESS=1)."
    return 0
  fi
  if [ -n "${NEMOCLAW_PROVIDER:-}" ]; then
    if [ "$platform" = "N1x" ] && [ "$NEMOCLAW_PROVIDER" != "install-vllm" ]; then
      error "N1x onboarding currently accepts only the Deferred managed-vLLM preview. Set NEMOCLAW_PROVIDER=install-vllm or use another host for provider ${NEMOCLAW_PROVIDER}."
    fi
    if [ "$platform" = "DGX Station" ] && [ "$NEMOCLAW_PROVIDER" = "install-vllm" ]; then
      # An explicit managed-vLLM provider selects the same Station host/pair
      # preparation boundary without forcing the rest of the express policy.
      # Honor an existing exact-revision reboot resume before configuration.
      _STATION_INSTALL_MODE="provider"
      if [[ -e "$resume_file" || -L "$resume_file" ]]; then
        load_station_express_resume
      fi
      _SELECTED_EXPRESS_PLATFORM="$platform"
      configure_station_express_model
      info "Detected ${platform}. Using Station preparation for the explicitly selected managed-vLLM provider."
      return 0
    fi
    if [ "$platform" = "DGX Station" ]; then
      station_dual_pair_resume_pending \
        && error "A dual-DGX Station pair resume is pending; finish exact pair revalidation before changing providers."
      clear_station_express_resume
    fi
    info "Detected ${platform}. Skipping express prompt (NEMOCLAW_PROVIDER=${NEMOCLAW_PROVIDER} already set)."
    return 0
  fi
  if [ "$platform" = "DGX Station" ] && [[ -e "$resume_file" || -L "$resume_file" ]]; then
    load_station_express_resume
    resume_loaded_station_install "$platform"
    return 0
  fi
  if [ "${NON_INTERACTIVE:-}" = "1" ]; then
    info "Detected ${platform}. Skipping express prompt (--non-interactive set)."
    return 0
  fi
  local reply=""
  if [ -t 0 ]; then
    info "Detected ${platform}."
    if [ "$platform" = "DGX Spark" ] && ! select_spark_express_inference 0; then
      info "Skipping express install (unable to read from TTY)."
      return 0
    fi
    describe_express_install "$platform"
    if [ "$platform" = "N1x" ]; then
      printf "  Run the Deferred N1x preview with these settings? [Y/n]: "
    else
      printf "  Run express install with these settings? [Y/n]: "
    fi
    if ! IFS= read -r reply; then
      if [ "${FORCE_STATION_INSTALL:-}" = "1" ]; then
        fail_force_station_terminal_required
      elif [ "${STATION_DEEPSEEK:-}" = "1" ]; then
        fail_station_deepseek_terminal_required
      fi
      info "Skipping express install (unable to read from TTY)."
      return 0
    fi
  elif { exec 3</dev/tty; } 2>/dev/null; then
    info "Detected ${platform}."
    if [ "$platform" = "DGX Spark" ] && ! select_spark_express_inference 3; then
      exec 3<&-
      info "Skipping express install (unable to read from TTY)."
      return 0
    fi
    describe_express_install "$platform"
    if [ "$platform" = "N1x" ]; then
      printf "  Run the Deferred N1x preview with these settings? [Y/n]: "
    else
      printf "  Run express install with these settings? [Y/n]: "
    fi
    if ! IFS= read -r reply <&3; then
      exec 3<&-
      if [ "${FORCE_STATION_INSTALL:-}" = "1" ]; then
        fail_force_station_terminal_required
      elif [ "${STATION_DEEPSEEK:-}" = "1" ]; then
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
      if [ "$platform" = "N1x" ]; then
        info "Using the Deferred N1x preview."
      else
        info "Using express install for ${platform}."
      fi
      activate_express_install "$platform"
      ;;
    *)
      if [ "$platform" = "N1x" ]; then
        error "N1x onboarding currently requires the Deferred managed-vLLM preview. Re-run the installer and accept the preview, or set NEMOCLAW_PROVIDER=install-vllm."
      fi
      info "Skipping express install. Continuing with interactive flow."
      ;;
  esac
}

# The qualification runner calls these phases without starting onboarding.
# ---------------------------------------------------------------------------
install_nemoclaw_before_onboarding() {
  _INSTALL_START=$SECONDS
  bash "${SCRIPT_DIR}/setup-jetson.sh"

  step 1 "Node.js"
  install_nodejs
  ensure_supported_runtime
  resolve_pending_express_wsl_provider
  ensure_station_express_pair

  step 2 "${_CLI_DISPLAY} CLI"
  # Ollama and vLLM install/upgrade and model pulls are owned by
  # `nemoclaw onboard` (the install-ollama / install-vllm branches).
  # install.sh stays focused on dependency setup.
  fix_npm_permissions
  preinstall_backup_and_retire_legacy_gateway
  install_nemoclaw
  verify_nemoclaw
  require_reportable_openshell_version
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
  DEFER_ONBOARDING=""
  FRESH=""
  STATION_DEEPSEEK=""
  FORCE_STATION_INSTALL=""
  LOCAL_MODEL_RUNTIME=""
  EXPERIMENTAL_PROFILE="${NEMOCLAW_EXPERIMENTAL_PROFILE:-}"
  local expect_experimental_profile=""
  for arg in "$@"; do
    if [[ "$expect_experimental_profile" == "1" ]]; then
      EXPERIMENTAL_PROFILE="$arg"
      expect_experimental_profile=""
      continue
    fi
    case "$arg" in
      --non-interactive)
        NON_INTERACTIVE=1
        NON_INTERACTIVE_SOURCE="the --non-interactive flag"
        ;;
      --yes-i-accept-third-party-software) ACCEPT_THIRD_PARTY_SOFTWARE=1 ;;
      --defer-onboarding) DEFER_ONBOARDING=1 ;;
      --fresh) FRESH=1 ;;
      --station-deepseek) STATION_DEEPSEEK=1 ;;
      --force-station-install) FORCE_STATION_INSTALL=1 ;;
      --local-model-runtime=*)
        LOCAL_MODEL_RUNTIME="${arg#--local-model-runtime=}"
        case "$LOCAL_MODEL_RUNTIME" in
          vllm) ;;
          *) error "--local-model-runtime must be vllm; select install-llama-cpp with NEMOCLAW_PROVIDER" ;;
        esac
        NON_INTERACTIVE=1
        NON_INTERACTIVE_SOURCE="the --local-model-runtime flag"
        ;;
      --experimental-profile) expect_experimental_profile=1 ;;
      --experimental-profile=*) EXPERIMENTAL_PROFILE="${arg#*=}" ;;
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
  [[ -z "$expect_experimental_profile" ]] \
    || error "Missing value for --experimental-profile (expected: portable)."
  case "$EXPERIMENTAL_PROFILE" in
    "") unset NEMOCLAW_EXPERIMENTAL_PROFILE ;;
    portable) export NEMOCLAW_EXPERIMENTAL_PROFILE="$EXPERIMENTAL_PROFILE" ;;
    *) error "Unknown experimental profile: $EXPERIMENTAL_PROFILE (expected: portable)." ;;
  esac
  # Also honor env var
  NON_INTERACTIVE="${NON_INTERACTIVE:-${NEMOCLAW_NON_INTERACTIVE:-}}"
  if [ "${NON_INTERACTIVE:-}" = "1" ] && [ -z "${NON_INTERACTIVE_SOURCE:-}" ]; then
    NON_INTERACTIVE_SOURCE="NEMOCLAW_NON_INTERACTIVE=1"
  fi
  ACCEPT_THIRD_PARTY_SOFTWARE="${ACCEPT_THIRD_PARTY_SOFTWARE:-${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}}"
  DEFER_ONBOARDING="${DEFER_ONBOARDING:-${NEMOCLAW_DEFER_ONBOARDING:-}}"
  FRESH="${FRESH:-${NEMOCLAW_FRESH:-}}"
  if [ -n "${LOCAL_MODEL_RUNTIME:-}" ]; then
    export NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE=1
    export NEMOCLAW_LOCAL_MODEL_RUNTIME="$LOCAL_MODEL_RUNTIME"
    export NEMOCLAW_NO_EXPRESS=1
  elif [ "${NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE:-}" = "1" ]; then
    case "${NEMOCLAW_LOCAL_MODEL_RUNTIME:-}" in
      vllm) ;;
      *) error "NEMOCLAW_LOCAL_MODEL_RUNTIME must be vllm; select install-llama-cpp with NEMOCLAW_PROVIDER" ;;
    esac
    NON_INTERACTIVE=1
    NON_INTERACTIVE_SOURCE="NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE=1"
    export NEMOCLAW_NO_EXPRESS=1
  fi
  if [ "${NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE:-}" = "1" ] \
    && { [ -n "${NEMOCLAW_PROVIDER:-}" ] || [ -n "${NEMOCLAW_MODEL:-}" ]; }; then
    error "The local model profile does not accept NEMOCLAW_PROVIDER or NEMOCLAW_MODEL overrides."
  fi
  validate_deferred_hermes_onboarding_request
  # If the user explicitly accepted the third-party-software notice, treat
  # that as non-interactive intent for the rest of the run too — show_usage_notice
  # is only one of several phase-3 steps that need a TTY or --non-interactive
  # (run_onboard has the same gate). Without this, ACCEPT_THIRD_PARTY_SOFTWARE=1
  # alone clears the preflight below but the install can still partial-fail at
  # run_onboard with the same TTY error, leaving phases 1/2 on disk anyway.
  #
  # #7008: Station-only prompt flags are the exception — they explicitly select
  # the interactive DGX Station express prompt, so accepting the notice must NOT
  # imply non-interactive there. The two signals are orthogonal: one accepts a
  # license, the other opts into an interactive express flow. Inferring
  # non-interactive from the notice would make the express flow reject its own
  # required flag validation.
  if [ "${ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ] && [ "${NON_INTERACTIVE:-}" != "1" ] \
    && [ "${STATION_DEEPSEEK:-}" != "1" ] && [ "${FORCE_STATION_INSTALL:-}" != "1" ]; then
    NON_INTERACTIVE=1
  fi

  export NEMOCLAW_NON_INTERACTIVE="${NON_INTERACTIVE}"
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${ACCEPT_THIRD_PARTY_SOFTWARE}"

  load_station_vllm_conflict_helpers
  if consume_station_local_vllm_resume; then
    info "Resuming the selected manual Local vLLM setup."
  fi

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

  # Offer express install on accepted platforms (DGX Spark / Station / N1x / WSL).
  # Runs AFTER the third-party notice so the user has explicitly accepted the
  # license before opting into the unattended path. Express only sets the
  # provider/model/policy + non-interactive vars; license acceptance is
  # already recorded by preflight above. Station selection runs its pinned
  # host prerequisite preparation before the generic Docker bootstrap.
  prepare_installer_host

  # Express selection can change the provider after the initial argument
  # validation. Recheck the deferred-onboarding scope before installation.
  validate_deferred_hermes_onboarding_request

  install_nemoclaw_before_onboarding

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
    if should_defer_hermes_onboarding "$_registered_sandbox_count"; then
      info "NVIDIA inference credentials are absent. Hermes onboarding did not run."
    elif run_installer_host_preflight; then
      if ! recover_preexisting_sandboxes_before_onboard "$_cli_runner"; then
        finalize_install
        return 1
      fi
      if [[ "${_PREEXISTING_SANDBOX_RECOVERY_RAN:-false}" == true ]]; then
        if [[ "${_PREEXISTING_SANDBOX_ORPHANED:-false}" == true ]]; then
          # #6520: do not claim recovery when recorded sandboxes are stranded.
          warn "Some recorded sandboxes could not be recovered; skipping generic onboarding."
        elif [[ "${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]] \
          || [[ "${_STATION_EXPRESS_RESUME_LOADED:-}" == "1" ]] \
          || station_express_receipt_retirement_pending; then
          info "Existing sandboxes recovered; reconciling DGX Station Express onboarding state."
          run_onboard || fail_onboarding "$?"
          ONBOARD_RAN=true
        else
          info "Existing sandboxes recovered; skipping generic onboarding."
        fi
      else
        run_onboard || fail_onboarding "$?"
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
  clear_station_resume_after_completed_onboarding
}

clear_station_resume_after_completed_onboarding() {
  [[ "${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]] || return 0
  [[ "${ONBOARD_RAN:-false}" == true ]] || return 0
  clear_station_dual_pair_resume
  clear_station_express_resume
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
  if [[ "${_STATION_LOCAL_VLLM_SELECTED:-}" == "1" ]]; then
    clear_station_local_vllm_resume
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
      && curl -fsSL --proto '=https' --proto-redir '=https' "$_installer_url" -o "$_staged" 2>/dev/null \
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
