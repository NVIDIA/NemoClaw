#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if (($# != 0)); then
  echo "::error::Docker auth setup does not accept arguments." >&2
  exit 1
fi

docker_config="$(mktemp -d "${RUNNER_TEMP}/docker-config-${GITHUB_JOB}-XXXXXX")"
chmod 700 "${docker_config}"
export DOCKER_CONFIG="${docker_config}"
printf 'DOCKER_CONFIG=%s\n' "${DOCKER_CONFIG}" >>"${GITHUB_ENV}"

if [[ "${DOCKERHUB_AUTH_REQUIRED}" != "1" ]]; then
  echo "::notice::Docker Hub credentials are withheld for this ref; continuing with anonymous pulls."
  exit 0
fi
if [[ -z "${DOCKERHUB_USERNAME}" || -z "${DOCKERHUB_TOKEN}" ]]; then
  echo "::error::Docker Hub credentials are required for trusted E2E runs."
  exit 1
fi

auth_marker="${DOCKER_CONFIG}/.nemoclaw-docker-login-attempted"
: >"${auth_marker}"
chmod 600 "${auth_marker}"
login_attempts=5
retry_seconds=5
login_succeeded=0
for ((attempt = 1; attempt <= login_attempts; attempt += 1)); do
  if printf '%s' "${DOCKERHUB_TOKEN}" | timeout 30s docker login docker.io --username "${DOCKERHUB_USERNAME}" --password-stdin; then
    login_succeeded=1
    break
  fi
  if ((attempt < login_attempts)); then
    echo "::warning::Docker Hub login attempt ${attempt}/${login_attempts} failed; retrying in ${retry_seconds}s."
    sleep "${retry_seconds}"
  fi
done
if [[ "${login_succeeded}" -ne 1 ]]; then
  echo "::error::Docker Hub login failed after ${login_attempts} attempts."
  exit 1
fi
