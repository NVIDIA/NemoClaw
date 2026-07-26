#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

fail_unsafe_path() {
  echo "::error::Docker auth cleanup refused an unsafe path or file type." >&2
  exit 1
}

if (($# != 0)); then
  fail_unsafe_path
fi

docker_config="${DOCKER_CONFIG:-}"
if [[ -z "${docker_config}" ]]; then
  exit 0
fi

runner_temp="${RUNNER_TEMP:-}"
github_job="${GITHUB_JOB:-}"
while [[ "${runner_temp}" != "/" && "${runner_temp}" == */ ]]; do
  runner_temp="${runner_temp%/}"
done
if [[ -z "${runner_temp}" || "${runner_temp}" != /* || "${runner_temp}" == "/" ]]; then
  fail_unsafe_path
fi
if [[ ! "${github_job}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  fail_unsafe_path
fi

config_parent="${docker_config%/*}"
while [[ "${config_parent}" != "/" && "${config_parent}" == */ ]]; do
  config_parent="${config_parent%/}"
done
config_name="${docker_config##*/}"
config_prefix="docker-config-${github_job}-"
if [[ "${config_parent}" != "${runner_temp}" || "${config_name}" != "${config_prefix}"* ]]; then
  fail_unsafe_path
fi
config_suffix="${config_name#"${config_prefix}"}"
if [[ ! "${config_suffix}" =~ ^[[:alnum:]]{6}$ ]]; then
  fail_unsafe_path
fi

if [[ ! -e "${docker_config}" && ! -L "${docker_config}" ]]; then
  exit 0
fi
if [[ -L "${docker_config}" || ! -d "${docker_config}" || ! -O "${docker_config}" ]]; then
  fail_unsafe_path
fi

logout_status=0
auth_marker="${docker_config}/.nemoclaw-docker-login-attempted"
config_file="${docker_config}/config.json"
if [[ -L "${auth_marker}" || (-e "${auth_marker}" && (! -f "${auth_marker}" || ! -O "${auth_marker}")) ]]; then
  logout_status=1
elif [[ -f "${auth_marker}" ]]; then
  if [[ -L "${config_file}" || (-e "${config_file}" && (! -f "${config_file}" || ! -O "${config_file}")) ]]; then
    logout_status=1
  else
    set +e
    timeout 30s docker --config "${docker_config}" logout docker.io >/dev/null 2>&1
    logout_status=$?
    set -e
  fi
fi

if ! rm -rf -- "${docker_config}"; then
  echo "::error::Failed to remove isolated Docker credentials." >&2
  exit 1
fi
if ((logout_status != 0)); then
  echo "::error::Docker logout failed; isolated credentials were removed." >&2
  exit 1
fi
