#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="${SCRIPT_REPO_ROOT}"
HOST_OS="$(uname -s 2>/dev/null || printf unknown)"
HOST_ARCH="$(uname -m 2>/dev/null || printf unknown)"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
OUTPUT_FORMAT="human"
JSON_RESULTS=""

usage() {
  cat <<'EOF'
Usage: ./scripts/dev-setup.sh [--repair | --expose-cli | --with-runtime]
       ./scripts/dev-setup.sh --doctor [--json]

Modes:
  (default)       Install or repair repository-local contributor tooling.
  --repair        Re-run the repository-local setup workflow.
  --expose-cli    Set up the checkout and opt in to a PATH-visible development CLI.
  --with-runtime  Set up, expose the CLI, verify readiness, then run runtime onboarding.
  --doctor        Run read-only contributor-readiness checks.
  --json          Emit the doctor report as JSON. Valid only with --doctor.

Setup never changes host packages, global Git configuration, GitHub state,
signing keys, credentials, licenses, or sandboxes. CLI exposure and runtime
onboarding are explicit opt-ins through --expose-cli and --with-runtime.
EOF
}

json_escape() {
  local input="$1"
  local output=""
  local char code escaped i
  local LC_ALL=C

  for ((i = 0; i < ${#input}; i++)); do
    char="${input:i:1}"
    case "${char}" in
      '"') output+='\"' ;;
      $'\\') output="${output}\\\\" ;;
      $'\b') output+='\b' ;;
      $'\f') output+='\f' ;;
      $'\n') output+='\n' ;;
      $'\r') output+='\r' ;;
      $'\t') output+='\t' ;;
      *)
        printf -v code '%d' "'${char}"
        if ((code < 32)); then
          printf -v escaped '\\u%04x' "${code}"
          output+="${escaped}"
        else
          output+="${char}"
        fi
        ;;
    esac
  done
  printf '%s' "${output}"
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

setup_minimum_version() {
  local label="$1"
  local command_name="$2"
  local minimum="$3"
  local remediation="$4"
  local output version

  if ! output="$("${command_name}" --version 2>/dev/null)"; then
    printf '%s version check failed.\n' "${label}" >&2
    printf 'Next: %s\n' "${remediation}" >&2
    return 1
  fi
  version="$(extract_version "$(first_line "${output}")")"
  if ! [[ "${version}" =~ ^[0-9]+([.][0-9]+){0,2}$ ]] || ! version_at_least "${version}" "${minimum}"; then
    printf '%s %s is below %s.\n' "${label}" "${version:-unknown}" "${minimum}" >&2
    printf 'Next: %s\n' "${remediation}" >&2
    return 1
  fi
}

find_local_python() {
  local candidate path output version

  for candidate in \
    "${REPO_ROOT}/.venv/bin/python" \
    python3 python3.14 python3.13 python3.12 python3.11; do
    if [[ "${candidate}" = */* ]]; then
      path="${candidate}"
      [ -x "${path}" ] || continue
    else
      path="$(command -v "${candidate}" 2>/dev/null || true)"
      if [ -z "${path}" ] || [ ! -x "${path}" ]; then
        continue
      fi
    fi
    output="$("${path}" --version 2>&1 || true)"
    version="$(extract_version "$(first_line "${output}")")"
    if [[ "${version}" =~ ^[0-9]+([.][0-9]+){0,2}$ ]] && version_at_least "${version}" "3.11.0"; then
      printf '%s\n' "${path}"
      return 0
    fi
  done
  return 1
}

is_supported_host() {
  case "${HOST_OS}:${HOST_ARCH}" in
    Darwin:arm64 | Darwin:x86_64 | Linux:aarch64 | Linux:x86_64) return 0 ;;
    *) return 1 ;;
  esac
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
  local setup_failed=0 hooks_path local_python

  printf '\nNemoClaw contributor setup\n\n'
  printf 'Repository: %s\n' "${REPO_ROOT}"
  printf 'This workflow changes repository-local dependencies, builds, and hooks only.\n'

  if ! is_supported_host; then
    printf 'Unsupported host: %s %s\n' "${HOST_OS}" "${HOST_ARCH}" >&2
    printf 'Next: Use a supported macOS or Linux host on arm64/aarch64 or x86_64.\n' >&2
    return 1
  fi

  setup_requirement node "Install Node.js 22.16 or newer, then rerun this command." || setup_failed=1
  setup_requirement npm "Install npm 10 or newer, then rerun this command." || setup_failed=1
  setup_requirement uv "Install uv from https://docs.astral.sh/uv/, then rerun this command." || setup_failed=1
  setup_requirement git "Install Git, then rerun this command." || setup_failed=1
  if ((setup_failed > 0)); then
    return 1
  fi
  setup_minimum_version "Node.js" node "22.16.0" \
    "Install Node.js 22.16 or newer, then rerun this command." || setup_failed=1
  setup_minimum_version "npm" npm "10.0.0" \
    "Install npm 10 or newer, then rerun this command." || setup_failed=1
  if ! local_python="$(find_local_python)"; then
    printf 'Python 3.11 or newer was not found locally.\n' >&2
    printf 'Next: Install Python 3.11 or newer, then rerun this command.\n' >&2
    setup_failed=1
  fi
  if ((setup_failed > 0)); then
    return 1
  fi

  cd -- "${REPO_ROOT}" || return 1

  if git config --local --get core.hooksPath >/dev/null 2>&1; then
    run_setup_step "Remove the obsolete repository-local Git hooks override" \
      git config --local --unset-all core.hooksPath || return 1
  fi
  hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
  if [ -n "${hooks_path}" ]; then
    printf 'A non-local Git core.hooksPath override is active: %s\n' "${hooks_path}" >&2
    printf 'Next: Run git config --show-origin --get core.hooksPath, then remove it in that scope with your approval.\n' >&2
    return 1
  fi
  run_setup_step "Install root dependencies" npm install --include=dev --ignore-scripts || return 1
  run_setup_step "Install plugin dependencies" \
    npm --prefix nemoclaw install --include=dev --ignore-scripts || return 1
  run_setup_step "Synchronize the repository Python environment" \
    uv sync --python "${local_python}" --no-python-downloads || return 1
  run_setup_step "Build the CLI" npm run build:cli || return 1
  run_setup_step "Build and type-check the plugin" npm --prefix nemoclaw run build || return 1
  # Keep the explicit checks aligned with the broader pre-push and CI contracts.
  run_setup_step "Type-check the CLI" npm run typecheck:cli || return 1
  run_setup_step "Type-check the plugin without emitting files" \
    "${REPO_ROOT}/nemoclaw/node_modules/.bin/tsc" --noEmit \
    -p "${REPO_ROOT}/nemoclaw/tsconfig.json" || return 1
  run_setup_step "Install repository Git hooks" "${REPO_ROOT}/node_modules/.bin/prek" install || return 1
  if [ "${EXPOSE_CLI}" = "true" ]; then
    printf '\nCLI exposure was explicitly requested.\n'
    run_setup_step "Expose the development NemoClaw CLI" \
      bash "${REPO_ROOT}/scripts/npm-link-or-shim.sh" || return 1
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
      "Run: git config --show-origin --get core.hooksPath, then unset it in that scope and rerun the doctor."
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

resolve_link_path() {
  local candidate="$1" directory target
  local link_count=0

  while [ -L "${candidate}" ]; do
    link_count=$((link_count + 1))
    if ((link_count > 40)); then
      return 1
    fi
    target="$(readlink "${candidate}" 2>/dev/null || true)"
    [ -n "${target}" ] || return 1
    case "${target}" in
      /*) candidate="${target}" ;;
      *)
        directory="$(cd -- "$(dirname "${candidate}")" 2>/dev/null && pwd -P)" || return 1
        candidate="${directory}/${target}"
        ;;
    esac
  done
  directory="$(cd -- "$(dirname "${candidate}")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "${directory}" "$(basename "${candidate}")"
}

is_checkout_dev_shim() {
  local cli_path="$1" current_node line_count line_one line_two line_three line_four
  local resolved_current_node resolved_shim_node shim_node_dir

  [ -f "${cli_path}" ] || return 1
  line_count="$(awk 'END { print NR }' "${cli_path}" 2>/dev/null || true)"
  line_one="$(sed -n '1p' "${cli_path}" 2>/dev/null || true)"
  line_two="$(sed -n '2p' "${cli_path}" 2>/dev/null || true)"
  line_three="$(sed -n '3p' "${cli_path}" 2>/dev/null || true)"
  line_four="$(sed -n '4p' "${cli_path}" 2>/dev/null || true)"
  [ "${line_count}" = "4" ] || return 1
  [ "${line_one}" = '#!/usr/bin/env bash' ] || return 1
  [ "${line_two}" = '# NemoClaw dev-shim - managed by scripts/npm-link-or-shim.sh' ] || return 1
  case "${line_three}" in
    export\ PATH=\"*:\$PATH\") ;;
    *) return 1 ;;
  esac
  [ "${line_four}" = "exec \"${REPO_ROOT}/bin/nemoclaw.js\" \"\$@\"" ] || return 1
  # shellcheck disable=SC2016 # Match the literal $PATH emitted by the managed shim.
  shim_node_dir="$(printf '%s\n' "${line_three}" | sed -n 's/^export PATH="\(.*\):\$PATH"$/\1/p')"
  current_node="$(command -v node 2>/dev/null || true)"
  [ -n "${shim_node_dir}" ] && [ -n "${current_node}" ] || return 1
  resolved_shim_node="$(resolve_link_path "${shim_node_dir}/node" || true)"
  resolved_current_node="$(resolve_link_path "${current_node}" || true)"
  [ -n "${resolved_current_node}" ] && [ "${resolved_shim_node}" = "${resolved_current_node}" ]
}

check_local_cli() {
  local cli_path expected_launcher resolved_cli

  cli_path="$(command -v nemoclaw 2>/dev/null || true)"
  if [ -z "${cli_path}" ]; then
    warn "Local NemoClaw CLI is not on PATH" \
      "Run ./scripts/dev-setup.sh --expose-cli only if your work needs direct CLI access."
    return
  fi
  expected_launcher="$(resolve_link_path "${REPO_ROOT}/bin/nemoclaw.js" || true)"
  resolved_cli="$(resolve_link_path "${cli_path}" || true)"
  if [ -n "${expected_launcher}" ] && [ "${resolved_cli}" = "${expected_launcher}" ]; then
    pass "Local NemoClaw CLI resolves to this checkout"
    return
  fi
  if is_checkout_dev_shim "${cli_path}"; then
    pass "Local NemoClaw CLI resolves to this checkout"
    return
  fi
  fail "NemoClaw CLI resolves to a different installation" \
    "Run ./scripts/dev-setup.sh --expose-cli from ${REPO_ROOT}, then put its CLI path before other installations."
}

run_doctor() {
  local plugin_tsc ready_json root_tsc

  PASS_COUNT=0
  WARN_COUNT=0
  FAIL_COUNT=0
  JSON_RESULTS=""
  if [ "${OUTPUT_FORMAT}" = "human" ]; then
    printf '\nNemoClaw contributor environment\n\n'
    printf '  Host: %s %s\n' "${HOST_OS}" "${HOST_ARCH}"
    printf '  Repo: %s\n\n' "${REPO_ROOT}"
  fi

  if is_supported_host; then
    pass "Supported host ${HOST_OS} ${HOST_ARCH}"
  else
    fail "Unsupported host ${HOST_OS} ${HOST_ARCH}" \
      "Use a supported macOS or Linux host on arm64/aarch64 or x86_64."
  fi

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
      "Run: uv sync --python /path/to/python3.11-or-newer --no-python-downloads"
  else
    fail "Python repository environment: missing" \
      "Run: uv sync --python /path/to/python3.11-or-newer --no-python-downloads"
  fi
  check_command "Git" git "Install Git."
  check_command "GitHub CLI" gh "Install GitHub CLI."
  check_command "hadolint" hadolint "Install hadolint (macOS: brew install hadolint)."

  root_tsc="${REPO_ROOT}/node_modules/.bin/tsc"
  plugin_tsc="${REPO_ROOT}/nemoclaw/node_modules/.bin/tsc"
  check_executable "Root TypeScript dependencies" "${root_tsc}" \
    "Run: npm install --include=dev --ignore-scripts"
  check_executable "Pinned Pi coding agent" "${REPO_ROOT}/node_modules/.bin/pi" \
    "Run: npm install --include=dev --ignore-scripts"
  check_executable "Prek dependency" "${REPO_ROOT}/node_modules/.bin/prek" \
    "Run: npm install --include=dev --ignore-scripts"
  check_executable "Plugin TypeScript dependencies" "${plugin_tsc}" \
    "Run: npm --prefix nemoclaw install --include=dev --ignore-scripts"
  check_build_artifact "CLI build artifacts" "${CLI_BUILD_ARTIFACT}" "Run: npm run build:cli" \
    "${REPO_ROOT}/src" "${REPO_ROOT}/bin" "${REPO_ROOT}/nemoclaw-blueprint/scripts" \
    "${REPO_ROOT}/tsconfig.src.json"
  check_build_artifact "Plugin build artifacts" "${PLUGIN_BUILD_ARTIFACT}" \
    "Run: cd nemoclaw && npm run build" "${REPO_ROOT}/nemoclaw/src" \
    "${REPO_ROOT}/nemoclaw/tsconfig.json" "${REPO_ROOT}/nemoclaw/package.json"
  if [ -x "${root_tsc}" ]; then
    check_quiet_command "CLI type check" "Run: npm run typecheck:cli" \
      "${root_tsc}" -p "${REPO_ROOT}/tsconfig.cli.json"
  fi
  if [ -x "${plugin_tsc}" ]; then
    check_quiet_command "Plugin type check" "Run: npm --prefix nemoclaw run build" \
      "${plugin_tsc}" --noEmit -p "${REPO_ROOT}/nemoclaw/tsconfig.json"
  fi

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
      "${ready_json}" "$(json_escape "${HOST_OS}")" "$(json_escape "${HOST_ARCH}")" \
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
EXPOSE_CLI="false"
ARG1="${1:-}"
ARG2="${2:-}"
case "$#:${ARG1}:${ARG2}" in
  0::) ;;
  1:--repair:)
    MODE="repair"
    ;;
  1:--expose-cli:)
    MODE="expose"
    EXPOSE_CLI="true"
    ;;
  1:--with-runtime:)
    MODE="runtime"
    EXPOSE_CLI="true"
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
  REPO_ROOT="${NEMOCLAW_DEV_DOCTOR_REPO_ROOT:-${SCRIPT_REPO_ROOT}}"
elif [ -n "${NEMOCLAW_DEV_DOCTOR_REPO_ROOT:-}" ]; then
  printf 'NEMOCLAW_DEV_DOCTOR_REPO_ROOT is supported only with --doctor.\n' >&2
  printf 'Refusing to redirect mutating setup away from: %s\n' "${SCRIPT_REPO_ROOT}" >&2
  exit 2
fi
CLI_BUILD_ARTIFACT="${NEMOCLAW_DEV_DOCTOR_CLI_ARTIFACT:-${REPO_ROOT}/dist/nemoclaw.js}"
PLUGIN_BUILD_ARTIFACT="${NEMOCLAW_DEV_DOCTOR_PLUGIN_ARTIFACT:-${REPO_ROOT}/nemoclaw/dist/index.js}"

if [ "${MODE}" = "doctor" ]; then
  run_doctor
  exit $?
fi

repair_repository || exit 1
run_doctor || exit 1

if [ "${MODE}" = "runtime" ]; then
  printf '\nContributor setup is ready. Starting optional runtime onboarding.\n'
  exec node "${REPO_ROOT}/bin/nemoclaw.js" onboard
fi
