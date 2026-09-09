// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ISSUE_4462_SCOPE_UPGRADE_PHASES = [
  "confirm configured runtime availability and clear the scope-upgrade sandbox",
  "install the OpenClaw sandbox",
  "prove onboarding settled operator.write and the first agent turn used the gateway",
  "trigger and approve an operator.admin request through connect",
  "record the approval contract",
] as const;

export type PreApprovalAdminProbeOutcome =
  | "approval-required"
  | "command-failed"
  | "gateway-unavailable"
  | "timeout"
  | "unexpected-success";

interface PreApprovalAdminProbeResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export function preApprovalAdminProbeEvidence(result: PreApprovalAdminProbeResult): {
  outcome: PreApprovalAdminProbeOutcome;
} {
  if (result.timedOut) return { outcome: "timeout" };
  if (result.exitCode === 0) return { outcome: "unexpected-success" };

  const output = `${result.stdout}\n${result.stderr}`;
  if (
    /operator\.admin|scope upgrade pending approval|device pairing required|pairing required/i.test(
      output,
    )
  ) {
    return { outcome: "approval-required" };
  }
  if (
    /gateway (?:connection )?(?:unavailable|unreachable)|econn(?:refused|reset)|connection refused|network unreachable|socket (?:closed|unavailable)/i.test(
      output,
    )
  ) {
    return { outcome: "gateway-unavailable" };
  }
  return { outcome: "command-failed" };
}

export const ADMIN_REQUEST_SELECTOR_PY = String.raw`import base64, hashlib, json, os, re, sys
from pathlib import Path

data=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
request_id_path=Path(sys.argv[2])
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
def identity_public_key(value):
    direct=norm(value.get('publicKey'))
    if direct: return direct
    pem=norm(value.get('publicKeyPem'))
    if not pem: return ''
    body=''.join(line.strip() for line in pem.splitlines() if not line.startswith('-----'))
    try: der=base64.b64decode(body, validate=True)
    except Exception: return ''
    prefix=bytes.fromhex('302a300506032b6570032100')
    if len(der) != len(prefix) + 32 or not der.startswith(prefix): return ''
    return base64.urlsafe_b64encode(der[len(prefix):]).decode('ascii').rstrip('=')

identity_path=Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw') / 'identity' / 'device.json'
try: identity=json.loads(identity_path.read_text(encoding='utf-8'))
except (FileNotFoundError, json.JSONDecodeError): raise SystemExit('local CLI identity is missing or invalid')
if not isinstance(identity, dict): raise SystemExit('local CLI identity must be an object')
identity_device_id=norm(identity.get('deviceId'))
identity_key=identity_public_key(identity)
try: identity_key_raw=base64.urlsafe_b64decode(identity_key + '=' * (-len(identity_key) % 4))
except Exception: raise SystemExit('local CLI identity public key is invalid')
if (not identity_device_id or len(identity_key_raw) != 32
        or hashlib.sha256(identity_key_raw).hexdigest() != identity_device_id):
    raise SystemExit('local CLI identity binding is invalid')

request_entries=[request for request in pending if isinstance(request, dict)]
if len(request_entries) != 1:
    raise SystemExit(f'expected exactly one pending request, found {len(request_entries)}')
request=request_entries[0]
request_id=norm(request.get('requestId'))
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', request_id, re.IGNORECASE):
    raise SystemExit('pending admin request has an invalid requestId')
request_scopes=requested_scopes(request)
if not is_cli(request) or roles(request) != {'operator'}:
    raise SystemExit('cron requestId does not belong to the expected CLI operator')
if 'operator.admin' not in request_scopes or not request_scopes.issubset(allowed_scopes):
    raise SystemExit(f'cron requestId has unexpected scopes: {sorted(request_scopes)}')
device_id=norm(request.get('deviceId'))
public_key=norm(request.get('publicKey'))
if device_id != identity_device_id or public_key != identity_key:
    raise SystemExit('pending admin request does not match the local CLI identity')
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
request_id_path.write_text(request_id, encoding='utf-8')`;

export function adminApprovalConnectScript(
  cliPath: string,
  sandboxName: string,
  cronName: string,
): string {
  const cli = JSON.stringify(cliPath);
  const sandbox = JSON.stringify(sandboxName);
  return [
    "set -euo pipefail",
    `cat <<'NEMOCLAW_ADMIN_APPROVAL' | ${cli} ${sandbox} connect`,
    "set -euo pipefail",
    'if [ -n "${OPENCLAW_GATEWAY_URL:-}" ]; then echo "PUBLIC_GATEWAY_URL_LEAK" >&2; exit 20; fi',
    'if [ -n "${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" ]; then echo "PUBLIC_INSECURE_WS_LEAK" >&2; exit 21; fi',
    'if ! python3 - "${NEMOCLAW_OPENCLAW_GATEWAY_URL:-}" "${NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" <<\'PY_PRIVATE_GATEWAY\'; then echo "PRIVATE_GATEWAY_ALIAS_REJECTED" >&2; exit 22; fi',
    "import ipaddress, sys, urllib.parse",
    "url=sys.argv[1]",
    "insecure_private_ws=sys.argv[2]",
    "try:",
    "    parsed=urllib.parse.urlsplit(url)",
    "    host=parsed.hostname",
    "    port=parsed.port",
    "except ValueError:",
    "    raise SystemExit('gateway alias is malformed')",
    "if parsed.scheme not in {'ws','wss'} or not host or port is None:",
    "    raise SystemExit('gateway alias must be an explicit WebSocket origin')",
    "if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'','/'}:",
    "    raise SystemExit('gateway alias must not contain credentials, a path, a query, or a fragment')",
    "loopback=host == 'localhost' or host == '127.0.0.1'",
    "private=False",
    "try:",
    "    address=ipaddress.ip_address(host)",
    "    private=any(address in network for network in (",
    "        ipaddress.ip_network('10.0.0.0/8'),",
    "        ipaddress.ip_network('172.16.0.0/12'),",
    "        ipaddress.ip_network('192.168.0.0/16'),",
    "    ))",
    "except ValueError:",
    "    pass",
    "if not loopback and not private:",
    "    raise SystemExit('gateway alias is not loopback or RFC1918 private')",
    "if parsed.scheme == 'ws' and not loopback and insecure_private_ws != '1':",
    "    raise SystemExit('private ws gateway alias is missing its trusted marker')",
    "PY_PRIVATE_GATEWAY",
    '[ -n "${OPENCLAW_GATEWAY_PORT:-}" ] || { echo "GATEWAY_PORT_MISSING" >&2; exit 23; }',
    '[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ] || { echo "GATEWAY_TOKEN_MISSING" >&2; exit 24; }',
    `cron_name=${JSON.stringify(cronName)}`,
    "emit_admin_diagnostic() {",
    "python3 - \"$1\" <<'PY_ADMIN_DIAGNOSTIC'",
    "import re, sys",
    "from pathlib import Path",
    "try: raw=Path(sys.argv[1]).read_text(encoding='utf-8', errors='replace')[:65536]",
    "except FileNotFoundError: raw=''",
    "checks=(",
    "    ('timeout', r'timed?\\s*out|timeout'),",
    "    ('pairing-required', r'device pairing|required.*pairing|pairing required'),",
    "    ('scope-upgrade-pending', r'scope upgrade pending|operator\\.admin'),",
    "    ('authorization-rejected', r'denied|forbidden|unauthorized|approval.*(?:failed|rejected)'),",
    "    ('gateway-unavailable', r'gateway|connection|econn|socket|network'),",
    "    ('invalid-response', r'invalid|parse|json'),",
    ")",
    "label=next((name for name, pattern in checks if re.search(pattern, raw, re.IGNORECASE)), 'command-failed' if raw.strip() else 'no-output')",
    "print(f'ADMIN_DIAGNOSTIC={label}', file=sys.stderr)",
    "PY_ADMIN_DIAGNOSTIC",
    "}",
    'devices_json="$(mktemp)"',
    'devices_err="$(mktemp)"',
    'selector_err="$(mktemp)"',
    'request_id_file="$(mktemp)"',
    'approve_output="$(mktemp)"',
    'cron_output="$(mktemp)"',
    'cron_id_file="$(mktemp)"',
    'cron_run_output="$(mktemp)"',
    'trap \'rm -f -- "$devices_json" "$devices_err" "$selector_err" "$request_id_file" "$approve_output" "$cron_output" "$cron_id_file" "$cron_run_output"\' EXIT',
    'if ! openclaw devices list --json >"$devices_json" 2>"$devices_err"; then echo "ADMIN_DEVICES_LIST_FAILED" >&2; emit_admin_diagnostic "$devices_err"; exit 25; fi',
    'if ! python3 - "$devices_json" "$request_id_file" 2>"$selector_err" <<\'PY_ADMIN_REQUEST\'; then echo "ADMIN_REQUEST_SELECTION_FAILED" >&2; emit_admin_diagnostic "$selector_err"; exit 26; fi',
    ...ADMIN_REQUEST_SELECTOR_PY.split("\n"),
    "PY_ADMIN_REQUEST",
    'request_id="$(cat "$request_id_file")"',
    '[ -n "$request_id" ] || { echo "ADMIN_REQUEST_ID_MISSING" >&2; exit 26; }',
    'echo "ISSUE_5324_STAGE=explicit-admin-approval"',
    'if ! openclaw devices approve "$request_id" >"$approve_output" 2>&1; then echo "ADMIN_APPROVE_FAILED" >&2; emit_admin_diagnostic "$approve_output"; exit 27; fi',
    'if ! openclaw cron add --name "$cron_name" --every 2h --agent main --session isolated --message "hello" >"$cron_output" 2>&1; then echo "ADMIN_CRON_RETRY_FAILED" >&2; emit_admin_diagnostic "$cron_output"; exit 28; fi',
    // OpenClaw 2026.6.10 and 2026.7.1 classify cron.add and cron.run at the same
    // operator.admin gateway-method boundary (gateway/methods/core-descriptors.ts).
    // The exact-request approval above therefore grants the scope both use.
    // The cron.run response below proves that the approved scope applies to
    // both methods.
    'if ! python3 - "$cron_output" "$cron_name" "$cron_id_file" <<\'PY_CRON_ID\'; then echo "ADMIN_CRON_ID_MISSING" >&2; exit 28; fi',
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
    "    if cron_id: Path(sys.argv[3]).write_text(cron_id, encoding='utf-8'); raise SystemExit(0)",
    "raise SystemExit('approved cron add did not return its job id')",
    "PY_CRON_ID",
    'cron_id="$(cat "$cron_id_file")"',
    '[ -n "$cron_id" ] || { echo "ADMIN_CRON_ID_MISSING" >&2; exit 28; }',
    'echo "ISSUE_5324_STAGE=cron-run"',
    'if ! openclaw cron run "$cron_id" >"$cron_run_output" 2>&1; then echo "ADMIN_CRON_RUN_FAILED" >&2; emit_admin_diagnostic "$cron_run_output"; exit 29; fi',
    'if ! python3 - "$cron_run_output" <<\'PY_CRON_RUN\'; then echo "ADMIN_CRON_RUN_RESULT_INVALID" >&2; exit 30; fi',
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
    'echo "ISSUE_5324_ADMIN_APPROVAL_OK"',
    "exit",
    "NEMOCLAW_ADMIN_APPROVAL",
  ].join("\n");
}
