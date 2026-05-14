#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Onboard dispatcher. Sources env.sh + context.sh + the three per-path
# worker files, defines `e2e_onboard()` which routes by onboarding
# profile id and honors dry-run.

_E2E_ONBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_ONBOARD_RUNTIME_LIB="$(cd "${_E2E_ONBOARD_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_ONBOARD_RUNTIME_LIB}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_ONBOARD_RUNTIME_LIB}/context.sh"
# shellcheck source=cloud-openclaw.sh
. "${_E2E_ONBOARD_DIR}/cloud-openclaw.sh"
# shellcheck source=cloud-hermes.sh
. "${_E2E_ONBOARD_DIR}/cloud-hermes.sh"
# shellcheck source=local-ollama-openclaw.sh
. "${_E2E_ONBOARD_DIR}/local-ollama-openclaw.sh"

e2e_onboard() {
  local profile="${1:-}"
  if [[ -z "${profile}" ]]; then
    echo "e2e_onboard: missing onboarding profile id" >&2
    return 2
  fi
  e2e_env_trace "onboard:${profile}"
  if e2e_env_is_dry_run; then
    echo "[dry-run] onboard profile=${profile} (skipped)"
    return 0
  fi
  case "${profile}" in
    cloud-openclaw)
      e2e_onboard_cloud_openclaw
      ;;
    cloud-hermes)
      e2e_onboard_cloud_hermes
      ;;
    local-ollama-openclaw)
      e2e_onboard_local_ollama_openclaw
      ;;
    *)
      echo "e2e_onboard: unsupported onboarding profile: ${profile}" >&2
      return 2
      ;;
  esac
}
