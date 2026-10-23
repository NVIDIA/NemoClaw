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
import os
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


print(f'PROBE_PID:{os.getpid()}', flush=True)
url = sys.argv[1]
# OpenShell replaces this placeholder at egress; the sandbox never receives the key.
payload = {'query': 'nemoclaw reachability probe', 'max_results': 1, 'api_key': 'openshell-placeholder'}
request = urllib.request.Request(
    url,
    data=json.dumps(payload).encode('utf-8'),
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
        print('BLOCKED:HTTPError')
    else:
        print(f'REACHED:{exc.code}')
except urllib.error.URLError as exc:
    details = str(exc.reason if getattr(exc, 'reason', None) is not None else exc)
    if is_policy_denial(details):
        print('BLOCKED:URLError')
    else:
        print('ERROR:URLError')
except OSError as exc:
    details = str(exc)
    if is_policy_denial(details):
        print(f'BLOCKED:{type(exc).__name__}')
    else:
        print(f'ERROR:{type(exc).__name__}')
except Exception as exc:
    print(f'ERROR:{type(exc).__name__}')
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

tavily_audit_logs() {
  local phase="$1"
  if [ "$phase" = "before" ] && [ -n "${NEMOCLAW_E2E_TAVILY_AUDIT_BEFORE_FIXTURE+x}" ]; then
    printf '%s\n' "$NEMOCLAW_E2E_TAVILY_AUDIT_BEFORE_FIXTURE"
  elif [ -n "${NEMOCLAW_E2E_TAVILY_AUDIT_FIXTURE+x}" ]; then
    printf '%s\n' "$NEMOCLAW_E2E_TAVILY_AUDIT_FIXTURE"
  else
    openshell logs "$SANDBOX_NAME" -n 500 --source all --since 2m 2>/dev/null
  fi
}

tavily_audit_cursor() {
  local output
  output="$(tavily_audit_logs before)" || return 1
  printf '%s\n' "$output" | awk '
    /^\[[0-9]+(\.[0-9]+)?\]/ {
      ts = substr($0, 2, index($0, "]") - 2) + 0;
      if (ts > cursor) cursor = ts;
    }
    END { printf "%.9f\n", cursor }
  '
}

tavily_denied_audit() {
  local cursor="$1" probe_pid="$2" output
  [[ "$probe_pid" =~ ^[0-9]+$ ]] || return 1
  output="$(tavily_audit_logs after)" || return 1
  printf '%s\n' "$output" | awk -v cursor="$cursor" -v pid="$probe_pid" '
    /^\[[0-9]+(\.[0-9]+)?\]/ {
      ts = substr($0, 2, index($0, "]") - 2) + 0;
      actor = "python3[^ ()]*\\(" pid "\\)";
      if (ts > cursor && /NET:OPEN/ && / DENIED / &&
          $0 ~ actor && / -> api[.]tavily[.]com:443([\/ ]|$)/) found = 1;
    }
    END { exit !found }
  '
}

AUDIT_SETTING_BEFORE=""
TAVILY_PROVIDER=""

capture_audit_setting() {
  openshell settings get "$SANDBOX_NAME" --json | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const settings = JSON.parse(input).settings;
  if (!settings || typeof settings !== "object") process.exit(1);
  const value = settings.ocsf_json_enabled;
  if (value !== undefined && !["<unset>", "true", "false"].includes(value)) process.exit(1);
  process.stdout.write(value ?? "<unset>");
});'
}

restore_audit_setting() {
  [ -n "$AUDIT_SETTING_BEFORE" ] || return 0
  if [ "$AUDIT_SETTING_BEFORE" = "<unset>" ]; then
    openshell settings delete "$SANDBOX_NAME" --key ocsf_json_enabled --yes >/dev/null 2>&1 || return 1
  else
    openshell settings set "$SANDBOX_NAME" --key ocsf_json_enabled --value "$AUDIT_SETTING_BEFORE" >/dev/null 2>&1 || return 1
  fi
  [ "$(capture_audit_setting)" = "$AUDIT_SETTING_BEFORE" ]
}

cleanup_tavily_check() {
  local status=0
  restore_tavily_denial || status=1
  if [ -n "$TAVILY_PROVIDER" ]; then
    if ! nemoclaw_cli credentials reset "$TAVILY_PROVIDER" --yes >/dev/null 2>&1; then
      fail_test "could not remove disposable Tavily provider"
      status=1
    fi
  fi
  if ! restore_audit_setting; then
    fail_test "could not restore the prior Tavily audit setting"
    status=1
  fi
  return "$status"
}

restore_tavily_denial() {
  local cleanup_status=0 remove_output post_remove_probe_output audit_start=0 probe_pid
  if ! remove_output="$(nemoclaw_cli "$SANDBOX_NAME" policy-remove tavily --yes 2>&1)"; then
    fail_test "policy-remove tavily failed after the opt-in proof: $remove_output"
    cleanup_status=1
  else
    sleep "${NEMOCLAW_E2E_POLICY_SETTLE_SECONDS:-5}"
    if [ "${NEMOCLAW_E2E_TAVILY_AUTHENTICATED:-0}" = "1" ]; then
      if ! audit_start="$(tavily_audit_cursor)"; then
        fail_test "could not capture the Tavily audit cursor"
        return 1
      fi
    fi
    post_remove_probe_output="$(python_probe "https://api.tavily.com/search" || true)"
    if [[ "$post_remove_probe_output" == *"BLOCKED:"* &&
      "$post_remove_probe_output" != *"REACHED:"* ]]; then
      pass "managed Deep Agents Code python returns to the default Tavily denial"
      if [ "${NEMOCLAW_E2E_TAVILY_AUTHENTICATED:-0}" = "1" ]; then
        probe_pid="$(printf '%s\n' "$post_remove_probe_output" | sed -n 's/^PROBE_PID:\([0-9][0-9]*\)$/\1/p')"
        if tavily_denied_audit "$audit_start" "$probe_pid"; then
          pass "post-removal Tavily request has DENIED audit evidence"
        else
          fail_test "post-removal Tavily DENIED audit evidence is missing"
          cleanup_status=1
        fi
      fi
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

if [ "${NEMOCLAW_E2E_TAVILY_SELF_TEST:-}" = "audit-cleanup" ]; then
  AUDIT_FIXTURE="$(mktemp)"
  printf '%s' "${NEMOCLAW_E2E_AUDIT_BEFORE:-<unset>}" >"$AUDIT_FIXTURE"
  trap 'rm -f "$AUDIT_FIXTURE"' EXIT
  AUDIT_RESTORING=0
  openshell() {
    if [ "$AUDIT_RESTORING" = "1" ] && [ "${NEMOCLAW_E2E_AUDIT_RESTORE_FIXTURE:-ok}" = "fail" ]; then
      return 1
    fi
    case "$2" in
      get) printf '{"settings":{"ocsf_json_enabled":"%s"}}' "$(cat "$AUDIT_FIXTURE")" ;;
      set) printf '%s' "$7" >"$AUDIT_FIXTURE" ;;
      delete) printf '%s' '<unset>' >"$AUDIT_FIXTURE" ;;
      *) return 1 ;;
    esac
  }
  AUDIT_SETTING_BEFORE="$(capture_audit_setting)"
  openshell settings set "$SANDBOX_NAME" --key ocsf_json_enabled --value true
  AUDIT_RESTORING=1
  restore_tavily_denial() { return "${NEMOCLAW_E2E_REMOVE_STATUS:-0}"; }
  cleanup_status=0
  cleanup_tavily_check || cleanup_status=1
  printf 'RESTORED:%s\n' "$(cat "$AUDIT_FIXTURE")"
  exit "$cleanup_status"
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

trap 'cleanup_tavily_check || exit 1' EXIT
if [ "${NEMOCLAW_E2E_TAVILY_AUTHENTICATED:-0}" = "1" ]; then
  if [ -z "${TAVILY_API_KEY:-}" ]; then
    fail_test "authenticated Tavily check requires the host credential"
    exit 1
  fi
  AUDIT_SETTING_BEFORE="$(capture_audit_setting)" || {
    fail_test "could not capture the prior Tavily audit setting"
    exit 1
  }
  if ! openshell settings set "$SANDBOX_NAME" --key ocsf_json_enabled --value true >/dev/null 2>&1; then
    fail_test "could not enable Tavily audit evidence"
    exit 1
  fi
  TAVILY_PROVIDER="e2e-tavily-$(node -p 'require("node:crypto").randomUUID()')"
  if ! nemoclaw_cli credentials add "$TAVILY_PROVIDER" --type tavily --agent dcode --credential TAVILY_API_KEY >/dev/null 2>&1; then
    fail_test "could not register disposable Tavily provider"
    exit 1
  fi
  unset TAVILY_API_KEY
  if ! openshell sandbox provider attach "$SANDBOX_NAME" "$TAVILY_PROVIDER" >/dev/null 2>&1; then
    fail_test "could not attach disposable Tavily provider"
    exit 1
  fi
fi

APPLY_OUTPUT="$(nemoclaw_cli "$SANDBOX_NAME" policy-add tavily --yes 2>&1)" || {
  fail_test "policy-add tavily failed: $APPLY_OUTPUT"
  printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
  exit 1
}
pass "tavily policy preset applies"

sleep "${NEMOCLAW_E2E_POLICY_SETTLE_SECONDS:-5}"

PROBE_OUTPUT="$(python_probe "https://api.tavily.com/search")"
if [ "${NEMOCLAW_E2E_TAVILY_AUTHENTICATED:-0}" = "1" ] \
  && ! echo "$PROBE_OUTPUT" | grep -Fxq "REACHED:200"; then
  fail_test "authenticated Tavily request did not succeed after policy-add"
elif echo "$PROBE_OUTPUT" | grep -q "REACHED:"; then
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
cleanup_tavily_check || true
trap - EXIT

printf '%s\n' "${PREFIX}: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
