#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install dispatcher. Routes by install-method / profile id to one of four
# split helpers (repo-current.sh, public-curl.sh, ollama.sh,
# launchable.sh). Honors E2E_DRY_RUN.
#
# Accepts both legacy install-method names (repo-checkout,
# curl-install-script) and the new profile-centric names used by
# scenarios.yaml (repo-current, public-installer, ollama, launchable).

_E2E_INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_INSTALL_RUNTIME_LIB="$(cd "${_E2E_INSTALL_DIR}/../../runtime/lib" && pwd)"

# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_INSTALL_RUNTIME_LIB}/env.sh"
# shellcheck source=repo-current.sh
. "${_E2E_INSTALL_DIR}/repo-current.sh"
# shellcheck source=public-curl.sh
. "${_E2E_INSTALL_DIR}/public-curl.sh"
# shellcheck source=ollama.sh
. "${_E2E_INSTALL_DIR}/ollama.sh"
# shellcheck source=launchable.sh
. "${_E2E_INSTALL_DIR}/launchable.sh"

e2e_install() {
  local method="${1:-}"
  if [[ -z "${method}" ]]; then
    echo "e2e_install: missing install method" >&2
    return 2
  fi
  e2e_env_trace "install:${method}"
  case "${method}" in
    repo-checkout | repo-current)
      e2e_install_repo
      ;;
    curl-install-script | public-installer)
      e2e_install_curl
      ;;
    ollama)
      e2e_install_ollama
      ;;
    launchable)
      e2e_install_launchable
      ;;
    *)
      echo "e2e_install: unsupported install method: ${method}" >&2
      return 2
      ;;
  esac
}

# Legacy entrypoints kept for compatibility with callers that pre-dated
# the four-way split. They forward to the new helpers.
e2e_install_from_repo_checkout() { e2e_install_repo "$@"; }
e2e_install_from_public_curl() { e2e_install_curl "$@"; }
