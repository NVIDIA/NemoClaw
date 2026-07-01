#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: Deep Agents Code Tavily opt-in policy (#5739).

set -euo pipefail

SANDBOX_NAME="${SANDBOX_NAME:-${NEMOCLAW_SANDBOX_NAME:-e2e-cloud-onboard}}"
PREFIX="09-deepagents-code-tavily-opt-in"
REPO="${REPO:-$(pwd)}"
CLI="${NEMOCLAW_E2E_CLI:-${REPO}/bin/nemoclaw.js}"
PROJECT_VENV="/sandbox/.nemoclaw-e2e-project-venv"
PROJECT_PYTHON="${PROJECT_VENV}/bin/python3"

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

nemoclaw_cli() {
  if [ -f "$CLI" ]; then
    node "$CLI" "$@"
  else
    nemoclaw "$@"
  fi
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
  local url="$1"
  local python_bin="${2:-python3}"
  local encoded remote_cmd
  if [ -n "${NEMOCLAW_E2E_TAVILY_PROBE_FIXTURE+x}" ]; then
    printf '%s\n' "$NEMOCLAW_E2E_TAVILY_PROBE_FIXTURE"
    return 0
  fi
  encoded="$(python_probe_source | base64 | tr -d '\n')"
  remote_cmd="${python_bin@Q} -c \"\$(printf '%s' ${encoded@Q} | base64 -d)\" ${url@Q}"
  sandbox_exec "$remote_cmd"
}

PASSED=0
FAILED=0

if [ "${NEMOCLAW_E2E_TAVILY_SELF_TEST:-}" = "probe-command-shape" ]; then
  sandbox_exec() {
    case "$1" in
      *$'\n'*)
        printf '%s\n' "NEWLINE_IN_COMMAND"
        return 1
        ;;
      *)
        printf '%s\n' "NO_NEWLINE_IN_COMMAND"
        return 0
        ;;
    esac
  }
  python_probe "https://api.tavily.com/"
  exit 0
fi

if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
  exit 0
fi

info "Running Deep Agents Code Tavily opt-in check in sandbox: $SANDBOX_NAME"

# shellcheck disable=SC2016 # command substitution must run inside the sandbox.
PYTHON_REAL="$(sandbox_exec 'readlink -f "$(command -v python3)"' || true)"
if [[ "$PYTHON_REAL" == /opt/venv/* ]]; then
  pass "sandbox python resolves through the managed Deep Agents Code venv"
else
  fail_test "sandbox python does not resolve through /opt/venv: $PYTHON_REAL"
fi

DRY_RUN_OUTPUT="$(nemoclaw_cli "$SANDBOX_NAME" policy-add tavily --dry-run 2>&1)" || {
  fail_test "policy-add tavily --dry-run failed: $DRY_RUN_OUTPUT"
  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  exit 1
}
if echo "$DRY_RUN_OUTPUT" | grep -q "api.tavily.com"; then
  pass "tavily dry-run shows api.tavily.com"
else
  fail_test "tavily dry-run did not show api.tavily.com: $DRY_RUN_OUTPUT"
fi

APPLY_OUTPUT="$(nemoclaw_cli "$SANDBOX_NAME" policy-add tavily --yes 2>&1)" || {
  fail_test "policy-add tavily failed: $APPLY_OUTPUT"
  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  exit 1
}
pass "tavily policy preset applies"

sleep "${NEMOCLAW_E2E_POLICY_SETTLE_SECONDS:-5}"

PROBE_OUTPUT="$(python_probe "https://api.tavily.com/")"
if echo "$PROBE_OUTPUT" | grep -q "REACHED:"; then
  pass "managed Deep Agents Code python can reach Tavily after policy-add"
elif echo "$PROBE_OUTPUT" | grep -q "BLOCKED:"; then
  fail_test "managed Deep Agents Code python is still policy-blocked after policy-add: $PROBE_OUTPUT"
else
  fail_test "Tavily probe lacked reachability evidence after policy-add: $PROBE_OUTPUT"
fi

SYSTEM_PROBE_OUTPUT="$(python_probe "https://api.tavily.com/" "/usr/bin/python3" || true)"
if echo "$SYSTEM_PROBE_OUTPUT" | grep -q "BLOCKED:" && ! echo "$SYSTEM_PROBE_OUTPUT" | grep -q "REACHED:"; then
  pass "system Python remains blocked from Tavily after policy-add"
elif echo "$SYSTEM_PROBE_OUTPUT" | grep -q "REACHED:"; then
  fail_test "system Python reached Tavily unexpectedly after policy-add: $SYSTEM_PROBE_OUTPUT"
else
  fail_test "system Python Tavily probe lacked denial evidence after policy-add: $SYSTEM_PROBE_OUTPUT"
fi

PROJECT_OUT="$(sandbox_exec "if ! test -x ${PROJECT_PYTHON@Q}; then python3 -m venv --copies ${PROJECT_VENV@Q}; fi; test -x ${PROJECT_PYTHON@Q} && readlink -f ${PROJECT_PYTHON@Q}" || true)"
if echo "$PROJECT_OUT" | grep -Fxq "$PROJECT_PYTHON"; then
  PROJECT_PROBE_OUTPUT="$(python_probe "https://api.tavily.com/" "$PROJECT_PYTHON" || true)"
  if echo "$PROJECT_PROBE_OUTPUT" | grep -q "BLOCKED:" && ! echo "$PROJECT_PROBE_OUTPUT" | grep -q "REACHED:"; then
    pass "project venv Python under /sandbox remains blocked from Tavily after policy-add"
  elif echo "$PROJECT_PROBE_OUTPUT" | grep -q "REACHED:"; then
    fail_test "project venv Python reached Tavily unexpectedly after policy-add: $PROJECT_PROBE_OUTPUT"
  else
    fail_test "project venv Python Tavily probe lacked denial evidence after policy-add: $PROJECT_PROBE_OUTPUT"
  fi
else
  fail_test "project venv under /sandbox did not expose a usable python3 executable: $PROJECT_OUT"
fi

printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
