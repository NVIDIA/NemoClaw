// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-issue-4462";
const LIVE_TIMEOUT_MS = 70 * 60_000;
const liveTest = shouldRunLiveE2E() ? test : test.skip;

validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "30",
    NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS: "3",
    NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "10",
    NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "600",
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function cleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await host
    .command(
      process.execPath,
      [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"],
      {
        artifactName: "cleanup-nemoclaw-destroy",
        env: env(),
        timeoutMs: 120_000,
      },
    )
    .catch(() => undefined);
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "remove", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
}

function scopeUpgradeScript(): string {
  return String.raw`
set -euo pipefail
if [ ! -r /tmp/nemoclaw-proxy-env.sh ]; then
  echo "MISSING_PROXY_ENV" >&2
  exit 2
fi
if ! grep -F "unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN; command openclaw" /tmp/nemoclaw-proxy-env.sh >/dev/null; then
  echo "MISSING_APPROVE_GUARD" >&2
  exit 3
fi
. /tmp/nemoclaw-proxy-env.sh
case "\${OPENCLAW_GATEWAY_URL:-}" in
  ws://127.0.0.1:*|ws://localhost:*) ;;
  ws://10.*:*|ws://192.168.*:*|ws://172.1[6-9].*:*|ws://172.2[0-9].*:*|ws://172.3[0-1].*:*)
    if [ "\${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" != "1" ]; then
      echo "MISSING_INSECURE_PRIVATE_WS_MARKER=\${OPENCLAW_GATEWAY_URL:-unset}" >&2
      exit 4
    fi
    ;;
  *) echo "BAD_GATEWAY_URL=\${OPENCLAW_GATEWAY_URL:-unset}" >&2; exit 4 ;;
esac
seed_token_proof=/tmp/issue4462-seed-token.sha256
trap 'rm -f -- "$seed_token_proof"' EXIT

state_json() {
python3 - <<'PY'
import json, os
from pathlib import Path
root = Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw') / 'devices'
def load(name):
    try:
        value = json.loads((root / name).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    return value if isinstance(value, dict) else {}
print(json.dumps({'pending': list(load('pending.json').values()), 'paired': list(load('paired.json').values())}, sort_keys=True))
PY
}

select_initial_pairing_request() {
python3 - 3<&0 <<'PY'
import json, os
from pathlib import Path
state=json.load(os.fdopen(3))
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli'
def roles(e): return {norm(r) for r in (e.get('roles') or [e.get('role')]) if norm(r)}
def scopes(e):
    result={norm(s) for s in (e.get('scopes') or e.get('requestedScopes') or []) if norm(s)}
    if 'operator.write' in result: result.add('operator.read')
    return result
identity=json.loads((Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw') / 'identity' / 'device.json').read_text(encoding='utf-8'))
identity_device_id=norm(identity.get('deviceId'))
paired={norm(e.get('deviceId')) for e in state.get('paired') or [] if isinstance(e, dict)}
allowed={'operator.pairing','operator.read','operator.write'}
for req in sorted([e for e in state.get('pending') or [] if isinstance(e, dict)], key=lambda e:e.get('ts') or 0, reverse=True):
    requested=scopes(req)
    if (is_cli(req) and roles(req) == {'operator'}
            and 'operator.pairing' in requested and requested.issubset(allowed)
            and norm(req.get('deviceId')) == identity_device_id
            and identity_device_id not in paired and norm(req.get('requestId'))
            and norm(req.get('publicKey'))):
        print(norm(req.get('requestId')))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

select_paired_cli_device() {
python3 - 3<&0 <<'PY'
import base64, hashlib, json, os
from pathlib import Path
state=json.load(os.fdopen(3))
def norm(v): return str(v or '').strip()
def roles(value):
    result={norm(role) for role in (value.get('roles') or []) if norm(role)}
    if norm(value.get('role')): result.add(norm(value.get('role')))
    return result
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
identity=json.loads((Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw') / 'identity' / 'device.json').read_text(encoding='utf-8'))
identity_id=norm(identity.get('deviceId'))
identity_key=identity_public_key(identity)
try: identity_key_raw=base64.urlsafe_b64decode(identity_key + '=' * (-len(identity_key) % 4))
except Exception: raise SystemExit(1)
if len(identity_key_raw) != 32 or hashlib.sha256(identity_key_raw).hexdigest() != identity_id:
    raise SystemExit(1)
for dev in sorted([e for e in state.get('paired') or [] if isinstance(e, dict)], key=lambda e:e.get('approvedAtMs') or 0, reverse=True):
    device_scopes={norm(scope) for scope in (dev.get('scopes') or []) if norm(scope)}
    approved_scopes={norm(scope) for scope in (dev.get('approvedScopes') or []) if norm(scope)}
    tokens=dev.get('tokens') if isinstance(dev.get('tokens'), dict) else {}
    operator=tokens.get('operator') if isinstance(tokens.get('operator'), dict) else {}
    token_scopes={norm(scope) for scope in (operator.get('scopes') or []) if norm(scope)}
    if (
        norm(dev.get('deviceId')) == identity_id
        and norm(dev.get('publicKey')) == identity_key
        and norm(dev.get('clientMode')).lower() == 'cli'
        and roles(dev) == {'operator'}
        and device_scopes == {'operator.pairing'}
        and approved_scopes == {'operator.pairing'}
        and set(tokens) == {'operator'}
        and norm(operator.get('role')) == 'operator'
        and token_scopes == {'operator.pairing'}
        and norm(operator.get('token'))
        and norm(operator.get('token')) != norm(os.environ.get('OPENCLAW_GATEWAY_TOKEN'))
    ):
        print(identity_id)
        raise SystemExit(0)
raise SystemExit(1)
PY
}

seed_initial_pairing_request() {
  local requested_id="$1"
  python3 - "$requested_id" <<'PY'
import base64, hashlib, json, os, secrets, sys, time
from pathlib import Path

requested_id=sys.argv[1]
root=Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw')
pending_path=root / 'devices' / 'pending.json'
paired_path=root / 'devices' / 'paired.json'
identity_path=root / 'identity' / 'device.json'
auth_path=root / 'identity' / 'device-auth.json'
allowed={'operator.pairing','operator.read','operator.write'}

def norm(value): return str(value or '').strip()
def load(path):
    try: value=json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError: return {}
    return value if isinstance(value, dict) else {}
def stage_json(path, value, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp=path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    flags=os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, 'O_NOFOLLOW'): flags |= os.O_NOFOLLOW
    fd=os.open(tmp, flags, mode)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
        os.fchmod(handle.fileno(), mode)
    return tmp
def roles(value):
    result={norm(role) for role in (value.get('roles') or []) if norm(role)}
    if norm(value.get('role')): result.add(norm(value.get('role')))
    return result
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
def requested_scopes(value):
    views=[]
    for key in ('scopes','requestedScopes'):
        if key not in value: continue
        if not isinstance(value[key], list): return None
        view={norm(scope) for scope in value[key] if norm(scope)}
        if 'operator.write' in view: view.add('operator.read')
        views.append(view)
    if not views or any(not view or not view.issubset(allowed) for view in views):
        return None
    if any(view != views[0] for view in views[1:]):
        return None
    return views[0]
def is_compatible(value, device_id, public_key):
    scopes=requested_scopes(value)
    return bool(
        norm(value.get('requestId')) and norm(value.get('deviceId')) == device_id
        and norm(value.get('publicKey')) == public_key
        and norm(value.get('clientMode')).lower() == 'cli'
        and roles(value) == {'operator'} and scopes is not None
        and 'operator.pairing' in scopes
    )

identity=load(identity_path)
device_id=norm(identity.get('deviceId'))
public_key=identity_public_key(identity)
if not device_id or not public_key:
    raise SystemExit('persisted CLI identity is incomplete')
try: public_key_raw=base64.urlsafe_b64decode(public_key + '=' * (-len(public_key) % 4))
except Exception: raise SystemExit('persisted CLI public key is malformed')
if len(public_key_raw) != 32 or hashlib.sha256(public_key_raw).hexdigest() != device_id:
    raise SystemExit('persisted CLI identity key does not match its device id')

pending=load(pending_path)
paired=load(paired_path)
if device_id in paired or any(
    isinstance(item, dict) and norm(item.get('deviceId')) == device_id
    for item in paired.values()
):
    raise SystemExit('refusing to seed over an existing paired CLI device')

same_device=[
    (key,item) for key,item in pending.items()
    if isinstance(item, dict) and norm(item.get('deviceId')) == device_id
]
if not same_device or any(not is_compatible(item, device_id, public_key) for _,item in same_device):
    raise SystemExit('pending state contains no exclusively compatible CLI pairing request')

selected=next(
    ((key,item) for key,item in same_device if norm(item.get('requestId')) == requested_id),
    None,
)
if selected is None:
    selected=max(same_device, key=lambda pair: pair[1].get('ts') or 0)
request_key,request=selected
request_id=norm(request.get('requestId'))

token=secrets.token_urlsafe(32)
if not token or token == norm(os.environ.get('OPENCLAW_GATEWAY_TOKEN')):
    raise SystemExit('temporary device token generation failed')
seed_token_path=Path('/tmp/issue4462-seed-token.sha256')
seed_flags=os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, 'O_NOFOLLOW'): seed_flags |= os.O_NOFOLLOW
seed_fd=os.open(seed_token_path, seed_flags, 0o600)
with os.fdopen(seed_fd, 'w', encoding='utf-8') as handle:
    handle.write(hashlib.sha256(token.encode('utf-8')).hexdigest())
    handle.flush()
    os.fsync(handle.fileno())
    os.fchmod(handle.fileno(), 0o600)
approved=['operator.pairing']
now=int(time.time() * 1000)
operator_token={
    'token': token,
    'role': 'operator',
    'scopes': approved,
    'createdAtMs': now,
}
device={
    'deviceId': device_id,
    'publicKey': public_key,
    'displayName': request.get('displayName'),
    'platform': request.get('platform'),
    'deviceFamily': request.get('deviceFamily'),
    'clientId': request.get('clientId'),
    'clientMode': request.get('clientMode'),
    'role': 'operator',
    'roles': ['operator'],
    'scopes': approved,
    'approvedScopes': approved,
    'remoteIp': request.get('remoteIp'),
    'tokens': {'operator': operator_token},
    'createdAtMs': now,
    'approvedAtMs': now,
}
device={key:value for key,value in device.items() if value is not None}
for key,_ in same_device:
    pending.pop(key, None)
paired[device_id]=device
auth={
    'version': 1,
    'deviceId': device_id,
    'tokens': {'operator': {
        'token': token,
        'role': 'operator',
        'scopes': approved,
        'updatedAtMs': now,
    }},
}
staged=[]
try:
    paired_tmp=stage_json(paired_path, paired, 0o600)
    staged.append(paired_tmp)
    auth_tmp=stage_json(auth_path, auth, 0o600)
    staged.append(auth_tmp)
    pending_tmp=stage_json(pending_path, pending, 0o600)
    staged.append(pending_tmp)
    os.replace(pending_tmp, pending_path)
    os.replace(paired_tmp, paired_path)
    os.replace(auth_tmp, auth_path)
finally:
    for tmp in staged:
        tmp.unlink(missing_ok=True)

if any(
    isinstance(item, dict) and norm(item.get('deviceId')) == device_id
    for item in load(pending_path).values()
):
    raise SystemExit('temporary pairing seed left a same-device request pending')
seeded=load(paired_path).get(device_id)
seeded_auth=load(auth_path)
if (
    not isinstance(seeded, dict) or norm(seeded.get('publicKey')) != public_key
    or roles(seeded) != {'operator'} or seeded.get('scopes') != approved
    or seeded.get('approvedScopes') != approved
    or seeded.get('tokens', {}).get('operator', {}).get('token') != token
    or seeded_auth.get('deviceId') != device_id
    or seeded_auth.get('tokens', {}).get('operator', {}).get('token') != token
):
    raise SystemExit('temporary pairing seed did not persist the reviewed low-scope state')
print(device_id)
PY
}

rotate_cli_to_pairing_scope() {
  local device_id="$1" require_seed_replacement="\${2:-0}" rotate_output rotate_rc=0
  set +e
  rotate_output="$(
    unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
    command openclaw devices rotate --device "$device_id" --role operator \
      --scope operator.pairing --json 2>&1
  )"
  rotate_rc=$?
  set -e
  (
    umask 077
    rotate_log="$(mktemp /tmp/issue4462-rotate.XXXXXX)"
    trap 'rm -f -- "\${rotate_log:-}"' EXIT
    printf '%s\n' "$rotate_output" >"$rotate_log"
    python3 - "$device_id" "$rotate_log" "$require_seed_replacement" "$rotate_rc" <<'PY'
import base64, hashlib, json, os, re, sys
from pathlib import Path

want=sys.argv[1]
raw=Path(sys.argv[2]).read_text(encoding='utf-8')
require_seed_replacement=sys.argv[3] == '1'
rotate_rc=int(sys.argv[4])
dec=json.JSONDecoder()
result=None
for idx,ch in enumerate(raw):
    if ch != '{':
        continue
    try:
        doc,_=dec.raw_decode(raw[idx:])
    except Exception:
        continue
    if isinstance(doc, dict) and doc.get('deviceId') == want:
        result=doc
        break
if result is None:
    safe_raw=re.sub(
        r'(?i)(["\x27]?[A-Za-z0-9_.-]*token["\x27]?\s*[:=]\s*["\x27]?)[A-Za-z0-9._~+/=-]{8,}',
        r'\1<redacted>',
        raw,
    )
    safe_raw=re.sub(r'(?i)(Bearer\s+)\S+', r'\1<redacted>', safe_raw)
    print(safe_raw[:2000], file=sys.stderr)
    raise SystemExit(f'device token rotation did not return the expected JSON (rc={rotate_rc})')
def norm(value): return str(value or '').strip()
def scopes(value):
    return {norm(scope) for scope in value if norm(scope)}
def roles(value):
    result={norm(role) for role in (value.get('roles') or []) if norm(role)}
    if norm(value.get('role')): result.add(norm(value.get('role')))
    return result
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
def load(path):
    try: value=json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError: return {}
    return value if isinstance(value, dict) else {}
def write_json(path, value, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp=path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    flags=os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, 'O_NOFOLLOW'): flags |= os.O_NOFOLLOW
    fd=os.open(tmp, flags, mode)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
        os.fchmod(handle.fileno(), mode)
    os.replace(tmp, path)

result_scopes=scopes(result.get('scopes') or [])
reported_token=norm(result.get('token'))
rotated_at=result.get('rotatedAtMs')
if rotate_rc != 0:
    raise SystemExit(f'device token rotation returned JSON but exited {rotate_rc}')
if (
    norm(result.get('role')) != 'operator'
    or result_scopes != {'operator.pairing'}
    or not isinstance(rotated_at, int) or isinstance(rotated_at, bool) or rotated_at <= 0
):
    raise SystemExit('unexpected public device-rotation result')

root=Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw')
identity_path=root / 'identity' / 'device.json'
auth_path=root / 'identity' / 'device-auth.json'
paired_path=root / 'devices' / 'paired.json'
identity=load(identity_path)
identity_key=identity_public_key(identity)
if norm(identity.get('deviceId')) != want or not identity_key:
    raise SystemExit('rotated device does not match the persisted CLI identity')
try: identity_key_raw=base64.urlsafe_b64decode(identity_key + '=' * (-len(identity_key) % 4))
except Exception: raise SystemExit('rotated device identity key is malformed')
if len(identity_key_raw) != 32 or hashlib.sha256(identity_key_raw).hexdigest() != want:
    raise SystemExit('rotated device identity key does not match its device id')

paired=load(paired_path)
paired_device=next(
    (value for value in paired.values() if isinstance(value, dict) and norm(value.get('deviceId')) == want),
    None,
)
if paired_device is None:
    raise SystemExit('rotated device is missing from paired state')
if (
    norm(paired_device.get('publicKey')) != identity_key
    or norm(paired_device.get('clientMode')).lower() != 'cli'
    or roles(paired_device) != {'operator'}
    or scopes(paired_device.get('scopes') or []) != {'operator.pairing'}
    or scopes(paired_device.get('approvedScopes') or []) != {'operator.pairing'}
):
    raise SystemExit('rotated device metadata or approved baseline changed unexpectedly')
tokens=paired_device.get('tokens') if isinstance(paired_device.get('tokens'), dict) else {}
operator=tokens.get('operator') if isinstance(tokens.get('operator'), dict) else {}
rotated_token=norm(operator.get('token'))
if (
    set(tokens) != {'operator'} or not rotated_token
    or rotated_token == norm(os.environ.get('OPENCLAW_GATEWAY_TOKEN'))
    or norm(operator.get('role')) != 'operator'
    or scopes(operator.get('scopes') or []) != {'operator.pairing'}
    or operator.get('rotatedAtMs') != rotated_at
):
    raise SystemExit('authoritative paired token is unsafe after rotation')
if reported_token and reported_token != rotated_token:
    raise SystemExit('reported token does not match authoritative paired state')

seed_token_path=Path('/tmp/issue4462-seed-token.sha256')
auth_before=load(auth_path)
auth_before_tokens=auth_before.get('tokens') if isinstance(auth_before.get('tokens'), dict) else {}
auth_before_operator=auth_before_tokens.get('operator', {})
auth_before_token=norm(auth_before_operator.get('token'))
if (
    auth_before.get('deviceId') != want
    or set(auth_before_tokens) != {'operator'}
    or not auth_before_token or norm(auth_before_operator.get('role')) != 'operator'
    or scopes(auth_before_operator.get('scopes') or []) != {'operator.pairing'}
    or rotated_token == auth_before_token
):
    raise SystemExit('OpenClaw did not rotate the prior pairing-only device credential')
if require_seed_replacement:
    try: seed_digest=seed_token_path.read_text(encoding='utf-8')
    except FileNotFoundError: raise SystemExit('temporary seed token proof is missing')
    if (
        len(seed_digest) != 64
        or hashlib.sha256(auth_before_token.encode('utf-8')).hexdigest() != seed_digest
        or hashlib.sha256(rotated_token.encode('utf-8')).hexdigest() == seed_digest
    ):
        raise SystemExit('OpenClaw did not replace the temporary seed token')
elif seed_token_path.exists():
    raise SystemExit('unexpected temporary seed token proof')

auth={
    'version': 1,
    'deviceId': want,
    'tokens': {'operator': {
        'token': rotated_token,
        'role': 'operator',
        'scopes': ['operator.pairing'],
        'updatedAtMs': rotated_at,
    }},
}
write_json(auth_path, auth, 0o600)
persisted_auth=load(auth_path)
persisted_operator=(
    persisted_auth.get('tokens', {}).get('operator', {})
    if isinstance(persisted_auth.get('tokens'), dict) else {}
)
if (
    persisted_auth.get('deviceId') != want
    or set(persisted_auth.get('tokens') or {}) != {'operator'}
    or norm(persisted_operator.get('token')) != rotated_token
    or norm(persisted_operator.get('role')) != 'operator'
    or scopes(persisted_operator.get('scopes') or []) != {'operator.pairing'}
):
    raise SystemExit('rotated token did not persist canonically to device auth')
if require_seed_replacement:
    seed_token_path.unlink()
print(json.dumps({'deviceId': want, 'scopes': sorted(result_scopes)}, sort_keys=True))
PY
  )
}

select_scope_request() {
  local expected_device_id="$1"
python3 - "$expected_device_id" 3<&0 <<'PY'
import json, os, sys
state=json.load(os.fdopen(3))
expected_device_id=sys.argv[1]
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli'
def scopes(e): return {norm(s) for s in (e.get('scopes') or e.get('requestedScopes') or []) if norm(s)}
def approved(e): return {norm(s) for s in (e.get('approvedScopes') or e.get('scopes') or []) if norm(s)}
paired={norm(e.get('deviceId')): e for e in state.get('paired') or [] if isinstance(e, dict)}
for req in sorted([e for e in state.get('pending') or [] if isinstance(e, dict)], key=lambda e:e.get('ts') or 0, reverse=True):
    request_device_id=norm(req.get('deviceId'))
    if request_device_id != expected_device_id:
        continue
    p=paired.get(request_device_id)
    requested=scopes(req)
    is_upgrade = p is None or not requested.issubset(approved(p))
    if is_cli(req) and {'operator.write','operator.read'}.intersection(requested) and is_upgrade and norm(req.get('requestId')):
        print(norm(req.get('requestId')))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

contains_integer_42() {
  local raw compact
  raw="$(cat)"
  compact="$(printf '%s' "$raw" | tr -d '[:space:]')"
  grep -Eq '(^|[^0-9])42([^0-9]|$)' <<<"$compact"
}

assert_agent_scopes_without_admin() {
  local expected_device_id="$1"
python3 - "$expected_device_id" 3<&0 <<'PY'
import json, os, sys
state=json.load(os.fdopen(3))
expected_device_id=sys.argv[1]
def norm(v): return str(v or '').strip()
def is_cli(e): return norm(e.get('clientMode')).lower() == 'cli'
def scopes(e): return {norm(s) for s in (e.get('approvedScopes') or e.get('scopes') or []) if norm(s)}
for dev in state.get('paired') or []:
    if not isinstance(dev, dict) or not is_cli(dev) or norm(dev.get('deviceId')) != expected_device_id:
        continue
    approved=scopes(dev)
    if 'operator.admin' in approved:
        print('ADMIN_SCOPE_PRESENT', file=sys.stderr)
        raise SystemExit(2)
    if 'operator.write' in approved:
        print(norm(dev.get('deviceId')) or 'cli-device')
        raise SystemExit(0)
print('NO_AGENT_SCOPES', file=sys.stderr)
raise SystemExit(1)
PY
}

approve_request() {
  local request_id="$1" approve_output approve_log approve_rc=0 snapshot
  snapshot="/tmp/issue4462-approve-$request_id.request.json"
  umask 077
  if ! python3 - "$request_id" >"$snapshot" <<'PY'
import json, os, sys
from pathlib import Path

want=sys.argv[1]
root=Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw')
allowed={'operator.pairing','operator.read','operator.write'}

def norm(value): return str(value or '').strip()
def load(name):
    try: value=json.loads((root / 'devices' / name).read_text(encoding='utf-8'))
    except FileNotFoundError: return {}
    return value if isinstance(value, dict) else {}
def normalize(values):
    result={norm(value) for value in values if norm(value)}
    if 'operator.write' in result: result.add('operator.read')
    return result
def scope_views(value, keys):
    views=[]
    for key in keys:
        if key not in value: continue
        if not isinstance(value[key], list): raise SystemExit(f'{key} is not a scope list')
        views.append(normalize(value[key]))
    return views
def canonical_scopes(value, keys, label):
    views=scope_views(value, keys)
    if not views or any(not view or not view.issubset(allowed) for view in views):
        raise SystemExit(f'unsafe {label} scope representation')
    if any(view != views[0] for view in views[1:]):
        raise SystemExit(f'divergent {label} scope representations')
    return views[0]
def roles(value):
    result={norm(role) for role in (value.get('roles') or []) if norm(role)}
    if norm(value.get('role')): result.add(norm(value.get('role')))
    return result

pending=load('pending.json')
request=next((item for item in pending.values() if isinstance(item, dict) and norm(item.get('requestId')) == want), None)
if request is None: raise SystemExit(f'missing pending request {want}')
device_id=norm(request.get('deviceId'))
public_key=norm(request.get('publicKey'))
is_cli=norm(request.get('clientMode')).lower() == 'cli'
if not device_id or not public_key or not is_cli or roles(request) != {'operator'}:
    raise SystemExit('refusing non-CLI/non-operator pairing request')
requested=canonical_scopes(request, ('scopes','requestedScopes'), 'requested')

paired=load('paired.json')
existing=next((item for item in paired.values() if isinstance(item, dict) and norm(item.get('deviceId')) == device_id), None)
if existing is None:
    raise SystemExit('scope approval requires an existing paired operator baseline')
else:
    if norm(existing.get('publicKey')) != public_key or roles(existing) != {'operator'}:
        raise SystemExit('scope upgrade does not match the paired operator device')
    baseline=canonical_scopes(existing, ('scopes','approvedScopes'), 'existing paired')
    expected=baseline | requested
    if not {'operator.read','operator.write'}.intersection(requested) or expected == baseline:
        raise SystemExit('request is not an operator scope upgrade')

identity=json.loads((root / 'identity' / 'device.json').read_text(encoding='utf-8'))
if norm(identity.get('deviceId')) != device_id:
    raise SystemExit('request does not match the persisted CLI identity')
print(json.dumps({
    'requestId': want,
    'deviceId': device_id,
    'publicKey': public_key,
    'clientId': norm(request.get('clientId')),
    'clientMode': norm(request.get('clientMode')),
    'expectedScopes': sorted(expected),
}, sort_keys=True))
PY
  then
    rm -f "$snapshot"
    return 1
  fi
  set +e
  approve_output="$(openclaw devices approve "$request_id" --json 2>&1)"
  approve_rc=$?
  set -e
  approve_log="/tmp/issue4462-approve-$request_id.log"
  printf '%s\n' "$approve_output" >"$approve_log"
  python3 - "$snapshot" "$approve_rc" "$approve_log" <<'PY'
import json, os, sys
from pathlib import Path

snapshot=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
approve_rc=int(sys.argv[2])
approve_log=Path(sys.argv[3])
root=Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw')
allowed={'operator.pairing','operator.read','operator.write'}

def norm(value): return str(value or '').strip()
def fail(message):
    if approve_log.exists(): print(approve_log.read_text(encoding='utf-8'), file=sys.stderr)
    raise SystemExit(f'{message} (approve rc={approve_rc})')
def load(path):
    try: value=json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError: return {}
    return value if isinstance(value, dict) else {}
def normalize(values):
    result={norm(value) for value in values if norm(value)}
    if 'operator.write' in result: result.add('operator.read')
    return result
def canonical_scopes(value, keys):
    views=[]
    for key in keys:
        if key not in value: continue
        if not isinstance(value[key], list): fail(f'{key} is not a scope list')
        views.append(normalize(value[key]))
    if not views or any(not view or not view.issubset(allowed) for view in views): fail('unsafe scope representation')
    if any(view != views[0] for view in views[1:]): fail('divergent scope representations')
    return views[0]
def roles(value):
    result={norm(role) for role in (value.get('roles') or []) if norm(role)}
    if norm(value.get('role')): result.add(norm(value.get('role')))
    return result

device_id=snapshot['deviceId']
pending=load(root / 'devices' / 'pending.json')
if any(isinstance(item, dict) and norm(item.get('deviceId')) == device_id for item in pending.values()):
    fail('pairing request did not converge')
paired=load(root / 'devices' / 'paired.json')
device=next((value for value in paired.values() if isinstance(value, dict) and norm(value.get('deviceId')) == device_id), None)
if device is None or norm(device.get('publicKey')) != snapshot['publicKey']:
    fail('approval did not produce the exact requested device')
if roles(device) != {'operator'}:
    fail('approved device has a non-operator role')
is_cli=norm(device.get('clientMode')).lower() == 'cli'
if not is_cli: fail('approved device is not a CLI client')
expected=set(snapshot['expectedScopes'])
if canonical_scopes(device, ('scopes','approvedScopes')) != expected:
    fail('approved device scopes do not match the reviewed request')
tokens=device.get('tokens') if isinstance(device.get('tokens'), dict) else {}
operator=tokens.get('operator') if isinstance(tokens.get('operator'), dict) else {}
if norm(operator.get('role')) != 'operator' or canonical_scopes(operator, ('scopes',)) != expected:
    fail('approved device token scopes do not match the reviewed request')
token=norm(operator.get('token'))
if not token or token == norm(os.environ.get('OPENCLAW_GATEWAY_TOKEN')):
    fail('approval did not produce a distinct real device token')
identity=load(root / 'identity' / 'device.json')
if norm(identity.get('deviceId')) != device_id:
    fail('approved device does not match the persisted CLI identity')
auth_path=root / 'identity' / 'device-auth.json'
auth_path.parent.mkdir(parents=True, exist_ok=True)
tmp=auth_path.with_name('.device-auth.json.tmp')
auth={'version': 1, 'deviceId': device_id, 'tokens': {'operator': {
    'token': token,
    'role': 'operator',
    'scopes': sorted(expected),
    'updatedAtMs': operator.get('updatedAtMs') or operator.get('rotatedAtMs') or operator.get('createdAtMs'),
}}}
tmp.write_text(json.dumps(auth, indent=2, sort_keys=True) + '\n', encoding='utf-8')
os.chmod(tmp, 0o600)
os.replace(tmp, auth_path)
print(device_id)
PY
}

initial_list_rc=0
seeded_initial=0
echo "ISSUE_4462_STAGE=direct-local-bootstrap"
(
  unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
  command openclaw devices list --json
) >/tmp/issue4462-devices-list.json 2>&1 || initial_list_rc=$?
printf '%s\n' "$initial_list_rc" >/tmp/issue4462-devices-list.rc
state="$(state_json)"
initial_request_id="$(printf '%s' "$state" | select_initial_pairing_request 2>/dev/null || true)"
if [ -n "$initial_request_id" ]; then
  echo "ISSUE_4462_STAGE=seed-initial-pairing request=$initial_request_id"
  paired_device_id="$(seed_initial_pairing_request "$initial_request_id")"
  seeded_initial=1
else
  paired_device_id="$(printf '%s' "$state" | select_paired_cli_device 2>/dev/null || true)"
fi
if [ -z "$paired_device_id" ]; then
  echo "NO_INITIAL_PAIRED_CLI_DEVICE rc=$initial_list_rc" >&2
  exit 5
fi
echo "ISSUE_4462_STAGE=rotate-cli-to-pairing"
rotate_cli_to_pairing_scope "$paired_device_id" "$seeded_initial" >/tmp/issue4462-initial-pairing.log
state="$(state_json)"
request_id="$(printf '%s' "$state" | select_scope_request "$paired_device_id" 2>/dev/null || true)"
if [ -z "$request_id" ]; then
  session_id="issue-4462-trigger-$(date +%s)-$$"
  rm -f "/sandbox/.openclaw/agents/main/sessions/\${session_id}.jsonl.lock" \
        "/sandbox/.openclaw/agents/main/sessions/\${session_id}.trajectory.jsonl" 2>/dev/null || true
  set +e
  trigger_output="$(openclaw agent --agent main --json --session-id "$session_id" -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.' 2>&1)"
  trigger_rc=$?
  set -e
  printf '%s\n' "$trigger_output" >/tmp/issue4462-trigger-agent.log
  state="$(state_json)"
  request_id="$(printf '%s' "$state" | select_scope_request "$paired_device_id" 2>/dev/null || true)"
  if [ -z "$request_id" ]; then
    if printf '%s' "$state" | assert_agent_scopes_without_admin "$paired_device_id" >/tmp/issue4462-approved-device.txt 2>/tmp/issue4462-approved-device.err; then
      echo "SCOPE_ALREADY_APPROVED=$(cat /tmp/issue4462-approved-device.txt)"
    elif [ "$trigger_rc" -eq 0 ] && ! grep -Eiq 'EMBEDDED FALLBACK|scope upgrade pending approval|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded' /tmp/issue4462-trigger-agent.log \
      && contains_integer_42 </tmp/issue4462-trigger-agent.log; then
      echo "TRIGGER_COMPLETED_WITHOUT_PENDING_SCOPE_UPGRADE"
      echo "ISSUE_4462_SCOPE_UPGRADE_OK device=trigger-completed request=not-reproduced"
      exit 0
    else
      echo "NO_SCOPE_REQUEST" >&2
      cat /tmp/issue4462-trigger-agent.log >&2
      printf '%s\n' "$state" >&2
      exit 5
    fi
  fi
fi

if [ -n "$request_id" ]; then
  echo "ISSUE_4462_STAGE=approve-scope-upgrade request=$request_id"
  approve_request "$request_id"
fi

state="$(state_json)"
printf '%s' "$state" | assert_agent_scopes_without_admin "$paired_device_id" >/tmp/issue4462-final-device.txt
if printf '%s' "$state" | select_scope_request "$paired_device_id" >/tmp/issue4462-pending-after.txt 2>/dev/null; then
  echo "PENDING_AFTER_APPROVAL=$(cat /tmp/issue4462-pending-after.txt)" >&2
  exit 6
fi

session_id="issue-4462-final-$(date +%s)-$$"
echo "ISSUE_4462_STAGE=final-gateway-agent"
final_output="$(openclaw agent --agent main --json --session-id "$session_id" -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.' 2>&1)"
printf '%s\n' "$final_output" >/tmp/issue4462-final-agent.log
if grep -Eiq 'EMBEDDED FALLBACK|scope upgrade pending approval|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded' /tmp/issue4462-final-agent.log; then
  echo "FINAL_AGENT_FALLBACK_OR_PAIRING" >&2
  cat /tmp/issue4462-final-agent.log >&2
  exit 7
fi
if ! contains_integer_42 </tmp/issue4462-final-agent.log; then
  echo "FINAL_AGENT_MISSING_42" >&2
  cat /tmp/issue4462-final-agent.log >&2
  exit 8
fi
echo "ISSUE_4462_SCOPE_UPGRADE_OK device=$(cat /tmp/issue4462-final-device.txt) request=\${request_id:-auto}"
`;
}

liveTest(
  "issue 4462 scope-upgrade approval stays on gateway path without admin leak",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    await artifacts.writeJson("target.json", {
      id: "issue-4462-scope-upgrade-approval",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "install.sh creates a real OpenClaw sandbox",
        "proxy env exposes a loopback gateway and contains the devices approve guard",
        "CLI scope upgrade is approved without operator.admin",
        "final openclaw agent turn stays on the gateway path and answers 42",
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: env(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(docker));
      skip(`Docker is required: ${resultText(docker)}`);
    }

    cleanupRegistry.add("remove issue-4462 sandbox", () => cleanup(host, sandbox));
    await cleanup(host, sandbox);

    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "phase-1-install-sh",
        cwd: REPO_ROOT,
        env: env({ NVIDIA_INFERENCE_API_KEY: apiKey }),
        redactionValues: [apiKey],
        timeoutMs: 30 * 60_000,
      },
    );
    expect(install.exitCode, resultText(install)).toBe(0);

    const encodedScopeUpgradeScript = Buffer.from(
      scopeUpgradeScript().replaceAll("\\${", "${"),
      "utf8",
    ).toString("base64");
    const scopeUpgradeScriptChunks = encodedScopeUpgradeScript.match(/.{1,24000}/g) ?? [];
    expect(scopeUpgradeScriptChunks).not.toHaveLength(0);
    const probe = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-lc",
        `set -e; umask 077; tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT; printf '%s' "$@" | base64 -d > "$tmp"; bash "$tmp"`,
        "issue-4462-scope-upgrade-probe",
        ...scopeUpgradeScriptChunks,
      ],
      {
        artifactName: "phase-2-scope-upgrade-approval",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 12 * 60_000,
      },
    );
    expect(probe.exitCode, resultText(probe)).toBe(0);
    expect(resultText(probe)).toContain("ISSUE_4462_SCOPE_UPGRADE_OK");

    await cleanup(host, sandbox);
    await artifacts.writeJson("target-result.json", {
      id: "issue-4462-scope-upgrade-approval",
      status: "passed",
    });
  },
);
