#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Standardized non-interactive environment for E2E runs.
#
# Applies the same defaults historically set ad-hoc at the top of each
# `test/e2e/test-*.sh` script. Safe to source from any scenario runner.

# Auto-source the logging helpers so every consumer of env.sh gets
# e2e_section / e2e_info / e2e_pass / e2e_fail for free. Scenario runner
# and every suite step script sources env.sh — this keeps the logging
# contract DRY (reuse category #1).
_E2E_ENV_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${_E2E_ENV_LIB_DIR}/logging.sh" ]]; then
  # shellcheck source=logging.sh
  . "${_E2E_ENV_LIB_DIR}/logging.sh"
fi

e2e_env_apply_noninteractive() {
  export NEMOCLAW_NON_INTERACTIVE=1
  export DEBIAN_FRONTEND=noninteractive
  export NEMOCLAW_ACCEPT_THIRD_PARTY_TERMS=1
  export NEMOCLAW_ACCEPT_LICENSES=1
  export NEMOCLAW_DISABLE_UPDATE_CHECK=1
  # CI is usually already set, but ensure downstream tools see it.
  export CI="${CI:-1}"
}

# e2e_env_trace <event> [note ...]
# Append a trace line to $E2E_TRACE_FILE if set. Used by dry-run paths so
# tests can verify that helpers were invoked in the expected order without
# running real commands.
e2e_env_trace() {
  local event="${1:-}"
  shift || true
  if [[ -n "${E2E_TRACE_FILE:-}" ]]; then
    mkdir -p "$(dirname "${E2E_TRACE_FILE}")"
    printf '%s %s\n' "${event}" "$*" >>"${E2E_TRACE_FILE}"
  fi
}

# e2e_env_is_dry_run: true if E2E_DRY_RUN=1
e2e_env_is_dry_run() {
  [[ "${E2E_DRY_RUN:-0}" == "1" ]]
}
