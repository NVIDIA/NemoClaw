// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const OPENCLAW_AGENT_JSON_HELPER_PY = fs.readFileSync(
  path.join(import.meta.dirname, "..", "lib", "openclaw-agent-json.py"),
  "utf-8",
);

export const ADMIN_REQUEST_SELECTOR_PY = String.raw`import json, sys
from pathlib import Path

data=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
expected_request_id=str(sys.argv[2] or '').strip()
pending=data.get('pending') or []
paired=data.get('paired') or []
allowed_scopes={'operator.pairing','operator.read','operator.write','operator.admin'}
non_admin_scopes={'operator.pairing','operator.read','operator.write'}

def norm(value): return str(value or '').strip()
def scope_view(value, key):
    if key not in value or value.get(key) is None: return None
    raw=value.get(key)
    if not isinstance(raw, list): raise SystemExit(f'{key} must be an array')
    normalized=[norm(scope) for scope in raw]
    if any(not isinstance(scope, str) or not normalized[index] for index, scope in enumerate(raw)):
        raise SystemExit(f'{key} contains an invalid scope')
    if len(normalized) != len(set(normalized)): raise SystemExit(f'{key} contains duplicate scopes')
    return set(normalized)
def scope_closure(view):
    result=set(view)
    if 'operator.admin' in result: result.update({'operator.read','operator.write'})
    if 'operator.write' in result: result.add('operator.read')
    return result
def requested_scopes(value):
    views=[view for key in ('scopes','requestedScopes') if (view := scope_view(value, key)) is not None]
    if not views: raise SystemExit('pending request has no requested scope array')
    if any(view != views[0] for view in views[1:]): raise SystemExit('pending requested scope arrays disagree')
    return views[0]
def approved_scope_views(value):
    views=[view for key in ('scopes','approvedScopes') if (view := scope_view(value, key)) is not None]
    tokens=value.get('tokens')
    if tokens is not None:
        if isinstance(tokens, list): token_entries=tokens
        elif isinstance(tokens, dict): token_entries=list(tokens.values())
        else: raise SystemExit('paired tokens must be an array or object')
        if any(not isinstance(token, dict) for token in token_entries):
            raise SystemExit('paired tokens contains an invalid token')
        active_operator_tokens=[token for token in token_entries if norm(token.get('role')) == 'operator' and not token.get('revokedAtMs')]
        if len(active_operator_tokens) != 1:
            raise SystemExit(f'paired tokens must contain exactly one active operator token, found {len(active_operator_tokens)}')
        token_view=scope_view(active_operator_tokens[0], 'scopes')
        if token_view is not None: views.append(token_view)
    if not views: raise SystemExit('paired device has no approved scope array')
    views=[scope_closure(view) for view in views]
    if any(view != views[0] for view in views[1:]): raise SystemExit('paired approved scope arrays disagree')
    return views
def roles(value):
    result=set()
    raw_roles=value.get('roles')
    if raw_roles is not None:
        if not isinstance(raw_roles, list): raise SystemExit('roles must be an array')
        for role in raw_roles:
            if not isinstance(role, str) or not norm(role): raise SystemExit('roles contains an invalid role')
            result.add(norm(role))
    raw_role=value.get('role')
    if raw_role is not None:
        if not isinstance(raw_role, str) or not norm(raw_role): raise SystemExit('role is invalid')
        result.add(norm(raw_role))
    return result
def is_cli(value):
    return value.get('clientId') in {'cli','openclaw-cli'} and value.get('clientMode') == 'cli'

if not expected_request_id:
    raise SystemExit('expected cron requestId is empty')
candidates=[request for request in pending if isinstance(request, dict) and norm(request.get('requestId')) == expected_request_id]
if len(candidates) != 1:
    raise SystemExit(f'expected the cron requestId exactly once in pending state, found {len(candidates)}')
request=candidates[0]
request_scopes=requested_scopes(request)
if not is_cli(request) or roles(request) != {'operator'}:
    raise SystemExit('cron requestId does not belong to the expected CLI operator')
if 'operator.admin' not in request_scopes or not request_scopes.issubset(allowed_scopes):
    raise SystemExit(f'cron requestId has unexpected scopes: {sorted(request_scopes)}')
device_id=norm(request.get('deviceId'))
public_key=norm(request.get('publicKey'))
matching_devices=[device for device in paired if isinstance(device, dict) and norm(device.get('deviceId')) == device_id]
if not device_id or len(matching_devices) != 1:
    raise SystemExit(f'cron requestId must match exactly one paired device, found {len(matching_devices)}')
device=matching_devices[0]
if not is_cli(device) or roles(device) != {'operator'}:
    raise SystemExit('paired device does not belong to the expected CLI operator')
if not public_key or public_key != norm(device.get('publicKey')):
    raise SystemExit('cron requestId public key does not match its paired device')
device_scope_views=approved_scope_views(device)
if any('operator.admin' in view for view in device_scope_views):
    raise SystemExit('operator.admin was already granted before explicit approval')
if any(not view.issubset(non_admin_scopes) for view in device_scope_views):
    raise SystemExit('paired device has unexpected approved scopes')
print(expected_request_id)`;

export function extractPendingRequestId(output: string): string {
  const requestIds = new Set(
    [
      ...output.matchAll(
        /\brequestId\s*[:=]\s*([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/giu,
      ),
    ].map((match) => match[1]),
  );
  if (requestIds.size !== 1) {
    throw new Error(
      `expected exactly one pending requestId in cron output, found ${requestIds.size}`,
    );
  }
  return [...requestIds][0];
}

export function adminApprovalConnectScript(
  cliPath: string,
  sandboxName: string,
  expectedRequestId: string,
  cronName: string,
  sessionId: string,
): string {
  const cli = JSON.stringify(cliPath);
  const sandbox = JSON.stringify(sandboxName);
  return [
    "set -euo pipefail",
    `cat <<'NEMOCLAW_ADMIN_APPROVAL' | ${cli} ${sandbox} connect`,
    "set -euo pipefail",
    'if [ -n "${OPENCLAW_GATEWAY_URL:-}" ]; then echo "PUBLIC_GATEWAY_URL_LEAK" >&2; exit 20; fi',
    'if [ -n "${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" ]; then echo "PUBLIC_INSECURE_WS_LEAK" >&2; exit 21; fi',
    'case "${NEMOCLAW_OPENCLAW_GATEWAY_URL:-}" in ws://*|wss://*) ;; *) echo "PRIVATE_GATEWAY_ALIAS_MISSING" >&2; exit 22 ;; esac',
    '[ -n "${OPENCLAW_GATEWAY_PORT:-}" ] || { echo "GATEWAY_PORT_MISSING" >&2; exit 23; }',
    '[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ] || { echo "GATEWAY_TOKEN_MISSING" >&2; exit 24; }',
    `expected_request_id=${JSON.stringify(expectedRequestId)}`,
    `cron_name=${JSON.stringify(cronName)}`,
    `session_id=${JSON.stringify(sessionId)}`,
    'devices_json="$(mktemp)"',
    'devices_err="$(mktemp)"',
    'approve_output="$(mktemp)"',
    'cron_output="$(mktemp)"',
    'cron_run_output="$(mktemp)"',
    'agent_stdout="$(mktemp)"',
    'agent_stderr="$(mktemp)"',
    'trap \'rm -f -- "$devices_json" "$devices_err" "$approve_output" "$cron_output" "$cron_run_output" "$agent_stdout" "$agent_stderr"\' EXIT',
    'if ! openclaw devices list --json >"$devices_json" 2>"$devices_err"; then echo "ADMIN_DEVICES_LIST_FAILED" >&2; exit 25; fi',
    'request_id="$(python3 - "$devices_json" "$expected_request_id" <<\'PY_ADMIN_REQUEST\'',
    ...ADMIN_REQUEST_SELECTOR_PY.split("\n"),
    "PY_ADMIN_REQUEST",
    ')"',
    '[ -n "$request_id" ] || { echo "ADMIN_REQUEST_ID_MISSING" >&2; exit 26; }',
    'echo "ISSUE_5324_STAGE=explicit-admin-approval"',
    'if ! openclaw devices approve "$request_id" >"$approve_output" 2>&1; then echo "ADMIN_APPROVE_FAILED" >&2; exit 27; fi',
    'if ! openclaw cron add --name "$cron_name" --every 2h --agent main --session isolated --message "hello" >"$cron_output" 2>&1; then echo "ADMIN_CRON_RETRY_FAILED" >&2; exit 28; fi',
    // OpenClaw 2026.6.10 classifies cron.add and cron.run at the same
    // operator.admin gateway-method boundary (gateway/methods/core-descriptors.ts).
    // The exact-request approval above therefore grants the scope both use.
    // The cron.run response is validated below after the final agent proof so
    // its queued workload cannot race that gateway assertion.
    'cron_id="$(python3 - "$cron_output" "$cron_name" <<\'PY_CRON_ID\'',
    "import json, sys",
    "from pathlib import Path",
    "raw=Path(sys.argv[1]).read_text(encoding='utf-8')",
    "want=sys.argv[2]",
    "decoder=json.JSONDecoder()",
    "for index, char in enumerate(raw):",
    "    if char != '{': continue",
    "    try: value,_=decoder.raw_decode(raw[index:])",
    "    except Exception: continue",
    "    cron_id=str(value.get('id') or '').strip() if isinstance(value, dict) and value.get('name') == want else ''",
    "    if cron_id: print(cron_id); raise SystemExit(0)",
    "raise SystemExit('approved cron add did not return its job id')",
    "PY_CRON_ID",
    ')"',
    '[ -n "$cron_id" ] || { echo "ADMIN_CRON_ID_MISSING" >&2; exit 28; }',
    'if ! openclaw agent --agent main --json -m "What is 6 multiplied by 7? Reply with only the integer, no extra words." --session-id "$session_id" >"$agent_stdout" 2>"$agent_stderr"; then echo "CONNECT_AGENT_FAILED" >&2; exit 29; fi',
    'if grep -Eiq \'EMBEDDED FALLBACK|gateway connect failed|scope upgrade pending approval|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded\' "$agent_stdout" "$agent_stderr"; then echo "CONNECT_AGENT_FALLBACK_OR_PAIRING" >&2; exit 30; fi',
    'agent_parser="$(mktemp)"',
    'trap \'rm -f -- "$devices_json" "$devices_err" "$approve_output" "$cron_output" "$cron_run_output" "$agent_stdout" "$agent_stderr" "$agent_parser"\' EXIT',
    "cat >\"$agent_parser\" <<'PY_OPENCLAW_AGENT_JSON_HELPER'",
    ...OPENCLAW_AGENT_JSON_HELPER_PY.split("\n"),
    "PY_OPENCLAW_AGENT_JSON_HELPER",
    'if ! agent_reply="$(python3 "$agent_parser" <"$agent_stdout")"; then echo "CONNECT_AGENT_JSON_INVALID" >&2; exit 31; fi',
    '[ "$agent_reply" = "42" ] || { echo "CONNECT_AGENT_NOT_EXACT_42" >&2; exit 32; }',
    'echo "ISSUE_5324_STAGE=cron-run job=$cron_id"',
    'if ! openclaw cron run "$cron_id" >"$cron_run_output" 2>&1; then echo "ADMIN_CRON_RUN_FAILED" >&2; exit 33; fi',
    'if ! python3 - "$cron_run_output" <<\'PY_CRON_RUN\'; then echo "ADMIN_CRON_RUN_RESULT_INVALID" >&2; exit 34; fi',
    "import json, sys",
    "from pathlib import Path",
    "raw=Path(sys.argv[1]).read_text(encoding='utf-8')",
    "decoder=json.JSONDecoder()",
    "for index, char in enumerate(raw):",
    "    if char != '{': continue",
    "    try: value,_=decoder.raw_decode(raw[index:])",
    "    except Exception: continue",
    "    if not isinstance(value, dict) or value.get('ok') is not True: continue",
    "    if value.get('ran') is True: raise SystemExit(0)",
    "    if value.get('enqueued') is True and str(value.get('runId') or '').strip(): raise SystemExit(0)",
    "raise SystemExit('cron run did not report a successful run or enqueue')",
    "PY_CRON_RUN",
    'echo "ISSUE_5324_ADMIN_APPROVAL_OK request=$request_id"',
    "exit",
    "NEMOCLAW_ADMIN_APPROVAL",
  ].join("\n");
}
