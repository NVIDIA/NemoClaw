#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

_sandbox_lifecycle_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../runtime/lib/context.sh
. "${_sandbox_lifecycle_dir}/../../runtime/lib/context.sh"
# shellcheck source=../sandbox-exec.sh
. "${_sandbox_lifecycle_dir}/../sandbox-exec.sh"

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

# _sandbox_lifecycle_sandbox_exec <seconds> <cmd> [args...]
#
# Routes ssh-into-sandbox calls through the canonical e2e_sandbox_exec
# wrapper (ssh-config preferred transport, openshell-exec fallback,
# classified diagnostic on hang) instead of invoking
# `openshell sandbox exec` directly. Behavior contract for callers:
#   - On success: SANDBOX_LIFECYCLE_LAST_OUTPUT contains stdout+stderr;
#     stdout is also printed (matches sandbox_lifecycle_run_with_timeout).
#   - On failure: returns the wrapper's exit code (124 on hang, real
#     command exit otherwise) and prints the captured output to stderr.
#
# Why a separate helper instead of just calling e2e_sandbox_exec at the
# call sites: this lib's existing assert helpers all read
# SANDBOX_LIFECYCLE_LAST_OUTPUT after the timeout helper returns. Keeping
# that contract intact lets us migrate without rewriting every assert.
_sandbox_lifecycle_sandbox_exec() {
  local seconds="$1"
  shift
  SANDBOX_LIFECYCLE_LAST_OUTPUT=""
  local rc=0
  SANDBOX_LIFECYCLE_LAST_OUTPUT="$(
    E2E_SANDBOX_EXEC_TIMEOUT_SECONDS="${seconds}" \
      e2e_sandbox_exec "${E2E_SANDBOX_NAME}" -- "$@" 2>&1
  )" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    printf '%s\n' "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" >&2
    return "${rc}"
  fi
  printf '%s\n' "${SANDBOX_LIFECYCLE_LAST_OUTPUT}"
}

sandbox_lifecycle_assert_nemoclaw_list_contains_sandbox() {
  local id="validation.sandbox_operations.sandbox_listed"
  sandbox_lifecycle_run_with_timeout 20 nemoclaw list >/dev/null || {
    sandbox_lifecycle_fail "${id}" "nemoclaw list failed"
    return 1
  }
  # Match the sandbox name exactly as a whole token; substring match
  # would let `sb1` falsely match `sb10`.
  awk -v n="${E2E_SANDBOX_NAME}" '$1 == n { found = 1 } END { exit !found }' \
    <<<"${SANDBOX_LIFECYCLE_LAST_OUTPUT}" || {
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
  # The real `nemoclaw <name> status` output (src/lib/actions/sandbox/status.ts)
  # always emits a 'Sandbox: <name>' header plus structured fields like
  # 'Model:', 'OpenShell:', 'Policies:'. The original assertion required
  # literal 'status' and 'gateway' tokens that never appear in normal
  # output — it only passed against the test-suite mock. Align with the
  # production CLI: require the sandbox name and a couple of substantive
  # field labels that are unconditionally printed.
  local output="${SANDBOX_LIFECYCLE_LAST_OUTPUT}"
  if [[ "${output}" != *"${E2E_SANDBOX_NAME}"* ]]; then
    sandbox_lifecycle_fail "${id}" "status output did not mention sandbox '${E2E_SANDBOX_NAME}'"
    return 1
  fi
  local field
  for field in Sandbox Model OpenShell; do
    [[ "${output}" == *"${field}"* ]] || {
      sandbox_lifecycle_fail "${id}" "missing status field: ${field}"
      return 1
    }
  done
  sandbox_lifecycle_pass "${id}" "status fields present"
}

sandbox_lifecycle_assert_logs_available() {
  local id="validation.sandbox_operations.logs_available"
  sandbox_lifecycle_run_with_timeout 20 nemoclaw "${E2E_SANDBOX_NAME}" logs >/dev/null || {
    sandbox_lifecycle_fail "${id}" "nemoclaw logs failed"
    return 1
  }
  [[ -n "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" ]] || {
    sandbox_lifecycle_fail "${id}" "logs empty"
    return 1
  }
  sandbox_lifecycle_pass "${id}" "logs available"
}

sandbox_lifecycle_assert_openshell_exec_ok() {
  local id="validation.sandbox_operations.openshell_exec_ok"
  _sandbox_lifecycle_sandbox_exec 20 sh -lc 'echo lifecycle-ok' >/dev/null || {
    sandbox_lifecycle_fail "${id}" "openshell exec failed"
    return 1
  }
  [[ "${SANDBOX_LIFECYCLE_LAST_OUTPUT}" == *"lifecycle-ok"* ]] || {
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
  _sandbox_lifecycle_sandbox_exec 30 sh -lc 'echo lifecycle-marker-before-snapshot > /tmp/nemoclaw-lifecycle-marker' >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.marker_written "failed to write marker"
    return 1
  }
  sandbox_lifecycle_pass validation.sandbox_snapshot.marker_written "marker written"
  # Argv shape: `nemoclaw <sandbox> snapshot <subcommand>`. The earlier
  # form `nemoclaw snapshot create <sandbox>` parsed `snapshot` as a
  # sandbox name and produced the misleading 'Unknown command: snapshot'
  # error. Mirrors test/e2e/test-snapshot-commands.sh argv layout.
  sandbox_lifecycle_run_with_timeout 30 nemoclaw "${E2E_SANDBOX_NAME}" snapshot create >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.create_succeeds "snapshot create failed"
    return 1
  }
  sandbox_lifecycle_pass validation.sandbox_snapshot.create_succeeds "snapshot create succeeded"
  _sandbox_lifecycle_sandbox_exec 30 sh -lc 'echo lifecycle-marker-after-snapshot > /tmp/nemoclaw-lifecycle-marker' >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.restore_rolls_back_marker "failed to mutate marker"
    return 1
  }
  sandbox_lifecycle_run_with_timeout 30 nemoclaw "${E2E_SANDBOX_NAME}" snapshot list >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.list_shows_snapshot "snapshot list failed"
    return 1
  }
  sandbox_lifecycle_pass validation.sandbox_snapshot.list_shows_snapshot "snapshot listed"
  # `snapshot restore` with no positional arg defaults to latest;
  # matches test/e2e/test-snapshot-commands.sh Phase 6.
  sandbox_lifecycle_run_with_timeout 30 nemoclaw "${E2E_SANDBOX_NAME}" snapshot restore >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.restore_rolls_back_marker "snapshot restore failed"
    return 1
  }
  _sandbox_lifecycle_sandbox_exec 30 sh -lc 'test -f /tmp/nemoclaw-lifecycle-marker && grep -Fxq lifecycle-marker-before-snapshot /tmp/nemoclaw-lifecycle-marker' >/dev/null || {
    sandbox_lifecycle_fail validation.sandbox_snapshot.restore_rolls_back_marker "marker did not roll back"
    return 1
  }
  sandbox_lifecycle_pass validation.sandbox_snapshot.restore_rolls_back_marker "marker rolled back"
}
