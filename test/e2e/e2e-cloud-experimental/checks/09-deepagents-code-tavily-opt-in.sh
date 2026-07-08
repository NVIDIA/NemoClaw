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

observability_marker_value() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- \
    sh -c "marker=/tmp/nemoclaw-observability-enabled; if test -f \"\$marker\" && ! test -L \"\$marker\"; then cat \"\$marker\"; else printf \"absent\"; fi" \
    2>/dev/null
}

nemoclaw_cli() {
  if [ -f "$CLI" ]; then
    node "$CLI" "$@"
  else
    nemoclaw "$@"
  fi
}

TAVILY_POLICY_CLEANUP_REQUIRED=0
POLICY_CLEANUP_TRACE=""
POLICY_CLEANUP_FIXTURE_DIR=""
POLICY_CLEANUP_EMIT_TRACE_ON_EXIT=0

cleanup_tavily_policy() {
  if [ "$TAVILY_POLICY_CLEANUP_REQUIRED" != "1" ]; then
    return 0
  fi
  TAVILY_POLICY_CLEANUP_REQUIRED=0
  nemoclaw_cli "$SANDBOX_NAME" policy-remove tavily --yes >/dev/null 2>&1 || true
}

cleanup_tavily_check() {
  local exit_status=$?
  cleanup_tavily_policy
  if [ "$POLICY_CLEANUP_EMIT_TRACE_ON_EXIT" = "1" ] && [ -f "$POLICY_CLEANUP_TRACE" ]; then
    cat "$POLICY_CLEANUP_TRACE" || true
  fi
  if [ -n "$POLICY_CLEANUP_FIXTURE_DIR" ]; then
    rm -rf "$POLICY_CLEANUP_FIXTURE_DIR"
  fi
  return "$exit_status"
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
  python_probe "https://api.tavily.com/search"
  exit 0
fi

if [[ "${NEMOCLAW_E2E_TAVILY_SELF_TEST:-}" =~ ^policy-cleanup-(order|on-probe-failure)$ ]]; then
  POLICY_CLEANUP_FIXTURE_DIR="$(mktemp -d)"
  POLICY_CLEANUP_TRACE="${POLICY_CLEANUP_FIXTURE_DIR}/trace"
  POLICY_CLEANUP_STATE="${POLICY_CLEANUP_FIXTURE_DIR}/policy-state"
  POLICY_CLEANUP_MARKER="${POLICY_CLEANUP_FIXTURE_DIR}/observability-marker"
  if [ "$NEMOCLAW_E2E_TAVILY_SELF_TEST" = "policy-cleanup-on-probe-failure" ]; then
    POLICY_CLEANUP_EMIT_TRACE_ON_EXIT=1
  fi
  printf '%s\n' "baseline" >"$POLICY_CLEANUP_STATE"
  printf '%s\n' "1" >"$POLICY_CLEANUP_MARKER"
  trap cleanup_tavily_check EXIT

  sandbox_exec() {
    case "$1" in
      *"test -d /sandbox/.deepagents"*) return 0 ;;
      *"readlink -f \"\$(command -v python3)\""*) printf '%s\n' "/opt/venv/bin/python3" ;;
      *"/sandbox/.nemoclaw-e2e-project-venv"*) printf '%s\n' "$PROJECT_PYTHON" ;;
      *)
        printf '%s\n' "unexpected sandbox command in Tavily cleanup self-test" >&2
        return 91
        ;;
    esac
  }
  observability_marker_value() {
    cat "$POLICY_CLEANUP_MARKER"
  }
  nemoclaw_cli() {
    local action="${2:-}:${3:-}:${4:-}"
    case "$action" in
      policy-add:tavily:--dry-run) printf '%s\n' "api.tavily.com" ;;
      policy-add:tavily:--yes)
        printf '%s\n' "added" >"$POLICY_CLEANUP_STATE"
        printf '%s\n' "TRACE:opt-in-proof" >>"$POLICY_CLEANUP_TRACE"
        ;;
      policy-remove:tavily:--yes)
        printf '%s\n' "removed" >"$POLICY_CLEANUP_STATE"
        printf '%s\n' "absent" >"$POLICY_CLEANUP_MARKER"
        printf '%s\n' "TRACE:policy-remove" >>"$POLICY_CLEANUP_TRACE"
        ;;
      *)
        printf '%s\n' "unexpected CLI action in Tavily cleanup self-test: $action" >&2
        return 92
        ;;
    esac
  }
  python_probe() {
    local python_bin="${2:-python3}"
    local state
    state="$(cat "$POLICY_CLEANUP_STATE")"
    if [ "$NEMOCLAW_E2E_TAVILY_SELF_TEST" = "policy-cleanup-on-probe-failure" ] \
      && [ "$python_bin" = "python3" ] && [ "$state" = "added" ]; then
      printf '%s\n' "TRACE:probe-failure" >>"$POLICY_CLEANUP_TRACE"
      return 23
    elif [ "$python_bin" != "python3" ]; then
      printf '%s\n' "BLOCKED:fixture non-managed Python"
    elif [ "$state" = "added" ]; then
      printf '%s\n' "REACHED:403"
    elif [ "$state" = "removed" ]; then
      printf '%s\n' "TRACE:post-remove-blocked" >>"$POLICY_CLEANUP_TRACE"
      printf '%s\n' "BLOCKED:fixture restored denial"
    else
      printf '%s\n' "ERROR:unexpected fixture policy state"
    fi
  }
  openshell() {
    case "$*" in
      *"NEMOCLAW_OBSERVABILITY=1"*"/usr/local/bin/nemoclaw-start /usr/bin/true"*)
        printf '%s\n' "1" >"$POLICY_CLEANUP_MARKER"
        printf '%s\n' "TRACE:observability-restore" >>"$POLICY_CLEANUP_TRACE"
        ;;
      *)
        printf '%s\n' "unexpected OpenShell action in Tavily cleanup self-test" >&2
        return 93
        ;;
    esac
  }
  sleep() {
    :
  }
fi

if ! sandbox_exec "test -d /sandbox/.deepagents && command -v dcode >/dev/null 2>&1" >/dev/null; then
  info "SKIP: sandbox '${SANDBOX_NAME}' is not a Deep Agents Code sandbox"
  exit 0
fi

OBSERVABILITY_MARKER_BEFORE="$(observability_marker_value || true)"

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
TAVILY_POLICY_CLEANUP_REQUIRED=1
trap cleanup_tavily_check EXIT
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

# Restore the deny-by-default posture for later checks in this ordered live
# suite. Rebuild validation intentionally preserves active policy presets, so
# leaving Tavily enabled here would make a later baseline egress check claim
# that thread auto-approval widened network access when it only retained this
# explicit opt-in.
REMOVE_OUTPUT="$(nemoclaw_cli "$SANDBOX_NAME" policy-remove tavily --yes 2>&1)" || {
  fail_test "policy-remove tavily failed: $REMOVE_OUTPUT"
  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  exit 1
}
TAVILY_POLICY_CLEANUP_REQUIRED=0
pass "tavily policy preset removes after the opt-in proof"

sleep "${NEMOCLAW_E2E_POLICY_SETTLE_SECONDS:-5}"

REMOVED_PROBE_OUTPUT="$(python_probe "https://api.tavily.com/search" || true)"
if echo "$REMOVED_PROBE_OUTPUT" | grep -q "BLOCKED:" \
  && ! echo "$REMOVED_PROBE_OUTPUT" | grep -q "REACHED:"; then
  pass "managed Deep Agents Code python is blocked again after policy-remove"
elif echo "$REMOVED_PROBE_OUTPUT" | grep -q "REACHED:"; then
  fail_test "managed Deep Agents Code python still reached Tavily after policy-remove: $REMOVED_PROBE_OUTPUT"
else
  fail_test "post-remove Tavily probe lacked denial evidence: $REMOVED_PROBE_OUTPUT"
fi

# The temporary Tavily policy belongs only to this check. OpenShell can clear
# /tmp while applying the narrower replacement policy, so restore an
# observability marker that existed before the check through the canonical
# startup helper instead of manufacturing the marker in the test.
if [ "$OBSERVABILITY_MARKER_BEFORE" = "1" ]; then
  OBSERVABILITY_MARKER_AFTER="$(observability_marker_value || true)"
  if [ "$OBSERVABILITY_MARKER_AFTER" != "1" ]; then
    RESTORE_OUTPUT="$(openshell sandbox exec --name "$SANDBOX_NAME" -- \
      /usr/bin/env NEMOCLAW_OBSERVABILITY=1 \
      /usr/local/bin/nemoclaw-start /usr/bin/true 2>&1)" \
      || fail_test "could not restore managed observability after policy-remove: $RESTORE_OUTPUT"
  fi
  OBSERVABILITY_MARKER_AFTER="$(observability_marker_value || true)"
  if [ "$OBSERVABILITY_MARKER_AFTER" = "1" ]; then
    pass "managed observability state restores after policy-remove"
  else
    fail_test "managed observability marker was not restored after policy-remove"
  fi
fi

if [ -n "$POLICY_CLEANUP_TRACE" ]; then
  cat "$POLICY_CLEANUP_TRACE"
fi
printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
