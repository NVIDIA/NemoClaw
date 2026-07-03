#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${NEMOCLAW_DEV_DOCTOR_REPO_ROOT:-$(cd -- "${SCRIPT_DIR}/.." && pwd)}"
CLI_BUILD_ARTIFACT="${NEMOCLAW_DEV_DOCTOR_CLI_ARTIFACT:-${REPO_ROOT}/dist/nemoclaw.js}"
PLUGIN_BUILD_ARTIFACT="${NEMOCLAW_DEV_DOCTOR_PLUGIN_ARTIFACT:-${REPO_ROOT}/nemoclaw/dist/index.js}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

usage() {
  cat <<'EOF'
Usage: ./scripts/dev-setup.sh --doctor

Run read-only checks for a NemoClaw contributor environment.
The doctor never installs packages, changes configuration, or starts services.
EOF
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  ✓ %s\n' "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '  ! %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '    Next: %s\n' "$2"
  fi
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  ✗ %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '    Next: %s\n' "$2"
  fi
}

first_line() {
  printf '%s\n' "$1" | sed -n '1p'
}

extract_version() {
  printf '%s\n' "$1" | sed -E 's/^[^0-9]*([0-9]+([.][0-9]+){0,2}).*/\1/'
}

version_at_least() {
  local actual="$1"
  local required="$2"
  local actual_major actual_minor actual_patch required_major required_minor required_patch

  IFS=. read -r actual_major actual_minor actual_patch <<<"${actual}"
  IFS=. read -r required_major required_minor required_patch <<<"${required}"
  actual_minor="${actual_minor:-0}"
  actual_patch="${actual_patch:-0}"
  required_minor="${required_minor:-0}"
  required_patch="${required_patch:-0}"

  if ((actual_major != required_major)); then
    ((actual_major > required_major))
    return
  fi
  if ((actual_minor != required_minor)); then
    ((actual_minor > required_minor))
    return
  fi
  ((actual_patch >= required_patch))
}

check_minimum_version() {
  local label="$1"
  local command_name="$2"
  local minimum="$3"
  local remediation="$4"
  local output version

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    fail "${label}: not found" "${remediation}"
    return
  fi
  if ! output="$("${command_name}" --version 2>/dev/null)"; then
    fail "${label}: version check failed" "${remediation}"
    return
  fi
  version="$(extract_version "$(first_line "${output}")")"
  if ! [[ "${version}" =~ ^[0-9]+([.][0-9]+){0,2}$ ]]; then
    fail "${label}: could not parse version" "${remediation}"
    return
  fi
  if version_at_least "${version}" "${minimum}"; then
    pass "${label} ${version}"
  else
    fail "${label} ${version} is below ${minimum}" "${remediation}"
  fi
}

check_command() {
  local label="$1"
  local command_name="$2"
  local remediation="$3"
  local output

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    fail "${label}: not found" "${remediation}"
    return
  fi
  if output="$("${command_name}" --version 2>/dev/null)"; then
    pass "${label} $(first_line "${output}")"
  else
    fail "${label}: version check failed" "${remediation}"
  fi
}

check_build_artifact() {
  local label="$1"
  local file_path="$2"
  local remediation="$3"
  local source_path newer_source
  shift 3

  if [ ! -f "${file_path}" ]; then
    fail "${label}: missing" "${remediation}"
    return
  fi
  for source_path in "$@"; do
    newer_source=""
    if [ -d "${source_path}" ]; then
      newer_source="$(find "${source_path}" -type f -newer "${file_path}" -print -quit 2>/dev/null || true)"
    elif [ -f "${source_path}" ] && [ "${source_path}" -nt "${file_path}" ]; then
      newer_source="${source_path}"
    fi
    if [ -n "${newer_source}" ]; then
      fail "${label}: stale" "${remediation}"
      return
    fi
  done
  pass "${label}"
}

check_executable() {
  local label="$1"
  local file_path="$2"
  local remediation="$3"

  if [ -x "${file_path}" ]; then
    pass "${label}"
  else
    fail "${label}: missing or not executable" "${remediation}"
  fi
}

git_config() {
  git -C "${REPO_ROOT}" config --get "$1" 2>/dev/null || true
}

check_git_configuration() {
  local name email sign_enabled sign_format signing_key hooks_dir hook hooks_path

  name="$(git_config user.name)"
  email="$(git_config user.email)"
  if [ -n "${name}" ] && [ -n "${email}" ]; then
    pass "Git contributor identity configured"
  else
    fail "Git contributor identity is incomplete" \
      "Set repository-local user.name and user.email before committing."
  fi

  sign_enabled="$(git_config commit.gpgsign)"
  if ! sign_format="$(git -C "${REPO_ROOT}" config --get gpg.format 2>/dev/null)"; then
    sign_format="openpgp"
  fi
  signing_key="$(git_config user.signingkey)"
  case "${sign_format}" in
    openpgp | ssh | x509)
      if [ "${sign_enabled}" = "true" ] && [ -n "${signing_key}" ]; then
        pass "Git commit signing configured (${sign_format})"
      else
        fail "Git commit signing is incomplete" \
          "Configure user.signingkey and set commit.gpgsign=true before committing."
      fi
      ;;
    *)
      fail "Git commit signing format is unsupported (${sign_format:-empty})" \
        "Set gpg.format to openpgp, ssh, or x509, or run: git config --unset gpg.format"
      ;;
  esac

  hooks_path="$(git_config core.hooksPath)"
  if [ -n "${hooks_path}" ]; then
    fail "Git core.hooksPath overrides repository hooks" \
      "Run: git config --unset core.hooksPath && npm install"
    return
  fi
  hooks_dir="$(git -C "${REPO_ROOT}" rev-parse --git-path hooks 2>/dev/null || true)"
  if [ -z "${hooks_dir}" ]; then
    fail "Git hook directory could not be resolved" "Run: npm install"
    return
  fi
  for hook in pre-commit commit-msg pre-push; do
    if [ ! -x "${hooks_dir}/${hook}" ]; then
      fail "Git ${hook} hook is missing" "Run: npm install"
      return
    fi
  done
  pass "Git hooks installed (pre-commit, commit-msg, pre-push)"
}

check_github_authentication() {
  if gh auth status >/dev/null 2>&1; then
    pass "GitHub authentication"
  else
    fail "GitHub authentication failed" "Run: gh auth login -h github.com"
  fi
}

check_docker() {
  local output server_version cpus memory_bytes storage_driver memory_gib

  if ! command -v docker >/dev/null 2>&1; then
    fail "Docker CLI: not found" "Install and start Docker Desktop, Colima, or Docker Engine."
    return
  fi
  if ! output="$(docker info --format '{{.ServerVersion}}|{{.NCPU}}|{{.MemTotal}}|{{.Driver}}' 2>/dev/null)"; then
    fail "Docker daemon is not reachable" "Start the configured container runtime, then run this doctor again."
    return
  fi
  IFS='|' read -r server_version cpus memory_bytes storage_driver <<<"${output}"
  if ! [[ "${cpus}" =~ ^[0-9]+$ && "${memory_bytes}" =~ ^[0-9]+$ ]]; then
    fail "Docker resource information is unavailable" "Run: docker info"
    return
  fi
  memory_gib="$(awk -v bytes="${memory_bytes}" 'BEGIN { printf "%.1f", bytes / 1073741824 }')"
  pass "Docker ${server_version}: ${cpus} vCPU, ${memory_gib} GiB, ${storage_driver} storage"
  if ((cpus < 4)) || ((memory_bytes < 8589934592)); then
    fail "Docker resources are below the minimum 4 vCPU and 8 GiB" \
      "Increase container-runtime resources before sandbox builds."
  elif ((memory_bytes < 17179869184)); then
    warn "Docker memory is below the recommended 16 GiB" \
      "Increase container-runtime memory for more reliable sandbox builds."
  fi
}

check_local_cli() {
  local cli_path global_root global_link global_target

  cli_path="$(command -v nemoclaw 2>/dev/null || true)"
  if [ -z "${cli_path}" ]; then
    fail "Local NemoClaw CLI is not on PATH" "Run: npm install"
    return
  fi
  if [ "${cli_path}" = "${REPO_ROOT}/bin/nemoclaw.js" ] || grep -Fq "${REPO_ROOT}/bin/nemoclaw.js" "${cli_path}" 2>/dev/null; then
    pass "Local NemoClaw CLI resolves to this checkout"
    return
  fi
  global_root="$(npm root -g 2>/dev/null || true)"
  global_link="${global_root:+${global_root}/nemoclaw}"
  if [ -n "${global_link}" ] && [ -d "${global_link}" ]; then
    global_target="$(cd -- "${global_link}" 2>/dev/null && pwd -P || true)"
    if [ "${global_target}" = "${REPO_ROOT}" ]; then
      pass "Local NemoClaw CLI resolves to this checkout"
      return
    fi
  fi
  fail "NemoClaw CLI resolves to a different installation" "Run npm install from ${REPO_ROOT}."
}

if [ "$#" -ne 1 ] || [ "$1" != "--doctor" ]; then
  usage
  exit 2
fi

printf '\nNemoClaw contributor environment\n\n'
printf '  Host: %s %s\n' "$(uname -s 2>/dev/null || printf unknown)" "$(uname -m 2>/dev/null || printf unknown)"
printf '  Repo: %s\n\n' "${REPO_ROOT}"

if [ -f "${REPO_ROOT}/package.json" ] && [ -f "${REPO_ROOT}/AGENTS.md" ]; then
  pass "NemoClaw source checkout"
else
  fail "NemoClaw source checkout not found" "Run this command from a NemoClaw repository checkout."
fi

check_minimum_version "Node.js" node "22.16.0" "Install Node.js 22.16 or newer."
check_minimum_version "npm" npm "10.0.0" "Install npm 10 or newer."
check_command "uv" uv "Install uv from https://docs.astral.sh/uv/."
if [ -x "${REPO_ROOT}/.venv/bin/python" ]; then
  check_minimum_version "Python repository environment" "${REPO_ROOT}/.venv/bin/python" "3.11.0" \
    "Run: uv sync --python 3.11"
else
  fail "Python repository environment: missing" "Run: uv sync --python 3.11"
fi
check_command "Git" git "Install Git."
check_command "GitHub CLI" gh "Install GitHub CLI."
check_command "hadolint" hadolint "Install hadolint (macOS: brew install hadolint)."

check_executable "Root TypeScript dependencies" "${REPO_ROOT}/node_modules/.bin/tsc" "Run: npm install"
check_executable "Prek dependency" "${REPO_ROOT}/node_modules/.bin/prek" "Run: npm install"
check_executable "Plugin TypeScript dependencies" "${REPO_ROOT}/nemoclaw/node_modules/.bin/tsc" \
  "Run: cd nemoclaw && npm install"
check_build_artifact "CLI build artifacts" "${CLI_BUILD_ARTIFACT}" "Run: npm run build:cli" \
  "${REPO_ROOT}/src" "${REPO_ROOT}/bin" "${REPO_ROOT}/nemoclaw-blueprint/scripts" \
  "${REPO_ROOT}/tsconfig.src.json"
check_build_artifact "Plugin build artifacts" "${PLUGIN_BUILD_ARTIFACT}" \
  "Run: cd nemoclaw && npm run build" "${REPO_ROOT}/nemoclaw/src" \
  "${REPO_ROOT}/nemoclaw/tsconfig.json" "${REPO_ROOT}/nemoclaw/package.json"

check_git_configuration
check_github_authentication
check_docker
check_local_cli

printf '\n  Summary: %d passed, %d warning(s), %d failed\n\n' "${PASS_COUNT}" "${WARN_COUNT}" "${FAIL_COUNT}"

if ((FAIL_COUNT > 0)); then
  printf 'Contributor environment is not ready. Complete the actions above and run the doctor again.\n'
  exit 1
fi

printf 'Ready to create a feature branch.\n'
printf 'Runtime sandbox: not required for contributor readiness.\n'
