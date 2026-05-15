#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Cleanup helpers. Wraps the existing sandbox-teardown.sh so scenario code
# gets a single, discoverable entrypoint.

_E2E_CLEAN_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=sandbox-teardown.sh
. "${_E2E_CLEAN_LIB_DIR}/sandbox-teardown.sh"
# shellcheck source=context.sh
. "${_E2E_CLEAN_LIB_DIR}/context.sh"
# shellcheck source=env.sh
. "${_E2E_CLEAN_LIB_DIR}/env.sh"

# e2e_cleanup_register_sandbox [name]
# Default to E2E_SANDBOX_NAME from context.
e2e_cleanup_register_sandbox() {
  local name="${1:-}"
  if [[ -z "${name}" ]]; then
    name="$(e2e_context_get E2E_SANDBOX_NAME)"
  fi
  if [[ -z "${name}" ]]; then
    echo "e2e_cleanup_register_sandbox: no sandbox name to register" >&2
    return 0
  fi
  register_sandbox_for_teardown "${name}"
}
