#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Messaging-bridge reachability assertion.
#
# For a given provider (telegram | discord | slack), verify that the L7
# proxy + bridge is reachable from outside the sandbox. Compatible with
# both the real provider URLs and the local `fake-{provider}.sh` fixture
# (which exports `MESSAGING_BRIDGE_URL` or the provider-specific
# `FAKE_<PROVIDER>_URL`).
#
# Usage:
#   e2e_assert_messaging_bridge_reachable <provider>

_E2E_MB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_MB_LIB_DIR}/env.sh"

e2e_assert_messaging_bridge_reachable() {
  local provider="${1:-}"
  if [[ -z "${provider}" ]]; then
    echo "FAIL: e2e_assert_messaging_bridge_reachable: missing provider" >&2
    return 2
  fi

  case "${provider}" in
    telegram | discord | slack) ;;
    *)
      echo "FAIL: unknown messaging provider: ${provider}" >&2
      return 2
      ;;
  esac

  local upper
  upper="$(printf '%s' "${provider}" | tr '[:lower:]' '[:upper:]')"
  # Resolve URL: explicit override > provider-specific fake URL.
  local url="${MESSAGING_BRIDGE_URL:-}"
  if [[ -z "${url}" ]]; then
    local var="FAKE_${upper}_URL"
    url="${!var:-}"
  fi
  if [[ -z "${url}" ]]; then
    echo "FAIL: no bridge URL (set MESSAGING_BRIDGE_URL or start fake-${provider} fixture)" >&2
    return 1
  fi

  e2e_env_trace "assert:messaging-bridge-reachable" "${provider}" "${url}"

  local code
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "${url}/ping" 2>/dev/null || echo 000)"
  if [[ "${code}" != "200" ]]; then
    code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "${url}" 2>/dev/null || echo 000)"
  fi
  if [[ "${code}" != "200" && "${code}" != "204" ]]; then
    echo "FAIL: messaging bridge for ${provider} unreachable at ${url} (http=${code})" >&2
    return 1
  fi
  return 0
}
