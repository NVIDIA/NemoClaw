#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install from the public curl|bash installer (public-installer profile).
#
# Pins the installer source via E2E_INSTALLER_URL; can verify the download
# against E2E_INSTALLER_SHA256 when provided.

_E2E_INST_CURL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_INST_CURL_RUNTIME_LIB="$(cd "${_E2E_INST_CURL_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_INST_CURL_RUNTIME_LIB}/env.sh"
# shellcheck source=helpers/install-path-refresh.sh
. "${_E2E_INST_CURL_DIR}/helpers/install-path-refresh.sh"

e2e_install_curl() {
  e2e_env_trace "install-curl"
  if e2e_env_is_dry_run; then
    echo "[dry-run] install-curl (skipped)"
    return 0
  fi
  local url="${E2E_INSTALLER_URL:-https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/install.sh}"
  local sha256="${E2E_INSTALLER_SHA256:-}"
  local tmp
  tmp="$(mktemp -t nemoclaw-installer.XXXXXX.sh)"
  # shellcheck disable=SC2064
  trap "rm -f '${tmp}'" RETURN
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "${tmp}" "${url}"; then
    echo "e2e_install_curl: failed to download ${url}" >&2
    return 1
  fi
  if [[ -n "${sha256}" ]]; then
    local got
    got="$(shasum -a 256 "${tmp}" 2>/dev/null | awk '{print $1}')"
    if [[ "${got}" != "${sha256}" ]]; then
      echo "e2e_install_curl: sha256 mismatch (expected ${sha256}, got ${got})" >&2
      return 1
    fi
  fi
  bash "${tmp}"
  nemoclaw_refresh_install_env
}
