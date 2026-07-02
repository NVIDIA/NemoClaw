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
OUTPUT_FORMAT="human"
JSON_RESULTS=""

usage() {
  cat <<'EOF'
Usage: ./scripts/dev-setup.sh [--repair | --with-runtime]
       ./scripts/dev-setup.sh --doctor [--json]

Modes:
  (default)       Install or repair repository-local contributor tooling.
  --repair        Re-run the repository-local setup workflow.
  --with-runtime  Set up the checkout, verify readiness, then run `nemoclaw onboard`.
  --doctor        Run read-only contributor-readiness checks.
  --json          Emit the doctor report as JSON. Valid only with --doctor.

Setup never changes host packages, global Git configuration, GitHub state,
signing keys, credentials, licenses, or sandboxes. Runtime onboarding is
interactive and opt-in through --with-runtime.
EOF
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

record_json_result() {
  local status="$1"
  local label="$2"
  local remediation="${3:-}"
  local separator=""

  if [ -n "${JSON_RESULTS}" ]; then
    separator=","
  fi
  JSON_RESULTS="${JSON_RESULTS}${separator}{\"status\":\"$(json_escape "${status}")\",\"label\":\"$(json_escape "${label}")\""
  if [ -n "${remediation}" ]; then
    JSON_RESULTS="${JSON_RESULTS},\"remediation\":\"$(json_escape "${remediation}")\""
  fi
  JSON_RESULTS="${JSON_RESULTS}}"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  if [ "${OUTPUT_FORMAT}" = "json" ]; then
    record_json_result "pass" "$1"
  else
    printf '  ✓ %s\n' "$1"
  fi
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  if [ "${OUTPUT_FORMAT}" = "json" ]; then
    record_json_result "warning" "$1" "${2:-}"
    return
  fi
  printf '  ! %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '    Next: %s\n' "$2"
  fi
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  if [ "${OUTPUT_FORMAT}" = "json" ]; then
    record_json_result "fail" "$1" "${2:-}"
    return
  fi
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

check_quiet_command() {
  local label="$1"
  local remediation="$2"
  shift 2

  if "$@" >/dev/null 2>&1; then
    pass "${label}"
  else
    fail "${label}: failed" "${remediation}"
  fi
}

setup_requirement() {
  local command_name="$1"
  local remediation="$2"

  if command -v "${command_name}" >/dev/null 2>&1; then
    return 0
  fi
  printf 'Missing required host command: %s\n' "${command_name}" >&2
  printf 'Next: %s\n' "${remediation}" >&2
  return 1
}

run_setup_step() {
  local label="$1"
  shift

  printf '\n==> %s\n' "${label}"
  if "$@"; then
    return 0
  fi
  printf 'Setup stopped while attempting: %s\n' "${label}" >&2
  return 1
}

repair_repository() {
  local setup_failed=0

  printf '\nNemoClaw contributor setup\n\n'
  printf 'Repository: %s\n' "${REPO_ROOT}"
  printf 'This workflow changes repository-local dependencies, builds, hooks, and CLI exposure only.\n'

  setup_requirement node "Install Node.js 22.16 or newer, then rerun this command." || setup_failed=1
  setup_requirement npm "Install npm 10 or newer, then rerun this command." || setup_failed=1
  setup_requirement uv "Install uv from https://docs.astral.sh/uv/, then rerun this command." || setup_failed=1
  setup_requirement git "Install Git, then rerun this command." || setup_failed=1
  if ((setup_failed > 0)); then
    return 1
  fi

  cd -- "${REPO_ROOT}" || return 1

  if git config --local --get core.hooksPath >/dev/null 2>&1; then
    run_setup_step "Remove the obsolete repository-local Git hooks override" \
      git config --local --unset-all core.hooksPath || return 1
  fi
  run_setup_step "Install root dependencies" npm install || return 1
  run_setup_step "Install plugin dependencies" npm --prefix nemoclaw install || return 1
  run_setup_step "Synchronize the repository Python environment" uv sync --python 3.11 || return 1
  run_setup_step "Build the CLI" npm run build:cli || return 1
  run_setup_step "Build and type-check the plugin" npm --prefix nemoclaw run build || return 1
  run_setup_step "Type-check the CLI" npm run typecheck:cli || return 1
  run_setup_step "Type-check the plugin without emitting files" \
    npm --prefix nemoclaw exec -- tsc --noEmit || return 1
  run_setup_step "Install repository Git hooks" "${REPO_ROOT}/node_modules/.bin/prek" install || return 1
  run_setup_step "Expose the development NemoClaw CLI" \
    bash "${REPO_ROOT}/scripts/npm-link-or-shim.sh" || return 1
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
  sign_format="$(git_config gpg.format)"
  signing_key="$(git_config user.signingkey)"
  if [ "${sign_enabled}" = "true" ] && [ -n "${signing_key}" ]; then
    pass "Git commit signing configured (${sign_format:-openpgp})"
  else
    fail "Git commit signing is incomplete" \
      "Configure user.signingkey and set commit.gpgsign=true before committing."
  fi

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

run_doctor() {
  local host_os host_arch ready_json

  PASS_COUNT=0
  WARN_COUNT=0
  FAIL_COUNT=0
  JSON_RESULTS=""
  host_os="$(uname -s 2>/dev/null || printf unknown)"
  host_arch="$(uname -m 2>/dev/null || printf unknown)"

  if [ "${OUTPUT_FORMAT}" = "human" ]; then
    printf '\nNemoClaw contributor environment\n\n'
    printf '  Host: %s %s\n' "${host_os}" "${host_arch}"
    printf '  Repo: %s\n\n' "${REPO_ROOT}"
  fi

  case "${host_os}:${host_arch}" in
    Darwin:arm64 | Darwin:x86_64 | Linux:aarch64 | Linux:x86_64)
      pass "Supported host ${host_os} ${host_arch}"
      ;;
    *)
      fail "Unsupported host ${host_os} ${host_arch}" \
        "Use a supported macOS or Linux host on arm64/aarch64 or x86_64."
      ;;
  esac

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
  check_executable "Pinned Pi coding agent" "${REPO_ROOT}/node_modules/.bin/pi" "Run: npm install"
  check_executable "Prek dependency" "${REPO_ROOT}/node_modules/.bin/prek" "Run: npm install"
  check_executable "Plugin TypeScript dependencies" "${REPO_ROOT}/nemoclaw/node_modules/.bin/tsc" \
    "Run: cd nemoclaw && npm install"
  check_build_artifact "CLI build artifacts" "${CLI_BUILD_ARTIFACT}" "Run: npm run build:cli" \
    "${REPO_ROOT}/src" "${REPO_ROOT}/bin" "${REPO_ROOT}/nemoclaw-blueprint/scripts" \
    "${REPO_ROOT}/tsconfig.src.json"
  check_build_artifact "Plugin build artifacts" "${PLUGIN_BUILD_ARTIFACT}" \
    "Run: cd nemoclaw && npm run build" "${REPO_ROOT}/nemoclaw/src" \
    "${REPO_ROOT}/nemoclaw/tsconfig.json" "${REPO_ROOT}/nemoclaw/package.json"
  check_quiet_command "CLI type check" "Run: npm run typecheck:cli" \
    npm --prefix "${REPO_ROOT}" run typecheck:cli
  check_quiet_command "Plugin type check" "Run: npm --prefix nemoclaw exec -- tsc --noEmit" \
    npm --prefix "${REPO_ROOT}/nemoclaw" exec -- tsc --noEmit

  check_git_configuration
  check_github_authentication
  check_docker
  check_local_cli

  if ((FAIL_COUNT > 0)); then
    ready_json=false
  else
    ready_json=true
  fi

  if [ "${OUTPUT_FORMAT}" = "json" ]; then
    printf '{"schemaVersion":1,"ready":%s,"host":{"os":"%s","arch":"%s"},"repo":"%s","summary":{"passed":%d,"warnings":%d,"failed":%d},"checks":[%s]}\n' \
      "${ready_json}" "$(json_escape "${host_os}")" "$(json_escape "${host_arch}")" \
      "$(json_escape "${REPO_ROOT}")" "${PASS_COUNT}" "${WARN_COUNT}" "${FAIL_COUNT}" "${JSON_RESULTS}"
  else
    printf '\n  Summary: %d passed, %d warning(s), %d failed\n\n' "${PASS_COUNT}" "${WARN_COUNT}" "${FAIL_COUNT}"
    if ((FAIL_COUNT > 0)); then
      printf 'Contributor environment is not ready. Complete the actions above and run the doctor again.\n'
    else
      printf 'Ready to create a feature branch.\n'
      printf 'Runtime sandbox: not required for contributor readiness.\n'
    fi
  fi

  ((FAIL_COUNT == 0))
}

MODE="setup"
ARG1="${1:-}"
ARG2="${2:-}"
case "$#:${ARG1}:${ARG2}" in
  0::) ;;
  1:--repair:)
    MODE="repair"
    ;;
  1:--with-runtime:)
    MODE="runtime"
    ;;
  1:--doctor:)
    MODE="doctor"
    ;;
  2:--doctor:--json)
    MODE="doctor"
    OUTPUT_FORMAT="json"
    ;;
  *)
    usage
    exit 2
    ;;
esac

if [ "${MODE}" = "doctor" ]; then
  run_doctor
  exit $?
fi

repair_repository || exit 1
run_doctor || exit 1

if [ "${MODE}" = "runtime" ]; then
  printf '\nContributor setup is ready. Starting optional runtime onboarding.\n'
  exec nemoclaw onboard
fi
