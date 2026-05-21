#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

_sandbox_lifecycle_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../runtime/lib/context.sh
. "${_sandbox_lifecycle_dir}/../../runtime/lib/context.sh"

SANDBOX_LIFECYCLE_LAST_OUTPUT=""

sandbox_lifecycle_pass() {
  local id="$1" message="${2:-ok}"
  printf 'PASS: %s %s\n' "${id}" "${message}"
}

sandbox_lifecycle_fail() {
  local id="$1" message="${2:-failed}"
  printf 'FAIL: %s %s\n' "${id}" "${message}" >&2
  return 1
}

sandbox_lifecycle_load_context() {
  local ctx
  ctx="$(e2e_context_path)"
  if [[ ! -f "${ctx}" ]]; then
    sandbox_lifecycle_fail validation.sandbox_lifecycle.context "missing context.env at ${ctx}"
    return 1
  fi
  set -a
  # shellcheck source=/dev/null
  . "${ctx}"
  set +a
  e2e_context_require E2E_SANDBOX_NAME E2E_GATEWAY_URL || return 1
}

sandbox_lifecycle_run_with_timeout() {
  local seconds="$1"
  shift
  SANDBOX_LIFECYCLE_LAST_OUTPUT=""
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    SANDBOX_LIFECYCLE_LAST_OUTPUT="dry-run: $*"
    printf '%s\n' "${SANDBOX_LIFECYCLE_LAST_OUTPUT}"
    return 0
  fi
  if command -v timeout >/dev/null 2>&1; then
    SANDBOX_LIFECYCLE_LAST_OUTPUT="$(timeout "${seconds}" "$@" 2>&1)" || {
      local rc=$?
      printf '%s\n' "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" >&2
      return "${rc}"
    }
  else
    SANDBOX_LIFECYCLE_LAST_OUTPUT="$("$@" 2>&1)" || {
      local rc=$?
      printf '%s\n' "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" >&2
      return "${rc}"
    }
  fi
  printf '%s\n' "${SANDBOX_LIFECYCLE_LAST_OUTPUT}"
}

sandbox_lifecycle_assert_nemoclaw_list_contains_sandbox() {
  local id="validation.sandbox_operations.sandbox_listed"
  sandbox_lifecycle_run_with_timeout 20 nemoclaw list >/dev/null || {
    sandbox_lifecycle_fail "${id}" "nemoclaw list failed"
    return 1
  }
  [[ "${E2E_DRY_RUN:-0}" == "1" || "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" == *"${E2E_SANDBOX_NAME}"* ]] || {
    sandbox_lifecycle_fail "${id}" "sandbox not listed: ${E2E_SANDBOX_NAME}"
    return 1
  }
  sandbox_lifecycle_pass "${id}" "sandbox listed"
}

sandbox_lifecycle_assert_status_fields_present() {
  local id="validation.sandbox_operations.status_fields_present"
  sandbox_lifecycle_run_with_timeout 20 nemoclaw "${E2E_SANDBOX_NAME}" status >/dev/null || {
    sandbox_lifecycle_fail "${id}" "nemoclaw status failed"
    return 1
  }
  if [[ "${E2E_DRY_RUN:-0}" != "1" ]]; then
    local status_output_lower
    status_output_lower="$(printf '%s' "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" | tr '[:upper:]' '[:lower:]')"
    for field in status gateway sandbox; do
      [[ "${status_output_lower}" == *"${field}"* ]] || {
        sandbox_lifecycle_fail "${id}" "missing status field: ${field}"
        return 1
      }
    done
  fi
  sandbox_lifecycle_pass "${id}" "status fields present"
}

sandbox_lifecycle_assert_logs_available() {
  local id="validation.sandbox_operations.logs_available"
  sandbox_lifecycle_run_with_timeout 20 nemoclaw "${E2E_SANDBOX_NAME}" logs >/dev/null || {
    sandbox_lifecycle_fail "${id}" "nemoclaw logs failed"
    return 1
  }
  [[ "${E2E_DRY_RUN:-0}" == "1" || -n "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" ]] || {
    sandbox_lifecycle_fail "${id}" "logs empty"
    return 1
  }
  sandbox_lifecycle_pass "${id}" "logs available"
}

sandbox_lifecycle_assert_openshell_exec_ok() {
  local id="validation.sandbox_operations.openshell_exec_ok"
  sandbox_lifecycle_run_with_timeout 20 openshell sandbox exec "${E2E_SANDBOX_NAME}" -- sh -lc 'echo lifecycle-ok' >/dev/null || {
    sandbox_lifecycle_fail "${id}" "openshell exec failed"
    return 1
  }
  [[ "${E2E_DRY_RUN:-0}" == "1" || "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" == *"lifecycle-ok"* ]] || {
    sandbox_lifecycle_fail "${id}" "unexpected exec output"
    return 1
  }
  sandbox_lifecycle_pass "${id}" "openshell exec ok"
}

sandbox_lifecycle_assert_gateway_health() {
  local id="validation.sandbox_lifecycle.gateway_health"
  sandbox_lifecycle_run_with_timeout 20 curl -fsS "${E2E_GATEWAY_URL}/health" >/dev/null || {
    sandbox_lifecycle_fail "${id}" "gateway health failed"
    return 1
  }
  sandbox_lifecycle_pass "${id}" "gateway healthy"
}

sandbox_lifecycle_assert_gateway_recovers_after_probe() {
  local id="validation.sandbox_lifecycle.gateway_recovers"
  local _attempt
  for _attempt in 1 2 3; do
    if sandbox_lifecycle_run_with_timeout 20 curl -fsS "${E2E_GATEWAY_URL}/health" >/dev/null; then
      sandbox_lifecycle_pass "${id}" "gateway recovered after probe"
      return 0
    fi
    sleep 1
  done
  sandbox_lifecycle_fail "${id}" "gateway did not recover after bounded probes"
}

sandbox_lifecycle_assert_snapshot_create_list_restore_marker() {
  sandbox_lifecycle_run_with_timeout 30 openshell sandbox exec "${E2E_SANDBOX_NAME}" -- sh -lc 'echo lifecycle-marker-before-snapshot > /tmp/nemoclaw-lifecycle-marker' >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.marker_written "failed to write marker"
    return 1
  }
  sandbox_lifecycle_pass validation.sandbox_snapshot.marker_written "marker written"
  sandbox_lifecycle_run_with_timeout 30 nemoclaw snapshot create "${E2E_SANDBOX_NAME}" >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.create_succeeds "snapshot create failed"
    return 1
  }
  sandbox_lifecycle_pass validation.sandbox_snapshot.create_succeeds "snapshot create succeeded"
  sandbox_lifecycle_run_with_timeout 30 openshell sandbox exec "${E2E_SANDBOX_NAME}" -- sh -lc 'echo lifecycle-marker-after-snapshot > /tmp/nemoclaw-lifecycle-marker' >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.restore_rolls_back_marker "failed to mutate marker"
    return 1
  }
  sandbox_lifecycle_run_with_timeout 30 nemoclaw snapshot list "${E2E_SANDBOX_NAME}" >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.list_shows_snapshot "snapshot list failed"
    return 1
  }
  sandbox_lifecycle_pass validation.sandbox_snapshot.list_shows_snapshot "snapshot listed"
  sandbox_lifecycle_run_with_timeout 30 nemoclaw snapshot restore "${E2E_SANDBOX_NAME}" latest >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.restore_rolls_back_marker "snapshot restore failed"
    return 1
  }
  sandbox_lifecycle_run_with_timeout 30 openshell sandbox exec "${E2E_SANDBOX_NAME}" -- sh -lc 'test -f /tmp/nemoclaw-lifecycle-marker && grep -Fxq lifecycle-marker-before-snapshot /tmp/nemoclaw-lifecycle-marker' >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.restore_rolls_back_marker "marker did not roll back"
    return 1
  }
  sandbox_lifecycle_pass validation.sandbox_snapshot.restore_rolls_back_marker "marker rolled back"
}
