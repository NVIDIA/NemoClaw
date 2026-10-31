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
verify_cron=__NEMOCLAW_ADMIN_VERIFY_CRON__
emit_admin_diagnostic() {
  python3 - "$1" "${2:-command}" "${3:-}" <<'PY_ADMIN_DIAGNOSTIC'
import json, re, sys
from pathlib import Path
try:
    with Path(sys.argv[1]).open('rb') as stream:
        raw=stream.read(65536).decode('utf-8', errors='replace')
except FileNotFoundError: raw=''
# Emit only fixed categories, never device records, identities, tokens or traceback text.
if sys.argv[2] == 'cron-run':
    terminal_labels={
        ('error', 'failed'): 'cron-run-error',
        ('skipped', 'failed'): 'cron-run-skipped',
        ('ok', 'failed'): 'cron-completion-failed',
        ('ok', 'unknown'): 'cron-completion-unknown',
    }
    decoder=json.JSONDecoder()
    for index, char in enumerate(raw):
        if char != '{': continue
        try: value,_=decoder.raw_decode(raw[index:])
        except (ValueError, RecursionError): continue
        if not isinstance(value, dict) or value.get('ok') is not True or value.get('completed') is not True: continue
        run_id=value.get('runId')
        run=value.get('run')
        status=value.get('status')
        completion=value.get('completionStatus')
        if not isinstance(run_id, str) or not run_id.strip() or not isinstance(run, dict): continue
        if not isinstance(status, str) or not isinstance(completion, str): continue
        if run.get('jobId') != sys.argv[3] or run.get('runId') != run_id: continue
        if run.get('status') != status or run.get('completionStatus') != completion: continue
        label=terminal_labels.get((status, completion))
        if label:
            print(f'ADMIN_DIAGNOSTIC={label}', file=sys.stderr)
            # Pinned cron metadata has closed vocabularies; never export free-text errors.
            reasons=(
                'auth', 'auth_permanent', 'format', 'rate_limit', 'overloaded', 'billing',
                'server_error', 'timeout', 'tls_certificate', 'context_overflow',
                'model_not_found', 'session_expired', 'empty_response', 'no_error_details',
                'unclassified', 'unknown',
            )
            reason=run.get('errorReason')
            reason=reason if isinstance(reason, str) and reason in reasons else 'unavailable'
            print(f'ADMIN_CRON_ERROR_REASON={reason}', file=sys.stderr)
            duration=run.get('durationMs')
            # Bound the terminal runtime only; exclude booleans and arbitrary metadata.
            if type(duration) is int and 0 <= duration <= 86400000:
                print(f'ADMIN_CRON_DURATION_MS={duration}', file=sys.stderr)
            diagnostics=run.get('diagnostics')
            entries=diagnostics.get('entries') if isinstance(diagnostics, dict) else None
            sources=('cron-preflight', 'cron-setup', 'model-preflight', 'agent-run', 'tool', 'exec', 'delivery')
            # Observe fixed error-text signatures, not provider or tool causality.
            messages={
                'cron isolated agent run aborted': 'message-agent-aborted',
                'cron: job execution timed out': 'message-cron-deadline',
                # Pinned incomplete-turn texts: the reply budget ended without visible output.
                "Agent couldn't generate a response.": 'message-agent-incomplete-turn',
                "\u26a0\ufe0f Agent couldn't generate a response. Please try again.": 'message-agent-incomplete-turn',
                'LLM request timed out.': 'message-llm-timeout',
                'LLM request failed.': 'message-llm-failed',
                'LLM request failed with an unknown error.': 'message-llm-unknown',
                'LLM request failed: provider returned an internal error.': 'message-llm-provider-internal',
                'The selected model was not found by the provider. Check the model id or choose a different model.': 'message-model-not-found',
                'Code Mode could not resolve a configured MCP tool.': 'message-code-mode-catalog-miss',
            }
            http_signatures={str(code): f'error-text-http-{code}' for code in range(400, 600)}
            # Anchored subset of the pinned assistant-error-format HTTP grammar.
            http_patterns=(
                r'\u26a0\ufe0f [A-Za-z0-9_./:-]+ request failed \(provider internal error, HTTP ([45][0-9]{2})\)\. This is usually temporary \u2014 try again shortly\.',
                r'(?:http\s*)?([45][0-9]{2})(?:(?:\s*:\s*|\s+)[\s\S]+)?',
                r'api\s*error\s*\(([45][0-9]{2})\)(?:\s*:\s*[\s\S]*)?',
                r'(?:status code|unexpected status|http status)\s*[:=]?\s*([45][0-9]{2})\b(?:\s*[:,]?\s*(?:message\s*:\s*)?[\s\S]*)?',
            )
            def error_signature(message):
                if not isinstance(message, str): return None
                if message in messages: return messages[message]
                text=re.sub(r'^error\s*[:,]\s*', '', message.strip(), count=1, flags=re.IGNORECASE | re.ASCII)
                for pattern in http_patterns:
                    match=re.fullmatch(pattern, text, flags=re.IGNORECASE | re.ASCII)
                    if match: return http_signatures.get(match[1])
                return None
            signature=error_signature(run.get('error'))
            signatures=[f'run:{signature}'] if signature else []
            pairs=[]
            for entry in entries[:10] if isinstance(entries, list) else []:
                if not isinstance(entry, dict): continue
                source=entry.get('source')
                severity=entry.get('severity')
                if not isinstance(source, str) or source not in sources: continue
                if not isinstance(severity, str) or severity not in ('info', 'warn', 'error'): continue
                pair=f'{source}:{severity}'
                if pair not in pairs: pairs.append(pair)
                signature=error_signature(entry.get('message')) if severity == 'error' else None
                if signature:
                    observation=f'{source}:{signature}'
                    if observation not in signatures: signatures.append(observation)
            print('ADMIN_CRON_DIAGNOSTIC_SOURCES=' + (','.join(pairs) or 'unavailable'), file=sys.stderr)
            print('ADMIN_CRON_ERROR_SIGNATURES=' + (','.join(signatures) or 'unavailable'), file=sys.stderr)
            raise SystemExit(0)
selection_checks=(
    ('selection-state-busy', r'OpenClawPairingStateRetryableError: canonical pairing-state database is busy'),
    ('selection-state-changed', r'OpenClawPairingStateRetryableError: canonical pairing-state .*changed'),
    ('selection-state-wal-incomplete', r'OpenClawPairingStateRetryableError: canonical pairing-state WAL is missing its shared-memory sidecar'),
    ('selection-state-unvalidated', r'OpenClawPairingStateRetryableError: SQLite reopened an unvalidated pairing-state file identity'),
    ('selection-state-unsafe', r'OSError: unsafe canonical pairing-state'),
    ('selection-state-missing', r'FileNotFoundError:'),
    ('selection-state-permission', r'PermissionError:'),
    ('selection-state-schema', r'ValueError: unsupported canonical device state schema'),
    ('selection-state-read', r'canonical pairing-state|canonical device state|canonical primary device identity|FileNotFoundError|PermissionError|sqlite3\.'),
    ('selection-local-identity', r'local CLI identity'),
    ('selection-pending-count', r'expected exactly one pending request, found [0-9]+'),
    ('selection-request-binding', r'pending admin request (?:has an invalid requestId|does not match the triggered request)'),
    ('selection-paired-binding', r'paired device does not belong to the expected CLI operator|cron requestId (?:must match exactly one paired device|public key does not match its paired device)'),
    ('selection-client-role', r'does not belong to the expected CLI operator|roles? (?:must be|contains|is invalid)'),
    ('selection-scopes', r'operator\.admin was already granted before explicit approval|scopes?|paired tokens'),
    ('selection-response', r'device state must be an object|records must be an array of objects|JSONDecodeError'),
)
checks=(
    ('approval-state-mismatch', r'local fallback pairing state does not contain the gateway request'),
    ('approval-context-rejected', r'forced pairing (?:pinned|state descriptor)|bounded same-device approval context changed'),
    ('approval-not-pending', r'No pending device request matches'),
    ('self-approval-rejected', r"This device can't approve its own scope upgrade"),
    ('approval-token-handoff-failed', r'Admin approval completed, but its token handoff'),
    ('cron-wait-timeout', r'timed out waiting for cron run '),
    ('timeout', r'timed?\s*out|timeout'),
    ('pairing-required', r'device pairing|required.*pairing|pairing required'),
    ('authorization-rejected', r'denied|forbidden|unauthorized|approval.*(?:failed|rejected)'),
    ('scope-upgrade-pending', r'scope upgrade pending'),
    ('gateway-unavailable', r'gateway|connection|econn|socket|network'),
    ('invalid-response', r'invalid|parse|json'),
)
if sys.argv[2] == 'selection': checks=selection_checks + checks
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
  emit_admin_diagnostic "$selector_err" selection
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
# Feature tests verify the approved scope through their own native operation.
# Avoid an unrelated cron job and agent session in those scenarios.
if [ "$verify_cron" = 0 ]; then
  echo "ISSUE_5324_ADMIN_APPROVAL_OK"
  exit
fi
# An explicit task keeps the unattended cron turn within the model's reply budget.
if ! run_with_bounded_output "$cron_output" openclaw cron add --name "$cron_name" --every 2h --agent main --session isolated --message "Respond with a short greeting." --no-deliver; then
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
# Keep the completion wait inside the caller's four-minute approval budget.
if ! run_with_bounded_output "$cron_run_output" openclaw cron run "$cron_id" --wait --wait-timeout 2m --timeout 10000; then
  echo "ADMIN_CRON_RUN_FAILED" >&2
  emit_admin_diagnostic "$cron_run_output" cron-run "$cron_id" || echo "ADMIN_DIAGNOSTIC=unavailable" >&2
  exit 29
fi
if ! python3 - "$cron_run_output" "$cron_id" <<'PY_CRON_RUN'; then
import json, sys
from pathlib import Path
raw=Path(sys.argv[1]).read_text(encoding='utf-8')
decoder=json.JSONDecoder()
for index, char in enumerate(raw):
    if char != '{': continue
    try: value,_=decoder.raw_decode(raw[index:])
    except Exception: continue
    if not isinstance(value, dict) or value.get('ok') is not True: continue
    run_id=value.get('runId')
    run=value.get('run')
    if not isinstance(run_id, str) or not run_id.strip() or not isinstance(run, dict): continue
    if (
        value.get('completed') is True
        and value.get('status') == 'ok'
        and value.get('completionStatus') == 'succeeded'
        and run.get('status') == 'ok'
        and run.get('completionStatus') == 'succeeded'
        and run.get('jobId') == sys.argv[2]
        and run.get('runId') == run_id
    ): raise SystemExit(0)
raise SystemExit('cron run did not report successful completion for its job and run')
PY_CRON_RUN
  echo "ADMIN_CRON_RUN_RESULT_INVALID" >&2
  exit 30
fi
echo "ISSUE_5324_ADMIN_APPROVAL_OK"
exit
