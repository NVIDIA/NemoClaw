#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Onboard helper. Dispatches by onboarding profile id and honors dry-run.

_E2E_ONBOARD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.sh
. "${_E2E_ONBOARD_LIB_DIR}/env.sh"
# shellcheck source=context.sh
. "${_E2E_ONBOARD_LIB_DIR}/context.sh"

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

e2e_onboard_cloud_openclaw() {
  local sandbox_name
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  : "${sandbox_name:=e2e-cloud-openclaw}"
  nemoclaw onboard --agent openclaw --provider nvidia --sandbox "${sandbox_name}" --yes
}

e2e_onboard_cloud_hermes() {
  local sandbox_name
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  : "${sandbox_name:=e2e-cloud-hermes}"
  nemoclaw onboard --agent hermes --provider nvidia --sandbox "${sandbox_name}" --yes
}

e2e_onboard_local_ollama_openclaw() {
  local sandbox_name
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  : "${sandbox_name:=e2e-local-ollama-openclaw}"
  nemoclaw onboard --agent openclaw --provider ollama --sandbox "${sandbox_name}" --yes
}
