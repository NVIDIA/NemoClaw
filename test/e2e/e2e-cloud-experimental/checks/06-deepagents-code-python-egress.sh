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
DCODE_MANAGED_EXEC="/usr/local/lib/nemoclaw/dcode-managed-exec"

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

python_probe_source() {
  cat <<'PY'
import sys
import urllib.error
import urllib.request

DENIAL_MARKERS = (
    'access denied',
    'blocked by',
    'connection forbidden',
    'egress denied',
    'network is unreachable',
    'network policy',
    'operation not permitted',
    'permission denied',
    'policy denied',
    'tunnel connection failed',
)


def is_policy_denial(text):
    lowered = text.lower()
    return any(marker in lowered for marker in DENIAL_MARKERS)


url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=8) as response:
        print(f'REACHED:{response.status}')
except urllib.error.HTTPError as exc:
    body = ''
    try:
        body = exc.read(512).decode('utf-8', 'replace')
    except Exception:
        body = ''
    details = f'{exc} {body}'.strip()
    if is_policy_denial(details):
        print(f'BLOCKED:HTTPError:{details}')
    else:
        print(f'REACHED:{exc.code}')
except urllib.error.URLError as exc:
    details = str(exc.reason if getattr(exc, 'reason', None) is not None else exc)
    if is_policy_denial(details):
        print(f'BLOCKED:URLError:{details}')
    else:
        print(f'ERROR:URLError:{details}')
except OSError as exc:
    details = str(exc)
    if is_policy_denial(details):
        print(f'BLOCKED:{type(exc).__name__}:{details}')
    else:
        print(f'ERROR:{type(exc).__name__}:{details}')
except Exception as exc:
    print(f'ERROR:{type(exc).__name__}:{exc}')
PY
}

python_probe() {
  local python_bin="$1"
  local url="$2"
  local -a command_prefix=("${@:3}")
  local encoded remote_cmd
  if [ -n "${NEMOCLAW_E2E_PYTHON_PROBE_FIXTURE+x}" ]; then
    printf '%s\n' "$NEMOCLAW_E2E_PYTHON_PROBE_FIXTURE"
    return 0
  fi
  encoded="$(python_probe_source | base64 | tr -d '\n')"
  printf -v remote_cmd '%q ' "${command_prefix[@]}" "$python_bin"
  remote_cmd+="-c \"\$(printf '%s' ${encoded@Q} | base64 -d)\" ${url@Q}"
  sandbox_exec "$remote_cmd"
}

expect_reached() {
  local actor="$1"
  local label="$2"
  local url="$3"
  local python_bin="${4:-python3}"
  local output
  output="$(python_probe "$python_bin" "$url" || true)"
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
  local -a command_prefix=("${@:5}")
  local output
  output="$(python_probe "$python_bin" "$url" "${command_prefix[@]}" || true)"
  if echo "$output" | grep -q "BLOCKED:" && ! echo "$output" | grep -q "REACHED:"; then
    pass "${actor} cannot reach ${label} without explicit policy"
  elif echo "$output" | grep -q "REACHED:"; then
    fail_test "${actor} reached ${label} unexpectedly: $output"
  else
    fail_test "${actor} probe for ${label} lacked denial evidence: $output"
  fi
}

fetch_url_probe_source() {
  cat <<'PY'
import os
import sys

from deepagents_code.tools import fetch_url

DENIAL_MARKERS = (
    'access denied',
    'blocked by',
    'connection forbidden',
    'egress denied',
    'network policy',
    'operation not permitted',
    'permission denied',
    'policy denied',
    'tunnel connection failed',
)

if not os.environ.get('DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL'):
    print('FETCH_ERROR:managed fetch proxy delegation is absent')
    raise SystemExit(0)

result = fetch_url(sys.argv[1], timeout=8)
status = result.get('status_code')
content_length = result.get('content_length')
if (
    isinstance(status, int)
    and 200 <= status < 300
    and isinstance(content_length, int)
    and content_length > 0
):
    print(f'FETCH_SUCCESS:{status}:{content_length}')
else:
    details = str(result.get('error', result))
    lowered = details.lower()
    if any(marker in lowered for marker in DENIAL_MARKERS):
        print(f'FETCH_BLOCKED:{details}')
    else:
        print(f'FETCH_ERROR:{details}')
PY
}

fetch_url_probe() {
  local url="$1"
  local encoded remote_cmd
  if [ -n "${NEMOCLAW_E2E_FETCH_URL_PROBE_FIXTURE+x}" ]; then
    printf '%s\n' "$NEMOCLAW_E2E_FETCH_URL_PROBE_FIXTURE"
    return 0
  fi
  encoded="$(fetch_url_probe_source | base64 | tr -d '\n')"
  remote_cmd=". /tmp/nemoclaw-proxy-env.sh && /opt/venv/bin/python3 -c \"\$(printf '%s' ${encoded@Q} | base64 -d)\" ${url@Q}"
  sandbox_exec "$remote_cmd"
}

expect_fetch_reached() {
  local label="$1"
  local url="$2"
  local output
  output="$(fetch_url_probe "$url" || true)"
  if echo "$output" | grep -Eq 'FETCH_SUCCESS:2[0-9]{2}:[1-9][0-9]*'; then
    pass "Deep Agents fetch_url can reach approved ${label} host through the managed proxy"
  else
    fail_test "Deep Agents fetch_url could not reach approved ${label} host: $output"
  fi
}

expect_fetch_blocked() {
  local label="$1"
  local url="$2"
  local output
  output="$(fetch_url_probe "$url" || true)"
  if echo "$output" | grep -q "FETCH_BLOCKED:" && ! echo "$output" | grep -q "FETCH_SUCCESS:"; then
    pass "Deep Agents fetch_url cannot reach ${label} without explicit policy"
  elif echo "$output" | grep -q "FETCH_SUCCESS:"; then
    fail_test "Deep Agents fetch_url reached ${label} unexpectedly: $output"
  else
    fail_test "Deep Agents fetch_url probe for ${label} lacked denial evidence: $output"
  fi
}

PASSED=0
FAILED=0

if [ "${NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST:-}" = "blocked-no-marker" ]; then
  expect_blocked "self-test Python" "fixture host" "https://blocked.example/"
  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

if [ "${NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST:-}" = "probe-command-shape" ]; then
  sandbox_exec() {
    case "$1" in
      *$'\n'*)
        printf '%s\n' "NEWLINE_IN_COMMAND"
        return 1
        ;;
      *)
        printf 'SINGLE_LINE_COMMAND:%s\n' "$1"
        return 0
        ;;
    esac
  }
  python_probe "python3" "https://example.com/"
  python_probe "/opt/venv/bin/python3" "https://example.com/" "$DCODE_MANAGED_EXEC"
  exit 0
fi

if [ "${NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST:-}" = "fetch-probe-command-shape" ]; then
  sandbox_exec() {
    case "$1" in
      *$'\n'*)
        printf '%s\n' "NEWLINE_IN_COMMAND"
        return 1
        ;;
      *)
        printf '%s\n' "NO_NEWLINE_IN_FETCH_COMMAND"
        return 0
        ;;
    esac
  }
  fetch_url_probe "https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/README.md"
  exit 0
fi

if [ "${NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST:-}" = "fetch-success-classification" ]; then
  expect_fetch_reached "fixture host" "https://approved.example/"
  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

if [ "${NEMOCLAW_E2E_PYTHON_EGRESS_SELF_TEST:-}" = "fetch-blocked-classification" ]; then
  expect_fetch_blocked "fixture host" "https://blocked.example/"
  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

cleanup_project_venv() {
  sandbox_exec "rm -rf ${PROJECT_VENV@Q}" >/dev/null || true
}

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
# The public helper only reconstructs the trusted proxy environment; OpenShell
# must still enforce Tavily denial on the final managed-Python executable.
expect_blocked \
  "direct managed-exec Python" \
  "Tavily" \
  "https://api.tavily.com/" \
  "/opt/venv/bin/python3" \
  "$DCODE_MANAGED_EXEC"
expect_blocked "arbitrary Python" "LangSmith" "https://api.smith.langchain.com/"
expect_blocked "arbitrary Python" "MCP hosts" "https://modelcontextprotocol.io/"
expect_blocked "arbitrary Python" "unapproved hosts" "https://example.com/"

# Exercise the actual Deep Agents fetch_url transport. Unlike urllib, upstream
# fetch_url disables ambient proxies to pin direct DNS results; the managed
# image patch must instead force the root-owned OpenShell proxy without honoring
# NO_PROXY. The raw GitHub path covers the separate read-only policy endpoint.
expect_fetch_reached \
  "raw GitHub" \
  "https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/README.md"
expect_fetch_blocked "unapproved hosts" "https://example.com/"
expect_fetch_blocked "instance metadata" "https://169.254.169.254/latest/meta-data/"
expect_fetch_blocked "sandbox loopback" "https://127.0.0.1/"

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
