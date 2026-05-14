#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Gateway helpers.

_E2E_GW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_GW_LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_GW_LIB_DIR}/context.sh"

# e2e_gateway_assert_healthy [url]
# Defaults to E2E_GATEWAY_URL from context; returns non-zero with a clear
# error if the gateway is unreachable / unhealthy.
e2e_gateway_assert_healthy() {
  local url="${1:-}"
  if [[ -z "${url}" ]]; then
    url="$(e2e_context_get E2E_GATEWAY_URL)"
  fi
  if [[ -z "${url}" ]]; then
    echo "e2e_gateway_assert_healthy: no URL provided and E2E_GATEWAY_URL is unset" >&2
    return 2
  fi
  e2e_env_trace "gateway:check" "${url}"
  if e2e_env_is_dry_run; then
    echo "[dry-run] gateway check ${url} (skipped)"
    return 0
  fi
  # Prefer /health if available, otherwise just hit the base URL.
  local http_code
  http_code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "${url%/}/health" 2>/dev/null || echo 000)"
  if [[ "${http_code}" == "200" ]]; then
    return 0
  fi
  http_code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "${url}" 2>/dev/null || echo 000)"
  if [[ "${http_code}" == "200" || "${http_code}" == "204" ]]; then
    return 0
  fi
  echo "e2e_gateway_assert_healthy: gateway at ${url} is unreachable or unhealthy (last http_code=${http_code})" >&2
  return 1
}
