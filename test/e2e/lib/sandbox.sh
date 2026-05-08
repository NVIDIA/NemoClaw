#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Sandbox helpers.

_E2E_SB_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
. "${_E2E_SB_LIB_DIR}/env.sh"
# shellcheck source=context.sh
. "${_E2E_SB_LIB_DIR}/context.sh"

# e2e_sandbox_assert_running
# Requires E2E_SANDBOX_NAME in context. Real implementation queries
# `nemoclaw list`; honors E2E_DRY_RUN.
e2e_sandbox_assert_running() {
  if ! e2e_context_require E2E_SANDBOX_NAME; then
    return 1
  fi
  local name
  name="$(e2e_context_get E2E_SANDBOX_NAME)"
  e2e_env_trace "sandbox:check" "${name}"
  if e2e_env_is_dry_run; then
    echo "[dry-run] sandbox check ${name} (skipped)"
    return 0
  fi
  if ! command -v nemoclaw >/dev/null 2>&1; then
    echo "e2e_sandbox_assert_running: nemoclaw CLI not on PATH" >&2
    return 1
  fi
  if ! nemoclaw list 2>/dev/null | grep -q -E "^|[[:space:]]${name}[[:space:]]|${name}\$"; then
    echo "e2e_sandbox_assert_running: sandbox '${name}' not found in 'nemoclaw list'" >&2
    return 1
  fi
  return 0
}
