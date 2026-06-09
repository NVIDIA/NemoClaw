#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Onboard worker: cloud-openclaw-no-docker profile.
#
# Drives the negative `ubuntu-no-docker-preflight-negative` scenario by:
#
#   1. Installing a `docker` shim earlier on PATH that exits non-zero
#      with a "Cannot connect to the Docker daemon" message. This makes
#      `commandExists("docker")` succeed (the binary is present) while
#      `docker info` fails — matching the production failure mode users
#      see when Docker is installed but the daemon is not running.
#
#   2. Running `nemoclaw onboard --non-interactive` with stdout+stderr
#      streamed through a redactor into
#      `${E2E_CONTEXT_DIR}/negative-preflight.log`. The
#      `onboarding.preflight.expected-failed` assertion greps that file.
#
#   3. Asserting that nemoclaw exits non-zero (preflight DID fail). If
#      onboard unexpectedly succeeds, the action fails so the operator
#      sees a clear "expected failure did not happen" signal instead of a
#      green light masking a regression.
#
#   4. Returning 0 on the *expected* failure path so the orchestrator
#      reports the action as passed and the assertion phase runs against
#      the captured log. Without this, the action would be marked failed
#      and the dependent assertions would be skipped.
#
# Pattern mirrors test/e2e/e2e-cloud-experimental/test-port8080-conflict.sh,
# which sets up a different failure condition (port 8080 occupied) but
# follows the same capture-output / check-exit / grep-log shape.
#
# Migration note: the typed OnboardingPhaseFixture owns the future no-Docker
# path. This shell worker remains the live dispatcher target until that phase
# is fully wired into scenario execution. Keep its Docker-daemon-missing
# signature and redacted negative-preflight evidence contract aligned with the
# typed fixture, then remove both PATH-shadow shims once the framework can
# inject a Docker client boundary directly.

e2e_no_docker_write_redacted_preflight_log() {
  local redacted_log="$1"
  rm -f "${redacted_log}"

  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import os
import re
import sys

target = sys.argv[1]
secret_env_name = re.compile(r"(api[_-]?key|token|secret|password|credential)", re.I)
secret_pattern = re.compile(
    r"(sk-[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|[A-Za-z0-9._%+-]+:[A-Za-z0-9_/-]{12,}|(api[_-]?key|token|secret|password)[=:][^\s]+)",
    re.I,
)

with open(target, "w", encoding="utf-8") as handle:
    for line in sys.stdin:
        for name, value in os.environ.items():
            if value and secret_env_name.search(name):
                line = line.replace(value, "[REDACTED]")

        line = secret_pattern.sub("[REDACTED]", line)
        handle.write(line)
        handle.flush()
' "${redacted_log}"
    return
  fi

  local redacted text name value lower_name pattern
  redacted="$(mktemp -t e2e-negative-preflight-redacted-XXXXXX)"
  text="$(cat)"
  while IFS='=' read -r name value; do
    lower_name="${name,,}"
    if [[ -n "${value}" && "${lower_name}" =~ (api[_-]?key|token|secret|password|credential) ]]; then
      pattern="${value//\\/\\\\}"
      pattern="${pattern//\*/\\*}"
      pattern="${pattern//\?/\\?}"
      pattern="${pattern//\[/\\[}"
      text="${text//${pattern}/[REDACTED]}"
    fi
  done < <(env)
  printf "%s" "${text}" | sed -E 's/(sk-[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|[A-Za-z0-9._%+-]+:[A-Za-z0-9_\/-]{12,}|(api[_-]?key|token|secret|password)[=:][^[:space:]]+)/[REDACTED]/Ig' >"${redacted}"
  mv "${redacted}" "${redacted_log}"
}

e2e_no_docker_has_missing_signature() {
  local log="$1"
  [[ -f "${log}" ]] || return 1
  grep -Eiq \
    'Cannot connect to the Docker daemon|Is the docker daemon running\??|docker daemon is not running|docker[- ]missing|Docker is required before onboarding|Docker is not reachable|could not talk to the Docker daemon' \
    "${log}"
}

e2e_onboard_cloud_openclaw_no_docker() {
  e2e_env_apply_noninteractive
  # The TS runner already seeded context.env. Resolve the directory and
  # keep existing keys (notably E2E_SANDBOX_NAME) for state-validation.
  e2e_context_path >/dev/null
  mkdir -p "${E2E_CONTEXT_DIR}"

  local log sandbox_name shim_dir rc=0 redactor_rc=0 shim_dir_quoted run_path
  log="${E2E_CONTEXT_DIR}/negative-preflight.log"
  e2e_context_require E2E_SANDBOX_NAME
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  shim_dir="$(mktemp -d -t e2e-no-docker-XXXXXX)"
  printf -v shim_dir_quoted "%q" "${shim_dir}"
  # shellcheck disable=SC2064
  trap "rm -rf -- ${shim_dir_quoted}" RETURN EXIT
  # shellcheck disable=SC2064
  trap "rm -rf -- ${shim_dir_quoted}; exit 130" INT
  # shellcheck disable=SC2064
  trap "rm -rf -- ${shim_dir_quoted}; exit 143" TERM
  rm -f "${log}"

  cat >"${shim_dir}/docker" <<'SHIM'
#!/usr/bin/env bash
# Negative-preflight docker shim — preserves "docker is installed" while
# breaking "docker info" / "docker version" so preflight fails with the
# real "Cannot connect to the Docker daemon" message.
printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' >&2
exit 1
SHIM
  chmod +x "${shim_dir}/docker"

  echo "negative-preflight: shim docker installed at ${shim_dir}/docker"
  echo "negative-preflight: log_file=${log}"
  echo "negative-preflight: invoking nemoclaw onboard --non-interactive (expected to fail at preflight)"

  run_path="${shim_dir}"
  if [[ -n "${PATH:-}" ]]; then
    run_path="${shim_dir}:${PATH}"
  fi

  local errexit_was_set=0
  if [[ $- == *e* ]]; then
    errexit_was_set=1
    set +e
  fi
  NEMOCLAW_SANDBOX_NAME="${sandbox_name}" NEMOCLAW_AGENT=openclaw NEMOCLAW_PROVIDER=cloud PATH="${run_path}" \
    nemoclaw onboard --non-interactive --yes --yes-i-accept-third-party-software \
    2>&1 | e2e_no_docker_write_redacted_preflight_log "${log}"
  local -a pipeline_status=("${PIPESTATUS[@]}")
  if [[ "${errexit_was_set}" -eq 1 ]]; then
    set -e
  fi
  rc="${pipeline_status[0]}"
  redactor_rc="${pipeline_status[1]}"
  rm -rf "${shim_dir}"

  if [[ "${redactor_rc}" -ne 0 ]]; then
    echo "negative-preflight: ERROR: failed to write redacted preflight log (${log})" >&2
    return "${redactor_rc}"
  fi

  echo "negative-preflight: nemoclaw onboard exited ${rc}"
  if [[ -f "${log}" ]]; then
    echo "--- captured log tail (${log}) ---"
    tail -50 "${log}" 2>/dev/null || true
    echo "--- end captured log ---"
  fi

  if [[ "${rc}" -eq 0 ]]; then
    echo "negative-preflight: ERROR: nemoclaw onboard unexpectedly exited 0; preflight should have failed when docker is unreachable" >&2
    return 1
  fi

  if ! e2e_no_docker_has_missing_signature "${log}"; then
    echo "negative-preflight: ERROR: nemoclaw onboard failed without Docker-missing preflight signature" >&2
    return "${rc}"
  fi

  return 0
}
