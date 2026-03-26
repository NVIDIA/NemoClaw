#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Port 8080 conflict during nemoclaw onboard (VDR3 #5)
#
# OPTIONAL / standalone — not invoked by test-e2e-cloud-experimental.sh. Run manually or from
# a separate CI job when you want to validate preflight port checks.
#
# Expects a working NemoClaw/OpenShell install from a prior onboard (gateway may
# hold 8080). Destroys the nemoclaw gateway, binds a dummy listener on 8080, runs
# nemoclaw onboard --non-interactive, asserts preflight fails with
# "Port 8080 is not available", then restores gateway (+ optional re-onboard).
#
# Exit codes:
#   0 — success
#   1 — failure
#   2 — skipped (no python3/python to bind 8080)
#
# Environment (typical):
#   NEMOCLAW_SANDBOX_NAME   — default: e2e-cloud-experimental
#   NEMOCLAW_NON_INTERACTIVE — should be 1 (onboard non-interactive)
#   NVIDIA_API_KEY          — required if onboard reaches cloud inference (restore path)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NVIDIA_API_KEY=nvapi-... bash test/e2e/test-port8080-conflict.sh

set -uo pipefail

PASS() { printf '\033[32m  [port8080] PASS: %s\033[0m\n' "$1"; }
FAIL() { printf '\033[31m  [port8080] FAIL: %s\033[0m\n' "$1"; }
INFO() { printf '\033[1;34m  [port8080] INFO:\033[0m %s\n' "$1"; }

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-experimental}"

if ! command -v nemoclaw >/dev/null 2>&1; then
  FAIL "nemoclaw not on PATH"
  exit 1
fi
if ! command -v openshell >/dev/null 2>&1; then
  FAIL "openshell not on PATH"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  INFO "python3/python not found — cannot bind port 8080 for this test"
  exit 2
fi

PYHTTP="python3"
command -v python3 >/dev/null 2>&1 || PYHTTP="python"

INFO "Stopping nemoclaw gateway so we can bind a non-OpenShell process on 8080..."
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
sleep 3

INFO "Starting dummy HTTP listener on 127.0.0.1:8080..."
$PYHTTP -m http.server 8080 --bind 127.0.0.1 >/dev/null 2>&1 &
occupier_pid=$!
sleep 1
if ! kill -0 "$occupier_pid" 2>/dev/null; then
  FAIL "Dummy listener on 8080 did not stay running (pid ${occupier_pid})"
  exit 1
fi
if ! curl -sf --max-time 2 "http://127.0.0.1:8080/" >/dev/null 2>&1; then
  kill "$occupier_pid" 2>/dev/null || true
  wait "$occupier_pid" 2>/dev/null || true
  FAIL "Could not reach dummy server on 127.0.0.1:8080"
  exit 1
fi
PASS "Port 8080 occupied by dummy process (PID ${occupier_pid})"

P4_LOG="$(mktemp)"
INFO "Running nemoclaw onboard --non-interactive (expect preflight to fail on port 8080)..."
set +e
nemoclaw onboard --non-interactive >"$P4_LOG" 2>&1
p4_exit=$?
set -euo pipefail
p4_out="$(cat "$P4_LOG")"
rm -f "$P4_LOG"

kill "$occupier_pid" 2>/dev/null || true
wait "$occupier_pid" 2>/dev/null || true

if [ "$p4_exit" -eq 0 ]; then
  FAIL "Expected nemoclaw onboard to exit non-zero when 8080 is taken (got 0)"
  exit 1
fi
PASS "nemoclaw onboard exited non-zero (${p4_exit}) with 8080 blocked"

if echo "$p4_out" | grep -Fq "Port 8080 is not available"; then
  PASS "Onboard output reports Port 8080 is not available (VDR3 #5)"
else
  FAIL "Expected 'Port 8080 is not available' in onboard output"
  exit 1
fi

INFO "Restoring nemoclaw gateway for subsequent phases..."
if ! openshell gateway start --name nemoclaw 2>&1; then
  FAIL "openshell gateway start --name nemoclaw failed after port test"
  exit 1
fi
gw_ok=0
for _i in 1 2 3 4 5 6 7 8 9 10; do
  if openshell status 2>&1 | grep -q "Connected"; then
    gw_ok=1
    break
  fi
  sleep 2
done
if [ "$gw_ok" -ne 1 ]; then
  FAIL "Gateway did not become healthy (openshell status) after restore"
  exit 1
fi
PASS "Gateway restored and reports Connected"

openshell forward start --background 18789 "$SANDBOX_NAME" 2>/dev/null || true

if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
  PASS "Sandbox '${SANDBOX_NAME}' present after gateway restore"
else
  INFO "Sandbox missing after gateway destroy/recreate — re-onboarding with NEMOCLAW_RECREATE_SANDBOX=1..."
  P4R_LOG="$(mktemp)"
  set +e
  NEMOCLAW_RECREATE_SANDBOX=1 nemoclaw onboard --non-interactive >"$P4R_LOG" 2>&1
  p4r_exit=$?
  set -euo pipefail
  if [ "$p4r_exit" -ne 0 ]; then
    FAIL "Re-onboard after port test failed (exit $p4r_exit); log: ${P4R_LOG}"
    exit 1
  fi
  rm -f "$P4R_LOG"
  openshell forward start --background 18789 "$SANDBOX_NAME" 2>/dev/null || true
  if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
    PASS "Sandbox '${SANDBOX_NAME}' recreated after port test"
  else
    FAIL "Sandbox '${SANDBOX_NAME}' still missing after re-onboard"
    exit 1
  fi
fi

PASS "Port 8080 conflict subtest complete"
exit 0
