#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install with the Ollama runtime pre-staged (ollama profile).
#
# Installs Ollama then delegates to the curl installer for NemoClaw
# itself. E2E_OLLAMA_INSTALL_URL overrides the Ollama installer source
# (useful for offline / mirror runners).

_E2E_INST_OL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_INST_OL_RUNTIME_LIB="$(cd "${_E2E_INST_OL_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_INST_OL_RUNTIME_LIB}/env.sh"
# shellcheck source=public-curl.sh
. "${_E2E_INST_OL_DIR}/public-curl.sh"

e2e_install_ollama() {
  e2e_env_trace "install-ollama"
  if e2e_env_is_dry_run; then
    echo "[dry-run] install-ollama (skipped)"
    return 0
  fi
  local ollama_url="${E2E_OLLAMA_INSTALL_URL:-https://ollama.ai/install.sh}"
  if ! command -v ollama >/dev/null 2>&1; then
    if ! curl -fsSL --retry 3 --retry-delay 2 "${ollama_url}" | bash; then
      echo "e2e_install_ollama: ollama install failed" >&2
      return 1
    fi
  fi
  # Then fall through to the standard curl installer for NemoClaw.
  e2e_install_curl
}
