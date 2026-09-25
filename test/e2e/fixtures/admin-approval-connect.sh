# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

set -euo pipefail
if [ -n "${OPENCLAW_GATEWAY_URL:-}" ]; then
  echo "PUBLIC_GATEWAY_URL_LEAK" >&2
  exit 20
fi
if [ -n "${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" ]; then
  echo "PUBLIC_INSECURE_WS_LEAK" >&2
  exit 21
fi
if [ -n "${NEMOCLAW_OPENCLAW_GATEWAY_URL:-}${NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" ]; then
  echo "PRIVATE_GATEWAY_ALIAS_LEAK" >&2
  exit 22
fi
[ -n "${OPENCLAW_GATEWAY_PORT:-}" ] || {
  echo "GATEWAY_PORT_MISSING" >&2
  exit 23
}
[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ] || {
  echo "GATEWAY_TOKEN_MISSING" >&2
  exit 24
}
cron_name=__NEMOCLAW_ADMIN_CRON_NAME__
expected_request_id=__NEMOCLAW_ADMIN_EXPECTED_REQUEST_ID__
emit_admin_diagnostic() {
  python3 - "$1" <<'PY_ADMIN_DIAGNOSTIC'
import re, sys
from pathlib import Path
try:
    with Path(sys.argv[1]).open('rb') as stream:
        raw=stream.read(65536).decode('utf-8', errors='replace')
except FileNotFoundError: raw=''
checks=(
    ('timeout', r'timed?\s*out|timeout'),
    ('pairing-required', r'device pairing|required.*pairing|pairing required'),
    ('scope-upgrade-pending', r'scope upgrade pending|operator\.admin'),
    ('authorization-rejected', r'denied|forbidden|unauthorized|approval.*(?:failed|rejected)'),
    ('gateway-unavailable', r'gateway|connection|econn|socket|network'),
    ('invalid-response', r'invalid|parse|json'),
)
label=next((name for name, pattern in checks if re.search(pattern, raw, re.IGNORECASE)), 'command-failed' if raw.strip() else 'no-output')
print(f'ADMIN_DIAGNOSTIC={label}', file=sys.stderr)
PY_ADMIN_DIAGNOSTIC
}
run_with_bounded_output() {
  local output_path="$1"
  local -a command_status
  shift
  set +e
  "$@" 2>&1 | python3 -c '
import sys

remaining = 65536
while True:
    chunk = sys.stdin.buffer.read(65536)
    if not chunk:
        break
    if remaining:
        kept = chunk[:remaining]
        sys.stdout.buffer.write(kept)
        remaining -= len(kept)
' >"$output_path"
  command_status=("${PIPESTATUS[@]}")
  set -e
  if [ "${command_status[0]}" -ne 0 ]; then
    return "${command_status[0]}"
  fi
  return "${command_status[1]}"
}
devices_json="$(mktemp)"
devices_err="$(mktemp)"
selector_err="$(mktemp)"
request_id_file="$(mktemp)"
approve_output="$(mktemp)"
cron_output="$(mktemp)"
cron_id_file="$(mktemp)"
cron_run_output="$(mktemp)"
trap 'rm -f -- "$devices_json" "$devices_err" "$selector_err" "$request_id_file" "$approve_output" "$cron_output" "$cron_id_file" "$cron_run_output"' EXIT
if ! openclaw devices list --json >"$devices_json" 2>"$devices_err"; then
  echo "ADMIN_DEVICES_LIST_FAILED" >&2
  emit_admin_diagnostic "$devices_err"
  exit 25
fi
if ! python3 - "$devices_json" "$request_id_file" "$expected_request_id" 2>"$selector_err" <<'PY_ADMIN_REQUEST'; then
__NEMOCLAW_ADMIN_REQUEST_SELECTOR_PY__
PY_ADMIN_REQUEST
  echo "ADMIN_REQUEST_SELECTION_FAILED" >&2
  emit_admin_diagnostic "$selector_err"
  exit 26
fi
request_id="$(cat "$request_id_file")"
[ -n "$request_id" ] || {
  echo "ADMIN_REQUEST_ID_MISSING" >&2
  exit 26
}
echo "ISSUE_5324_STAGE=explicit-admin-approval"
if ! run_with_bounded_output "$approve_output" openclaw devices approve "$request_id"; then
  echo "ADMIN_APPROVE_FAILED" >&2
  emit_admin_diagnostic "$approve_output"
  exit 27
fi
if ! run_with_bounded_output "$cron_output" openclaw cron add --name "$cron_name" --every 2h --agent main --session isolated --message "hello"; then
  echo "ADMIN_CRON_RETRY_FAILED" >&2
  emit_admin_diagnostic "$cron_output"
  exit 28
fi
# The exact-request approval above must make operator.admin usable by the
# current managed OpenClaw runtime. A successful cron.run for the returned
# job proves the approved scope is usable after cron.add.
if ! python3 - "$cron_output" "$cron_name" "$cron_id_file" <<'PY_CRON_ID'; then
import json, sys
from pathlib import Path
raw=Path(sys.argv[1]).read_text(encoding='utf-8')
want=sys.argv[2]
decoder=json.JSONDecoder()
for index, char in enumerate(raw):
    if char != '{': continue
    try: value,_=decoder.raw_decode(raw[index:])
    except Exception: continue
    cron_id=str(value.get('id') or '').strip() if isinstance(value, dict) and value.get('name') == want else ''
    if cron_id: Path(sys.argv[3]).write_text(cron_id, encoding='utf-8'); raise SystemExit(0)
raise SystemExit('approved cron add did not return its job id')
PY_CRON_ID
  echo "ADMIN_CRON_ID_MISSING" >&2
  exit 28
fi
cron_id="$(cat "$cron_id_file")"
[ -n "$cron_id" ] || {
  echo "ADMIN_CRON_ID_MISSING" >&2
  exit 28
}
echo "ISSUE_5324_STAGE=cron-run"
if ! run_with_bounded_output "$cron_run_output" openclaw cron run "$cron_id"; then
  echo "ADMIN_CRON_RUN_FAILED" >&2
  emit_admin_diagnostic "$cron_run_output"
  exit 29
fi
if ! python3 - "$cron_run_output" <<'PY_CRON_RUN'; then
import json, sys
from pathlib import Path
raw=Path(sys.argv[1]).read_text(encoding='utf-8')
decoder=json.JSONDecoder()
for index, char in enumerate(raw):
    if char != '{': continue
    try: value,_=decoder.raw_decode(raw[index:])
    except Exception: continue
    if not isinstance(value, dict) or value.get('ok') is not True: continue
    if value.get('ran') is True: raise SystemExit(0)
    if value.get('enqueued') is True and str(value.get('runId') or '').strip(): raise SystemExit(0)
raise SystemExit('cron run did not report a successful run or enqueue')
PY_CRON_RUN
  echo "ADMIN_CRON_RUN_RESULT_INVALID" >&2
  exit 30
fi
echo "ISSUE_5324_ADMIN_APPROVAL_OK"
exit
