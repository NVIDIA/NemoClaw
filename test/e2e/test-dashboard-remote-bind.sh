#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -uo pipefail

section() { printf '\n=== %s ===\n' "$1"; }
pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  exit 1
}
info() { echo "INFO: $1"; }

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-test}"
DASHBOARD_PORT="${NEMOCLAW_DASHBOARD_PORT:-18789}"
REMOTE_HOST="${NEMOCLAW_E2E_REMOTE_HOST:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
if [ -z "$REMOTE_HOST" ]; then
  REMOTE_HOST="$(hostname -f 2>/dev/null || hostname)"
fi

section "Preconditions"
info "Sandbox: ${SANDBOX_NAME}"
info "Dashboard port: ${DASHBOARD_PORT}"
info "Remote host candidate: ${REMOTE_HOST}"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw CLI is not on PATH"
fi
if ! command -v openshell >/dev/null 2>&1; then
  fail "openshell CLI is not on PATH"
fi
pass "Required CLIs are available"

section "Restart dashboard forward with explicit all-interface bind"
# The coverage guard mirrors issue #3259: remote SSH-deployed hosts need an
# explicit operator-controlled way to bind the dashboard forward on all
# interfaces. On main, NEMOCLAW_DASHBOARD_BIND is ignored and the forward stays
# localhost-only; the fix should make this opt-in produce 0.0.0.0:<port>.
openshell forward stop "${DASHBOARD_PORT}" >/dev/null 2>&1 || true
CONNECT_LOG="$(mktemp -t nemoclaw-dashboard-remote-bind.XXXXXX.log)"
trap 'rm -f "${CONNECT_LOG}"' EXIT
if NEMOCLAW_DASHBOARD_BIND=0.0.0.0 nemoclaw "${SANDBOX_NAME}" connect >"${CONNECT_LOG}" 2>&1; then
  pass "nemoclaw connect completed with NEMOCLAW_DASHBOARD_BIND=0.0.0.0"
else
  cat "${CONNECT_LOG}"
  fail "nemoclaw connect failed with NEMOCLAW_DASHBOARD_BIND=0.0.0.0"
fi

section "Verify OpenShell forward bind"
FORWARD_LIST="$(openshell forward list 2>/dev/null || true)"
printf '%s\n' "${FORWARD_LIST}"
FORWARD_LINE="$(printf '%s\n' "${FORWARD_LIST}" | awk -v sandbox="${SANDBOX_NAME}" -v port="${DASHBOARD_PORT}" '$0 ~ sandbox && $0 ~ port {print; exit}')"
if [ -z "${FORWARD_LINE}" ]; then
  fail "No OpenShell forward found for ${SANDBOX_NAME} on ${DASHBOARD_PORT}"
fi
info "Matched forward: ${FORWARD_LINE}"

case "${FORWARD_LINE}" in
  *"0.0.0.0:${DASHBOARD_PORT}"* | *"*:""${DASHBOARD_PORT}"* | *"0.0.0.0 "*" ${DASHBOARD_PORT} "*)
    pass "Dashboard forward binds all interfaces for remote origin (${DASHBOARD_PORT})"
    ;;
  *"127.0.0.1:${DASHBOARD_PORT}"* | *"localhost:${DASHBOARD_PORT}"* | *"127.0.0.1 "*" ${DASHBOARD_PORT} "*)
    fail "Dashboard forward is still localhost-only; expected 0.0.0.0:${DASHBOARD_PORT}"
    ;;
  *)
    fail "Could not prove dashboard forward uses 0.0.0.0:${DASHBOARD_PORT} from: ${FORWARD_LINE}"
    ;;
esac

section "Summary"
pass "Remote dashboard bind guard completed"
