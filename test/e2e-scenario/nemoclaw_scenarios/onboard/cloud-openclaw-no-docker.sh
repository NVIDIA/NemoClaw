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
#      captured to `${E2E_CONTEXT_DIR}/negative-preflight.log`. The
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

e2e_onboard_cloud_openclaw_no_docker() {
  e2e_env_apply_noninteractive
  e2e_context_init

  local log shim_dir rc=0
  log="${E2E_CONTEXT_DIR}/negative-preflight.log"
  shim_dir="$(mktemp -d -t e2e-no-docker-XXXXXX)"

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

  PATH="${shim_dir}:${PATH}" \
    nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    >"${log}" 2>&1 || rc=$?

  rm -rf "${shim_dir}"

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

  return 0
}
