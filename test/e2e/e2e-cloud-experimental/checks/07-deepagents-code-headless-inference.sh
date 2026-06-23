#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code headless inference (#5619).
#
# Headless `dcode -n "<prompt>"`, run inside a built Deep Agents Code sandbox,
# must route through the managed https://inference.local/v1 endpoint using the
# placeholder OpenAI-compatible key NemoClaw writes into config.toml, and either
# return a response or a deterministic, actionable provider/model error (never a
# hang or ambiguous failure). No real provider/proxy credentials may appear in
# config.toml, .env, .mcp.json, /tmp/nemoclaw-proxy-env.sh, or the captured output.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}}"
PREFIX="07-deepagents-code-headless-inference"
HEADLESS_TIMEOUT="${DEEPAGENTS_HEADLESS_TIMEOUT:-120}"

ok() { printf '%s\n' "${PREFIX}: OK ($*)"; }
info() { printf '%s\n' "${PREFIX}: $*"; }
fail_test() {
  printf '%s\n' "${PREFIX}: FAIL: $1" >&2
  FAILED=$((FAILED + 1))
}
pass() {
  ok "$1"
  PASSED=$((PASSED + 1))
}

sandbox_exec() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c "$1" 2>&1
}

# Secret-shaped patterns that must never appear in managed config or output.
SECRET_PATTERN='nvapi-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}'

PASSED=0
FAILED=0

if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
  exit 0
fi

info "Running Deep Agents Code headless inference checks in sandbox: $SANDBOX_NAME"

# 1. config.toml points at the managed inference route, not a real provider host.
config_output="$(sandbox_exec "cat /sandbox/.deepagents/config.toml 2>/dev/null")"
if printf '%s' "$config_output" | grep -q "inference.local"; then
  pass "config.toml routes through the managed inference.local endpoint"
else
  fail_test "config.toml does not reference inference.local: ${config_output:0:200}"
fi

# 2. Headless dcode -n returns a response or a deterministic, actionable error.
headless_output="$(sandbox_exec "cd /sandbox && timeout ${HEADLESS_TIMEOUT} dcode -n 'Reply with exactly one word: PONG'; echo \"DCODE_EXIT:\$?\"")"
dcode_exit="$(printf '%s' "$headless_output" | sed -n 's/.*DCODE_EXIT:\([0-9]\+\).*/\1/p' | tail -n1)"
if [ "${dcode_exit:-1}" = "124" ]; then
  fail_test "dcode -n hung past ${HEADLESS_TIMEOUT}s (timeout); not a deterministic outcome"
elif [ -n "$(printf '%s' "$headless_output" | sed 's/DCODE_EXIT:[0-9]*//' | tr -d '[:space:]')" ]; then
  pass "dcode -n produced a deterministic response or actionable error (exit ${dcode_exit:-unknown})"
else
  fail_test "dcode -n produced no output and no actionable error"
fi

# 3. No real secrets in managed config, runtime env files, or the captured output.
leak_scan="$(sandbox_exec "cat /sandbox/.deepagents/config.toml /sandbox/.deepagents/.env /sandbox/.deepagents/.mcp.json /tmp/nemoclaw-proxy-env.sh 2>/dev/null")"
combined="${config_output}
${leak_scan}
${headless_output}"
if printf '%s' "$combined" | grep -Eq "$SECRET_PATTERN"; then
  fail_test "secret-shaped value found in config/env/output (redacted from log)"
else
  pass "no real provider/proxy credentials in config, runtime env, or output"
fi

printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
