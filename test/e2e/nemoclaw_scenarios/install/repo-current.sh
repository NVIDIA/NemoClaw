#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install from a checked-out repo (repo-current / repo-checkout profile).
#
# Split from the install dispatcher to keep scenario setup logic flat and to
# make the per-profile code discoverable by grep. Honors E2E_DRY_RUN.

_E2E_INST_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_INST_REPO_RUNTIME_LIB="$(cd "${_E2E_INST_REPO_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_INST_REPO_RUNTIME_LIB}/env.sh"
# shellcheck source=helpers/install-path-refresh.sh
. "${_E2E_INST_REPO_DIR}/helpers/install-path-refresh.sh"

e2e_install_repo() {
  e2e_env_trace "install-repo"
  if e2e_env_is_dry_run; then
    echo "[dry-run] install-repo (skipped)"
    return 0
  fi
  local repo_root
  repo_root="$(cd "${_E2E_INST_REPO_DIR}/../../../.." && pwd)"
  (
    cd "${repo_root}" || exit
    npm install
    npm link
  )
  nemoclaw_refresh_install_env
}
