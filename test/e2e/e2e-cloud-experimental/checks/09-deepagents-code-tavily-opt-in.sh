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

sandbox_exec_argv() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- "$@" 2>&1
}

observability_marker_value() {
  # Expansion is intentionally deferred to the sandbox shell.
  # shellcheck disable=SC2016
  openshell sandbox exec --name "$SANDBOX_NAME" -- \
    sh -c 'marker=/sandbox/.deepagents/.nemoclaw-observability-enabled; if test -f "$marker" && ! test -L "$marker"; then cat "$marker"; else printf "absent"; fi' \
    2>/dev/null
}

observability_registry_state() {
  SANDBOX_NAME="$SANDBOX_NAME" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const registry = JSON.parse(
  fs.readFileSync(path.join(process.env.HOME, ".nemoclaw", "sandboxes.json"), "utf8"),
);
const entry = registry.sandboxes?.[process.env.SANDBOX_NAME];
if (!entry || entry.agent !== "langchain-deepagents-code" ||
    typeof entry.observabilityEnabled !== "boolean") process.exit(1);
process.stdout.write(entry.observabilityEnabled ? "enabled" : "disabled");
NODE
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
import json
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
request = urllib.request.Request(
    url,
    data=json.dumps({'query': 'nemoclaw reachability probe', 'max_results': 1}).encode('utf-8'),
    headers={'Content-Type': 'application/json'},
    method='POST',
)
try:
    with urllib.request.urlopen(request, timeout=8) as response:
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
  local source
  if [ -n "${NEMOCLAW_E2E_TAVILY_PROBE_FIXTURE+x}" ]; then
    printf '%s\n' "$NEMOCLAW_E2E_TAVILY_PROBE_FIXTURE"
    return 0
  fi
  source="$(python_probe_source)"
  sandbox_exec_argv "$python_bin" -c "$source" "$url"
}

verify_observability_state() {
  local phase="$1" marker_state registry_state
  if ! registry_state="$(observability_registry_state 2>&1)"; then
    fail_test "could not read authoritative host observability intent $phase: ${registry_state:-no diagnostic}"
    return 1
  fi
  marker_state="$(observability_marker_value || true)"
  if [ "$registry_state" != "enabled" ] || [ "$marker_state" != "1" ]; then
    fail_test "observability state drifted $phase (registry=${registry_state:-unreadable}, marker=${marker_state:-unreadable})"
    return 1
  fi
  pass "host registry and persistent marker preserve enabled observability $phase"
}

restore_tavily_denial() {
  local cleanup_status=0 remove_output post_remove_probe_output
  if ! remove_output="$(nemoclaw_cli "$SANDBOX_NAME" policy-remove tavily --yes 2>&1)"; then
    fail_test "policy-remove tavily failed after the opt-in proof: $remove_output"
    cleanup_status=1
  else
    sleep "${NEMOCLAW_E2E_POLICY_SETTLE_SECONDS:-5}"
    post_remove_probe_output="$(python_probe "https://api.tavily.com/search" || true)"
    if [[ "$post_remove_probe_output" == *"BLOCKED:"* &&
      "$post_remove_probe_output" != *"REACHED:"* ]]; then
      pass "managed Deep Agents Code python returns to the default Tavily denial"
    else
      fail_test "policy-remove did not restore the default Tavily denial: $post_remove_probe_output"
      cleanup_status=1
    fi
  fi

  verify_observability_state "after policy-remove" || cleanup_status=1
  return "$cleanup_status"
}

PASSED=0
FAILED=0

if [ "${NEMOCLAW_E2E_TAVILY_SELF_TEST:-}" = "probe-command-shape" ]; then
  sandbox_exec_argv() {
    local argument
    for argument in "$@"; do
      if [[ "$argument" == *$'\n'* ]]; then
        printf '%s\n' "NATIVE_MULTILINE_ARGV"
        return 0
      fi
    done
    printf '%s\n' "MISSING_MULTILINE_ARGV"
    return 1
  }
  python_probe "https://api.tavily.com/search"
  exit 0
fi

if [ "${NEMOCLAW_E2E_TAVILY_SELF_TEST:-}" = "restore-denial" ]; then
  OBSERVABILITY_MARKER_FIXTURE="$(mktemp)"
  printf '%s\n' "1" >"$OBSERVABILITY_MARKER_FIXTURE"
  trap 'rm -f "$OBSERVABILITY_MARKER_FIXTURE"' EXIT
  observability_marker_value() {
    cat "$OBSERVABILITY_MARKER_FIXTURE"
  }
  observability_registry_state() {
    printf '%s' "${NEMOCLAW_E2E_OBSERVABILITY_REGISTRY_FIXTURE:-enabled}"
  }
  nemoclaw_cli() {
    [[ "$*" == "$SANDBOX_NAME policy-remove tavily --yes" ]] || return 1
    case "${NEMOCLAW_E2E_TAVILY_REMOVE_FIXTURE:-ok}" in
      ok) ;;
      clear-marker) printf '%s\n' "absent" >"$OBSERVABILITY_MARKER_FIXTURE" ;;
      *) return 1 ;;
    esac
  }
  verify_observability_state "before Tavily policy mutation" || exit 1
  cleanup_status=0
  NEMOCLAW_E2E_POLICY_SETTLE_SECONDS=0 restore_tavily_denial || cleanup_status=$?
  [ "$(cat "$OBSERVABILITY_MARKER_FIXTURE")" = "1" ]
  exit "$cleanup_status"
fi

if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
  exit 0
fi

info "Running Deep Agents Code Tavily opt-in check in sandbox: $SANDBOX_NAME"

verify_observability_state "before Tavily policy mutation" || exit 1

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
trap restore_tavily_denial EXIT
pass "tavily policy preset applies"

sleep "${NEMOCLAW_E2E_POLICY_SETTLE_SECONDS:-5}"

PROBE_OUTPUT="$(python_probe "https://api.tavily.com/search")"
if echo "$PROBE_OUTPUT" | grep -q "REACHED:"; then
  pass "managed Deep Agents Code python can reach Tavily after policy-add"
elif echo "$PROBE_OUTPUT" | grep -q "BLOCKED:"; then
  fail_test "managed Deep Agents Code python is still policy-blocked after policy-add: $PROBE_OUTPUT"
else
  fail_test "Tavily probe lacked reachability evidence after policy-add: $PROBE_OUTPUT"
fi

SYSTEM_PROBE_OUTPUT="$(python_probe "https://api.tavily.com/search" "/usr/bin/python3" || true)"
if echo "$SYSTEM_PROBE_OUTPUT" | grep -q "BLOCKED:" && ! echo "$SYSTEM_PROBE_OUTPUT" | grep -q "REACHED:"; then
  pass "system Python remains blocked from Tavily after policy-add"
elif echo "$SYSTEM_PROBE_OUTPUT" | grep -q "REACHED:"; then
  fail_test "system Python reached Tavily unexpectedly after policy-add: $SYSTEM_PROBE_OUTPUT"
else
  fail_test "system Python Tavily probe lacked denial evidence after policy-add: $SYSTEM_PROBE_OUTPUT"
fi

PROJECT_OUT="$(sandbox_exec "if ! test -x ${PROJECT_PYTHON@Q}; then python3 -m venv --copies ${PROJECT_VENV@Q}; fi; test -x ${PROJECT_PYTHON@Q} && readlink -f ${PROJECT_PYTHON@Q}" || true)"
if echo "$PROJECT_OUT" | grep -Fxq "$PROJECT_PYTHON"; then
  PROJECT_PROBE_OUTPUT="$(python_probe "https://api.tavily.com/search" "$PROJECT_PYTHON" || true)"
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

# Do not leak this check's durable opt-in into later sequential checks.
restore_tavily_denial || true
trap - EXIT

printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
