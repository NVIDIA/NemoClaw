#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install helper: exposes a single `e2e_install` entrypoint that dispatches
# by install method and honours E2E_DRY_RUN.

_E2E_INSTALL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
  curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/scripts/install.sh | bash
}
