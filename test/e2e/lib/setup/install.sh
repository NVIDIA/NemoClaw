#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install helper: exposes a single `e2e_install` entrypoint that dispatches
# by install method and honours E2E_DRY_RUN.

_E2E_INSTALL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=env.sh
. "${_E2E_INSTALL_LIB_DIR}/env.sh"
# Reuse the existing PATH-refresh helper to avoid duplicating its logic.
# shellcheck source=install-path-refresh.sh
. "${_E2E_INSTALL_LIB_DIR}/install-path-refresh.sh"

e2e_install() {
  local method="${1:-}"
  if [[ -z "${method}" ]]; then
    echo "e2e_install: missing install method" >&2
    return 2
  fi
  e2e_env_trace "install:${method}"
  if e2e_env_is_dry_run; then
    # dry-run: announce and skip real side effects
    echo "[dry-run] install method=${method} (skipped)"
    return 0
  fi
  case "${method}" in
    repo-checkout | repo-current)
      e2e_install_from_repo_checkout
      ;;
    curl-install-script | public-installer)
      e2e_install_from_public_curl
      ;;
    *)
      echo "e2e_install: unsupported install method: ${method}" >&2
      return 2
      ;;
  esac
  nemoclaw_refresh_install_env
}

e2e_install_from_repo_checkout() {
  local repo_root
  repo_root="$(cd "${_E2E_INSTALL_LIB_DIR}/../../.." && pwd)"
  (
    cd "${repo_root}" || exit
    npm install
    npm link
  )
}

e2e_install_from_public_curl() {
  # Pin the installer source so CI runs do not implicitly follow main's
  # head (CodeRabbit review item #6). Callers override E2E_INSTALLER_URL
  # or E2E_INSTALLER_SHA256 to pin to a specific revision / digest.
  local url="${E2E_INSTALLER_URL:-https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/install.sh}"
  local sha256="${E2E_INSTALLER_SHA256:-}"
  local tmp
  tmp="$(mktemp -t nemoclaw-installer.XXXXXX.sh)"
  trap 'rm -f "${tmp}"' RETURN
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "${tmp}" "${url}"; then
    echo "e2e_install_from_public_curl: failed to download ${url}" >&2
    return 1
  fi
  if [[ -n "${sha256}" ]]; then
    local got
    got="$(shasum -a 256 "${tmp}" 2>/dev/null | awk '{print $1}')"
    if [[ "${got}" != "${sha256}" ]]; then
      echo "e2e_install_from_public_curl: sha256 mismatch (expected ${sha256}, got ${got})" >&2
      return 1
    fi
  fi
  bash "${tmp}"
}
