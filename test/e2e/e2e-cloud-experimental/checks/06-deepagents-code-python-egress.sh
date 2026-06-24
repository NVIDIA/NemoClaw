#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code Python egress boundary (#4861).
#
# Deep Agents Code network traffic is attributed to the Python interpreter by
# OpenShell. This live check documents the supported boundary: arbitrary Python
# may use only the hosts explicitly present in policy-additions.yaml, while
# optional Tavily, LangSmith, MCP, and arbitrary hosts remain denied until a
# user adds explicit policy.

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}}"
PREFIX="06-deepagents-code-python-egress"

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

python_probe() {
  local url="$1"
  sandbox_exec "python3 - ${url@Q} <<'PY'
import sys
import urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=8) as response:
        print(f'REACHED:{response.status}')
except Exception as exc:
    print(f'BLOCKED:{type(exc).__name__}:{exc}')
PY
"
}

expect_reached() {
  local label="$1"
  local url="$2"
  local output
  output="$(python_probe "$url")"
  if echo "$output" | grep -q "REACHED:"; then
    pass "arbitrary Python can reach approved ${label} host"
  else
    fail_test "arbitrary Python could not reach approved ${label} host: $output"
  fi
}

expect_blocked() {
  local label="$1"
  local url="$2"
  local output
  output="$(python_probe "$url")"
  if echo "$output" | grep -q "BLOCKED:" && ! echo "$output" | grep -q "REACHED:"; then
    pass "arbitrary Python cannot reach ${label} without explicit policy"
  else
    fail_test "arbitrary Python reached ${label} unexpectedly: $output"
  fi
}

PASSED=0
FAILED=0

if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
  exit 0
fi

info "Running Deep Agents Code arbitrary-Python egress checks in sandbox: $SANDBOX_NAME"

expect_reached "GitHub" "https://api.github.com/"
expect_reached "PyPI" "https://pypi.org/"
expect_blocked "Tavily" "https://api.tavily.com/"
expect_blocked "LangSmith" "https://api.smith.langchain.com/"
expect_blocked "MCP hosts" "https://modelcontextprotocol.io/"
expect_blocked "unapproved hosts" "https://example.com/"

printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
