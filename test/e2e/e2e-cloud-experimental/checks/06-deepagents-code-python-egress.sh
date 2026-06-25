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
DCODE_CANONICAL_PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
PROJECT_VENV="/sandbox/.nemoclaw-e2e-project-venv"
PROJECT_PYTHON="${PROJECT_VENV}/bin/python3"
PROJECT_PIP="${PROJECT_VENV}/bin/pip3"

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
  local python_bin="$1"
  local url="$2"
  sandbox_exec "${python_bin@Q} - ${url@Q} <<'PY'
import sys
import urllib.error
import urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=8) as response:
        print(f'REACHED:{response.status}')
except urllib.error.HTTPError as exc:
    print(f'REACHED:{exc.code}')
except Exception as exc:
    print(f'BLOCKED:{type(exc).__name__}:{exc}')
PY
"
}

expect_reached() {
  local actor="$1"
  local label="$2"
  local url="$3"
  local python_bin="${4:-python3}"
  local output
  output="$(python_probe "$python_bin" "$url")"
  if echo "$output" | grep -q "REACHED:"; then
    pass "${actor} can reach approved ${label} host"
  else
    fail_test "${actor} could not reach approved ${label} host: $output"
  fi
}

expect_blocked() {
  local actor="$1"
  local label="$2"
  local url="$3"
  local python_bin="${4:-python3}"
  local output
  output="$(python_probe "$python_bin" "$url")"
  if echo "$output" | grep -q "BLOCKED:" && ! echo "$output" | grep -q "REACHED:"; then
    pass "${actor} cannot reach ${label} without explicit policy"
  else
    fail_test "${actor} reached ${label} unexpectedly: $output"
  fi
}

cleanup_project_venv() {
  sandbox_exec "rm -rf ${PROJECT_VENV@Q}" >/dev/null || true
}

PASSED=0
FAILED=0

if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
  exit 0
fi
trap cleanup_project_venv EXIT

info "Running Deep Agents Code arbitrary-Python egress checks in sandbox: $SANDBOX_NAME"

# shellcheck disable=SC2016
OUT=$(sandbox_exec 'printf "PATH=%s\n" "$PATH"; printf "PYTHON=%s\n" "$(command -v python3)"; printf "PIP=%s\n" "$(command -v pip3)"; printf "PYTHON_REAL=%s\n" "$(readlink -f "$(command -v python3)")"; printf "PIP_REAL=%s\n" "$(readlink -f "$(command -v pip3)")"; printf "USRLOCAL_COUNT=%s\n" "$(printf "%s" "$PATH" | tr ":" "\n" | grep -cx "/usr/local/bin")"' || true)
if echo "$OUT" | grep -Fxq "PATH=${DCODE_CANONICAL_PATH}" \
  && echo "$OUT" | grep -q '^PYTHON=/opt/venv/bin/python3$' \
  && echo "$OUT" | grep -q '^PIP=/opt/venv/bin/pip3$' \
  && echo "$OUT" | grep -q '^PYTHON_REAL=/opt/venv/' \
  && echo "$OUT" | grep -q '^PIP_REAL=/opt/venv/' \
  && echo "$OUT" | grep -q '^USRLOCAL_COUNT=1$'; then
  pass "sandbox Python and pip resolve to the managed venv before system paths"
else
  fail_test "sandbox Python PATH does not resolve through the managed venv: $OUT"
fi

expect_reached "arbitrary Python" "GitHub" "https://api.github.com/"
expect_reached "arbitrary Python" "PyPI" "https://pypi.org/"
expect_blocked "arbitrary Python" "Tavily" "https://api.tavily.com/"
expect_blocked "arbitrary Python" "LangSmith" "https://api.smith.langchain.com/"
expect_blocked "arbitrary Python" "MCP hosts" "https://modelcontextprotocol.io/"
expect_blocked "arbitrary Python" "unapproved hosts" "https://example.com/"

# Exercise the writable-project-venv allowlist entries directly. The managed
# /opt/venv Python creates the project venv, then the probes run through the
# /sandbox/.../bin/python3 executable path that policy-additions.yaml allows
# for PyPI only.
PROJECT_OUT="$(sandbox_exec "rm -rf ${PROJECT_VENV@Q} && python3 -m venv --copies ${PROJECT_VENV@Q} && test -x ${PROJECT_PYTHON@Q} && test -x ${PROJECT_PIP@Q} && printf 'PROJECT_PYTHON=%s\n' \"\$(readlink -f ${PROJECT_PYTHON@Q})\" && printf 'PROJECT_PIP=%s\n' \"\$(readlink -f ${PROJECT_PIP@Q})\"" || true)"
if echo "$PROJECT_OUT" | grep -Fxq "PROJECT_PYTHON=${PROJECT_PYTHON}" \
  && echo "$PROJECT_OUT" | grep -Fxq "PROJECT_PIP=${PROJECT_PIP}"; then
  pass "project venv under /sandbox exposes python3 and pip3 executables"
  expect_reached "project venv Python under /sandbox" "PyPI" "https://pypi.org/" "$PROJECT_PYTHON"
  expect_reached "project venv Python under /sandbox" "files.pythonhosted.org" "https://files.pythonhosted.org/" "$PROJECT_PYTHON"
  expect_blocked "project venv Python under /sandbox" "Tavily" "https://api.tavily.com/" "$PROJECT_PYTHON"
  expect_blocked "project venv Python under /sandbox" "LangSmith" "https://api.smith.langchain.com/" "$PROJECT_PYTHON"
  expect_blocked "project venv Python under /sandbox" "MCP hosts" "https://modelcontextprotocol.io/" "$PROJECT_PYTHON"
  expect_blocked "project venv Python under /sandbox" "unapproved hosts" "https://example.com/" "$PROJECT_PYTHON"
else
  fail_test "project venv under /sandbox did not create usable python3/pip3 executables: $PROJECT_OUT"
fi

printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
