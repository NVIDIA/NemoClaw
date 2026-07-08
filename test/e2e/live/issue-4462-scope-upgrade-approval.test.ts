// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { ISSUE_4462_PAIRING_SEED_PY } from "../fixtures/issue-4462-pairing-seed.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  adminApprovalConnectScript,
  extractPendingRequestId,
} from "./issue-4462-admin-approval-helper.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-issue-4462";
const LIVE_TIMEOUT_MS = 70 * 60_000;

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

interface FreshAgentGatewaySnapshot {
  activeOperatorTokenCount: number;
  activeOperatorTokenScopes: string[];
  approvedScopes: string[];
  deviceId: string;
  deviceScopes: string[];
  gatewayCompletedRuns: number;
  matchingPairedCount: number;
  pairedCliCount: number;
  pendingCount: number;
  publicKey: string;
  sameDevicePendingCount: number;
}

const FRESH_AGENT_GATEWAY_SNAPSHOT_PY = fs.readFileSync(
  path.join(import.meta.dirname, "..", "lib", "issue-4462-fresh-agent-gateway-snapshot.py"),
  "utf8",
);
const FRESH_AGENT_GATEWAY_SNAPSHOT_B64 = Buffer.from(
  FRESH_AGENT_GATEWAY_SNAPSHOT_PY,
  "utf8",
).toString("base64");

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
. /tmp/nemoclaw-proxy-env.sh
if [ -n "\${OPENCLAW_GATEWAY_URL:-}" ]; then
  echo "PUBLIC_GATEWAY_URL_LEAK" >&2
  exit 3
fi
if [ -n "\${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" ]; then
  echo "PUBLIC_INSECURE_WS_LEAK" >&2
  exit 4
fi
if [ -z "\${OPENCLAW_GATEWAY_PORT:-}" ] || [ -z "\${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "GATEWAY_PORT_OR_TOKEN_MISSING" >&2
  exit 4
fi
case "\${NEMOCLAW_OPENCLAW_GATEWAY_URL:-}" in
  ws://127.0.0.1:*|ws://localhost:*) ;;
  ws://10.*:*|ws://192.168.*:*|ws://172.1[6-9].*:*|ws://172.2[0-9].*:*|ws://172.3[0-1].*:*)
    if [ "\${NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" != "1" ]; then
      echo "MISSING_PRIVATE_INSECURE_WS_MARKER" >&2
      exit 4
    fi
    ;;
  *) echo "BAD_PRIVATE_GATEWAY_ALIAS" >&2; exit 4 ;;
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
def is_cli(e):
    return e.get('clientId') == 'cli' and e.get('clientMode') == 'cli'
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
    # Fresh #4504 turns establish the compact write grant before this recovery
    # proof; the seeded legacy path can still arrive pairing-only.
    canonical_non_admin_scope_state=(
        'pairing' if (device_scopes == {'operator.pairing'} and token_scopes == {'operator.pairing'})
        else 'write' if (device_scopes == {'operator.pairing','operator.write'}
            and token_scopes == {'operator.pairing','operator.read','operator.write'})
        else ''
    )
    if (
        norm(dev.get('deviceId')) == identity_id
        and norm(dev.get('publicKey')) == identity_key
        and dev.get('clientId') == 'cli'
        and dev.get('clientMode') == 'cli'
        and roles(dev) == {'operator'}
        and approved_scopes == device_scopes
        and canonical_non_admin_scope_state
        and set(tokens) == {'operator'}
        and norm(operator.get('role')) == 'operator'
        and norm(operator.get('token'))
        and norm(operator.get('token')) != norm(os.environ.get('OPENCLAW_GATEWAY_TOKEN'))
    ):
        print(f'{identity_id} {canonical_non_admin_scope_state}')
        raise SystemExit(0)
raise SystemExit(1)
PY
}

seed_initial_pairing_request() {
  local requested_id="$1"
  python3 - "$requested_id" <<'PY'
${ISSUE_4462_PAIRING_SEED_PY}
run_cli()
PY
}

rebootstrap_write_cli_to_pairing() {
  local expected_device_id="$1" remove_rc=0 attempt state paired_record
  set +e
  (
    unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
    command openclaw devices remove "$expected_device_id" --json >/dev/null 2>&1
  )
  remove_rc=$?
  set -e
  if [ "$remove_rc" -ne 0 ]; then
    echo "CANONICAL_DEVICE_REMOVE_FAILED rc=$remove_rc" >&2
    return 1
  fi
  attempt=0
  while [ "$attempt" -lt 10 ]; do
    (
      unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN
      command openclaw devices list --json >/dev/null 2>&1
    ) || true
    state="$(state_json)"
    paired_record="$(printf '%s' "$state" | select_paired_cli_device 2>/dev/null || true)"
    if [ "$paired_record" = "$expected_device_id pairing" ]; then
      printf '%s\n' "$paired_record"
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 10 ] && sleep 1
  done
  echo "CANONICAL_PAIRING_REBOOTSTRAP_FAILED" >&2
  return 1
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
    or paired_device.get('clientId') != 'cli'
    or paired_device.get('clientMode') != 'cli'
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
def is_cli(e):
    return e.get('clientId') == 'cli' and e.get('clientMode') == 'cli'
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
    if (is_cli(req) and req.get('isRepair') is True
            and {'operator.write','operator.read'}.intersection(requested)
            and is_upgrade and norm(req.get('requestId'))):
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

approval_state() {
python3 - "$@" 3<&3 4<&4 5<&5 <<'PY'
import base64, hashlib, json, os, re, sys, tempfile, time
from pathlib import Path

mode, want, expected_device_id, approve_rc=sys.argv[1:5]
target_raw=os.fdopen(3).read().strip()
snapshot_raw=os.fdopen(4).read().strip()
raw_log=os.fdopen(5).read()[:2000]
parsed_target=json.loads(target_raw) if target_raw else {}
parsed_snapshot=json.loads(snapshot_raw) if snapshot_raw else {}
target=parsed_target if isinstance(parsed_target, dict) else {}
snapshot=parsed_snapshot if isinstance(parsed_snapshot, dict) else {}
root=Path(os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw')
allowed={'operator.pairing','operator.read','operator.write'}
final_scopes=allowed
SETTLE_TIMEOUT_SECONDS=10.0
SETTLE_POLL_SECONDS=0.2
SETTLE_ATTEMPTS=int(SETTLE_TIMEOUT_SECONDS / SETTLE_POLL_SECONDS) + 1

def norm(value): return str(value or '').strip()
def fail(message):
    safe=re.sub(r'(?i)(["\x27]?[A-Za-z0-9_.-]*token["\x27]?\s*[:=]\s*["\x27]?)[A-Za-z0-9._~+/=-]{8,}', r'\1<redacted>', raw_log)
    safe=re.sub(r'(?i)(Bearer\s+)\S+', r'\1<redacted>', safe)
    if safe.strip(): print(safe, file=sys.stderr)
    raise SystemExit(f'{message} (approve rc={approve_rc})')
def load(path):
    try: value=json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError: return {}
    return value if isinstance(value, dict) else {}
def load_state():
    return {
        'pending': load(root / 'devices' / 'pending.json'),
        'paired': load(root / 'devices' / 'paired.json'),
        'identity': load(root / 'identity' / 'device.json'),
        'auth': load(root / 'identity' / 'device-auth.json'),
    }
def bounded_scope_views(value, keys):
    views=[]
    for key in keys:
        if key not in value: continue
        raw=value[key]
        if not isinstance(raw, list): return None
        view={norm(item) for item in raw if norm(item)}
        if 'operator.write' in view: view.add('operator.read')
        if not view or not view.issubset(allowed): return None
        views.append(view)
    return views or None
def scopes(value, keys):
    views=bounded_scope_views(value, keys)
    if views is None or any(view != views[0] for view in views[1:]): return None
    return views[0]
def roles(value):
    raw=value.get('roles') or []
    if not isinstance(raw, list): return None
    result={norm(role) for role in raw if norm(role)}
    if norm(value.get('role')): result.add(norm(value.get('role')))
    return result
def identity_key(identity):
    direct=identity.get('publicKey')
    if isinstance(direct, str) and direct == direct.strip() and direct:
        key=direct
    else:
        pem=identity.get('publicKeyPem')
        if not isinstance(pem, str): return ''
        body=''.join(line.strip() for line in pem.splitlines() if not line.startswith('-----'))
        try: der=base64.b64decode(body, validate=True)
        except Exception: return ''
        prefix=bytes.fromhex('302a300506032b6570032100')
        if len(der) != len(prefix) + 32 or not der.startswith(prefix): return ''
        key=base64.urlsafe_b64encode(der[len(prefix):]).decode('ascii').rstrip('=')
    try: raw=base64.urlsafe_b64decode(key + '=' * (-len(key) % 4))
    except Exception: return ''
    if len(raw) != 32 or hashlib.sha256(raw).hexdigest() != expected_device_id: return ''
    return key
def same_device_pending(state):
    return [
        value for value in state['pending'].values()
        if isinstance(value, dict) and norm(value.get('deviceId')) == expected_device_id
    ]
def exact_request(state, request_id):
    matches=[
        value for value in state['pending'].values()
        if isinstance(value, dict) and value.get('requestId') == request_id
    ]
    if len(matches) > 1: fail('duplicate exact request ids appeared')
    return matches[0] if matches else None
def paired_context(state, expected_key=''):
    identity=state['identity']
    key=identity_key(identity)
    if identity.get('deviceId') != expected_device_id or not key:
        return None
    if expected_key and key != expected_key: return None
    device=state['paired'].get(expected_device_id)
    if (not isinstance(device, dict) or device.get('deviceId') != expected_device_id
            or device.get('publicKey') != key
            or device.get('clientId') != 'cli' or device.get('clientMode') != 'cli'
            or roles(device) != {'operator'}):
        return None
    device_scopes=scopes(device, ('scopes','approvedScopes'))
    tokens=device.get('tokens') if isinstance(device.get('tokens'), dict) else {}
    operator=tokens.get('operator') if isinstance(tokens.get('operator'), dict) else {}
    token=operator.get('token')
    if (device_scopes is None or set(tokens) != {'operator'}
            or operator.get('role') != 'operator'
            or scopes(operator, ('scopes',)) != device_scopes
            or not isinstance(token, str) or token != token.strip() or not token
            or token == norm(os.environ.get('OPENCLAW_GATEWAY_TOKEN'))):
        return None
    return {'key': key, 'device': device, 'operator': operator, 'token': token, 'scopes': device_scopes}
def auth_matches(state, context):
    auth=state['auth']
    tokens=auth.get('tokens') if isinstance(auth.get('tokens'), dict) else {}
    operator=tokens.get('operator') if isinstance(tokens.get('operator'), dict) else {}
    return (
        auth.get('version') == 1 and auth.get('deviceId') == expected_device_id
        and set(tokens) == {'operator'} and operator.get('role') == 'operator'
        and operator.get('token') == context['token']
        and scopes(operator, ('scopes',)) == context['scopes']
    )
def exact_nonempty_id(value):
    return (
        isinstance(value, str) and value == value.strip() and bool(value)
        and not any(character.isspace() for character in value)
    )
def inert_final_pending_failures(state, context, reviewed_target):
    state=state if isinstance(state, dict) else {}
    context=context if isinstance(context, dict) else {}
    reviewed_target=reviewed_target if isinstance(reviewed_target, dict) else {}
    pending_by_id=state.get('pending')
    pending_by_id=pending_by_id if isinstance(pending_by_id, dict) else {}
    pending=[
        value for value in pending_by_id.values()
        if isinstance(value, dict) and norm(value.get('deviceId')) == expected_device_id
    ]
    request=pending[0] if len(pending) == 1 else {}
    request_id=request.get('requestId')
    target_request_id=reviewed_target.get('requestId')
    target_baseline=reviewed_target.get('baselineScopes')
    target_requested=reviewed_target.get('requestedScopes')
    target_expected=(reviewed_target.get('expectedScopes')
        if isinstance(reviewed_target.get('expectedScopes'), list) else [])
    target_hash=reviewed_target.get('baselineTokenHash')
    target_requested_set=(
        {norm(scope) for scope in target_requested if norm(scope)}
        if isinstance(target_requested, list) else set()
    )
    scope_keys={
        key for key in request
        if isinstance(key, str) and key.lower().endswith('scopes')
    }
    unexpected_auth_keys={
        key for key in request
        if isinstance(key, str)
        and any(marker in key.lower()
            for marker in ('auth', 'credential', 'permission', 'secret', 'token'))
    }
    request_id_matches=[
        value for value in pending_by_id.values()
        if isinstance(value, dict) and value.get('requestId') == request_id
    ]
    current_token=context.get('token')
    current_hash=(
        hashlib.sha256(current_token.encode()).hexdigest()
        if isinstance(current_token, str) else ''
    )
    authorization_inert=request.get('scopes') == [] and request.get('silent') is True
    # OpenClaw can publish this no-capability local repair after the reviewed
    # scope upgrade. Leave it untouched; the final real agent call proves it
    # is irrelevant to this scope gate rather than treating the pending
    # request itself as paired.
    checks=(
        ('same-device-count', len(pending) == 1),
        ('target-present', bool(reviewed_target)),
        ('final-context', context.get('scopes') == final_scopes),
        ('target-request-id', exact_nonempty_id(target_request_id)),
        ('target-identity',
            reviewed_target.get('deviceId') == expected_device_id
            and reviewed_target.get('publicKey') == context.get('key')
            and reviewed_target.get('clientId') == 'cli'
            and reviewed_target.get('clientMode') == 'cli'),
        ('target-baseline', target_baseline == ['operator.pairing']),
        ('target-requested',
            isinstance(target_requested, list)
            and all(isinstance(scope, str) and scope == scope.strip() and scope
                for scope in target_requested)
            and target_requested == sorted(target_requested_set)
            and bool({'operator.read','operator.write'}.intersection(target_requested_set))
            and target_requested_set.issubset(final_scopes)
            and {'operator.pairing'} | target_requested_set == final_scopes),
        ('target-expected', target_expected == sorted(final_scopes)),
        ('target-hash',
            isinstance(target_hash, str)
            and re.fullmatch(r'[0-9a-f]{64}', target_hash) is not None),
        ('token-rotated', bool(current_hash) and current_hash != target_hash),
        ('successor-request-id',
            exact_nonempty_id(request_id) and request_id != target_request_id),
        ('successor-request-id-unique', len(request_id_matches) == 1),
        ('successor-map-key',
            isinstance(request_id, str) and pending_by_id.get(request_id) is request),
        ('successor-identity',
            request.get('deviceId') == expected_device_id
            and request.get('publicKey') == context.get('key')),
        ('successor-client',
            request.get('clientId') == 'cli' and request.get('clientMode') == 'cli'),
        ('successor-repair', request.get('isRepair') is True),
        ('successor-role',
            request.get('role') == 'operator' and request.get('roles') == ['operator']),
        ('successor-scope-fields', scope_keys == {'scopes'}),
        ('successor-authorization-inert', authorization_inert),
        ('successor-auth-fields', not unexpected_auth_keys),
    )
    return [name for name, valid in checks if not valid]
def inert_final_pending(state, context, reviewed_target):
    return not inert_final_pending_failures(state, context, reviewed_target)
def inert_final_pending_diagnostic(state, context, reviewed_target):
    state=state if isinstance(state, dict) else {}
    pending_by_id=state.get('pending')
    pending_by_id=pending_by_id if isinstance(pending_by_id, dict) else {}
    pending=[
        value for value in pending_by_id.values()
        if isinstance(value, dict) and norm(value.get('deviceId')) == expected_device_id
    ]
    request=pending[0] if len(pending) == 1 else {}
    scope_keys=[
        key for key in request
        if isinstance(key, str) and key.lower().endswith('scopes')
    ]
    raw_scopes=request.get('scopes')
    scope_count=len(raw_scopes) if isinstance(raw_scopes, list) else -1
    scope_classes=[]
    known_scope_classes={
        'operator.admin': 'admin',
        'operator.approvals': 'approvals',
        'operator.pairing': 'pairing',
        'operator.read': 'read',
        'operator.talk.secrets': 'talk-secrets',
        'operator.write': 'write',
    }
    if isinstance(raw_scopes, list):
        for scope in raw_scopes:
            if not isinstance(scope, str):
                scope_classes.append(type(scope).__name__)
                continue
            normalized=scope.strip()
            scope_classes.append(known_scope_classes.get(normalized, 'blank' if not normalized else 'other'))
    if request.get('silent') is True:
        silent_label='true'
    elif request.get('silent') is False:
        silent_label='false'
    elif 'silent' not in request:
        silent_label='missing'
    else:
        silent_label=type(request.get('silent')).__name__
    failures=inert_final_pending_failures(state, context, reviewed_target)
    return (
        f"failures={'+'.join(failures) or 'none'} fields={len(request)} "
        f"scope_keys={len(scope_keys)} scopes_present={'scopes' in request} "
        f"requested_scopes_present={'requestedScopes' in request} "
        f"scopes_type={type(raw_scopes).__name__} scopes_count={scope_count} "
        f"scope_classes={'+'.join(scope_classes) or 'none'} silent={silent_label}"
    )
def verify_inert_final_pending_classifier():
    context={'key': 'reviewed-public-key', 'scopes': final_scopes, 'token': 'rotated-token'}
    reviewed={
        'requestId': 'reviewed-upgrade',
        'deviceId': expected_device_id,
        'publicKey': context['key'],
        'clientId': 'cli',
        'clientMode': 'cli',
        'baselineScopes': ['operator.pairing'],
        'baselineTokenHash': 'a' * 64,
        'requestedScopes': ['operator.read', 'operator.write'],
        'expectedScopes': sorted(final_scopes),
    }
    request={
        'requestId': 'inert-request',
        'deviceId': expected_device_id,
        'publicKey': context['key'],
        'clientId': 'cli',
        'clientMode': 'cli',
        'role': 'operator',
        'roles': ['operator'],
        'isRepair': True,
        'scopes': [],
        'silent': True,
    }
    valid={'pending': {'inert-request': request}}
    if not inert_final_pending(valid, context, reviewed):
        fail('inert final-state classifier rejected its reviewed shape')
    with_unrelated={'pending': {**valid['pending'], 'unrelated-request': {
        **request, 'requestId': 'unrelated-request', 'deviceId': 'other-device',
    }}}
    if not inert_final_pending(with_unrelated, context, reviewed):
        fail('inert final-state classifier rejected an unrelated pending device')
    def changed_request(changes):
        return {'pending': {'inert-request': {**request, **changes}}}
    missing_scopes={key: value for key, value in request.items() if key != 'scopes'}
    rejected=[
        ([], context, reviewed),
        (valid, [], reviewed),
        (valid, context, []),
        ({'pending': []}, context, reviewed),
        ({'pending': {}}, context, reviewed),
        ({'pending': {'wrong-key': request}}, context, reviewed),
        ({'pending': {**valid['pending'], 'extra-request': {
            **request, 'requestId': 'extra-request',
        }}}, context, reviewed),
        ({'pending': {**valid['pending'], 'unrelated-key': {
            **request, 'deviceId': 'other-device',
        }}}, context, reviewed),
        ({'pending': {'inert-request': missing_scopes}}, context, reviewed),
        (changed_request({'scopes': ['operator.read']}), context, reviewed),
        (changed_request({'scopes': ['operator.pairing'], 'silent': False}), context, reviewed),
        (changed_request({'scopes': 'operator.read'}), context, reviewed),
        (changed_request({'requestedScopes': []}), context, reviewed),
        (changed_request({'unknownScopes': []}), context, reviewed),
        (changed_request({'authToken': 'unexpected'}), context, reviewed),
        (changed_request({'silent': False}), context, reviewed),
        (changed_request({'deviceId': 'other-device'}), context, reviewed),
        (changed_request({'publicKey': 'other-public-key'}), context, reviewed),
        (changed_request({'clientId': 'other-client'}), context, reviewed),
        (changed_request({'roles': ['operator', 'node']}), context, reviewed),
        (changed_request({'role': 'node'}), context, reviewed),
        (changed_request({'isRepair': False}), context, reviewed),
        (valid, context, {}),
        (valid, context, {**reviewed, 'requestId': 'inert-request'}),
        (valid, context, {**reviewed, 'baselineScopes': []}),
        (valid, context, {**reviewed, 'requestedScopes': ['operator.read']}),
        (valid, context, {**reviewed, 'expectedScopes': ['operator.pairing']}),
        (valid, context, {**reviewed,
            'baselineTokenHash': hashlib.sha256(context['token'].encode()).hexdigest()}),
        (valid, context, {**reviewed, 'publicKey': 'other-public-key'}),
        (valid, {**context, 'scopes': {'operator.pairing'}}, reviewed),
    ]
    if any(inert_final_pending(state, candidate_context, candidate_target)
            for state, candidate_context, candidate_target in rejected):
        fail('inert final-state classifier accepted a drifted shape')
verify_inert_final_pending_classifier()
def converged(state):
    expected_key=target.get('publicKey') if target else ''
    context=paired_context(state, expected_key)
    if (context is None or context['scopes'] != final_scopes or not auth_matches(state, context)):
        return None
    pending=same_device_pending(state)
    if pending and not inert_final_pending(state, context, target):
        return None
    return context
def sync_auth(context):
    auth_path=root / 'identity' / 'device-auth.json'
    auth_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name=tempfile.mkstemp(prefix='.device-auth.', dir=auth_path.parent)
    tmp=Path(tmp_name)
    try:
        auth={'version': 1, 'deviceId': expected_device_id, 'tokens': {'operator': {
            'token': context['token'],
            'role': 'operator',
            'scopes': sorted(final_scopes),
            'updatedAtMs': (
                context['operator'].get('updatedAtMs')
                or context['operator'].get('rotatedAtMs')
                or context['operator'].get('createdAtMs')
            ),
        }}}
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(json.dumps(auth, indent=2, sort_keys=True) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o600)
        os.replace(tmp, auth_path)
    finally:
        tmp.unlink(missing_ok=True)
def converge_after_sync(state):
    complete=converged(state)
    if complete is not None: return complete
    if same_device_pending(state): return None
    expected_key=target.get('publicKey') if target else ''
    context=paired_context(state, expected_key)
    if context is None or context['scopes'] != final_scopes: return None
    sync_auth(context)
    return converged(load_state())
def safe_state_summary(state):
    expected_key=target.get('publicKey') if target else snapshot.get('publicKey', '')
    context=paired_context(state, expected_key)
    if context is None:
        paired_label='invalid'
        auth_label='unverified'
    else:
        paired_label='final' if context['scopes'] == final_scopes else 'baseline-or-other'
        auth_label='match' if auth_matches(state, context) else 'mismatch'
    return f'paired={paired_label} auth={auth_label} pending={len(state["pending"])} same_device_pending={len(same_device_pending(state))}'

state=load_state()
complete=converge_after_sync(state)
if complete is not None:
    print(f"CONVERGED {expected_device_id}")
    raise SystemExit(0)
if mode == 'prove':
    fail('device approval state is not canonically converged')

if mode == 'prepare':
    original_want=want
    request=None
    for poll in range(SETTLE_ATTEMPTS):
        state=load_state()
        complete=converge_after_sync(state)
        if complete is not None:
            print(f"CONVERGED {expected_device_id}")
            raise SystemExit(0)
        request=exact_request(state, want)
        if isinstance(request, dict): break
        same_device=same_device_pending(state)
        if len(same_device) > 1:
            fail('multiple same-device requests appeared before approval')
        if len(same_device) == 1:
            replacement=same_device[0].get('requestId')
            if (not isinstance(replacement, str) or not replacement
                    or replacement != replacement.strip()
                    or any(character.isspace() for character in replacement)):
                fail('replacement request has no exact id')
            want=replacement
            request=same_device[0]
            break
        if poll + 1 < SETTLE_ATTEMPTS: time.sleep(SETTLE_POLL_SECONDS)
    same_device=same_device_pending(state)
    if (not want or any(character.isspace() for character in want)
            or not isinstance(request, dict) or request.get('requestId') != want
            or request.get('deviceId') != expected_device_id
            or len(same_device) != 1 or same_device[0] is not request
            or request.get('clientId') != 'cli' or request.get('clientMode') != 'cli'
            or request.get('isRepair') is not True or roles(request) != {'operator'}):
        fail('refusing missing or non-exact CLI operator repair request')
    public_key=request.get('publicKey')
    if not isinstance(public_key, str) or public_key != public_key.strip() or not public_key:
        fail('repair request has no exact public key')
    context=paired_context(state, public_key)
    requested_views=bounded_scope_views(request, ('scopes','requestedScopes'))
    requested=scopes(request, ('scopes','requestedScopes'))
    target_expected=target.get('expectedScopes') if isinstance(target.get('expectedScopes'), list) else []
    successor_closures=[]
    for view in requested_views or []:
        closure=set(view)
        if {'operator.read','operator.write'}.intersection(closure):
            closure.add('operator.pairing')
        successor_closures.append(closure)
    is_upgrade=(
        context is not None and requested is not None
        and context['scopes'] != final_scopes
        and bool({'operator.read','operator.write'}.intersection(requested))
        and context['scopes'] | requested == final_scopes
    )
    is_final_successor=(
        bool(target) and context is not None and requested_views is not None
        and context['scopes'] == final_scopes
        and all(closure == final_scopes for closure in successor_closures)
        and set(target_expected) == final_scopes
    )
    if (context is None or not auth_matches(state, context)
            or not (is_upgrade or is_final_successor)):
        def scope_sets_label(views):
            if views is None: return 'invalid'
            return '|'.join('+'.join(sorted(view)) for view in views)
        context_label='missing' if context is None else scope_sets_label([context['scopes']])
        auth_ok=context is not None and auth_matches(state, context)
        inert_label=inert_final_pending_diagnostic(state, context or {}, target)
        fail(
            'request is not the exact canonical operator scope upgrade; '
            f'context={context_label} auth_match={auth_ok} '
            f'views={scope_sets_label(requested_views)} '
            f'closures={scope_sets_label(successor_closures)} '
            f'target={bool(target)} target_expected_final={set(target_expected) == final_scopes} '
            f'upgrade={is_upgrade} final_successor={is_final_successor} inert={inert_label}'
        )
    candidate_requested=final_scopes if is_final_successor else requested
    candidate={
        'requestId': want,
        'deviceId': expected_device_id,
        'publicKey': context['key'],
        'clientId': 'cli',
        'clientMode': 'cli',
        'baselineScopes': sorted(context['scopes']),
        'baselineTokenHash': hashlib.sha256(context['token'].encode()).hexdigest(),
        'requestedScopes': sorted(candidate_requested),
        'expectedScopes': sorted(final_scopes),
    }
    if target:
        exact=('deviceId','publicKey','clientId','clientMode','expectedScopes')
        if not is_final_successor:
            exact += ('requestedScopes','baselineScopes','baselineTokenHash')
        if any(candidate.get(key) != target.get(key) for key in exact):
            fail('replacement request does not match the reviewed scope upgrade')
    status='CANDIDATE' if want == original_want else 'RETRY'
    print(f'{status} {want} ' + json.dumps(candidate, sort_keys=True))
    raise SystemExit(0)

if mode != 'observe' or not snapshot:
    fail('invalid approval state validation mode')

last_state=state
for poll in range(SETTLE_ATTEMPTS):
    state=load_state()
    complete=converge_after_sync(state)
    if complete is not None:
        print(f"CONVERGED {expected_device_id}")
        raise SystemExit(0)
    pending=same_device_pending(state)
    baseline=paired_context(state, snapshot.get('publicKey', ''))
    unchanged=(
        baseline is not None
        and baseline['scopes'] == set(snapshot.get('baselineScopes') or [])
        and hashlib.sha256(baseline['token'].encode()).hexdigest() == snapshot.get('baselineTokenHash')
        and auth_matches(state, baseline)
    )
    final_successor_hint=(
        bool(target) and baseline is not None
        and baseline['scopes'] == final_scopes
        and auth_matches(state, baseline)
        and len(pending) == 1
    )
    if final_successor_hint:
        replacement=pending[0].get('requestId')
        if (isinstance(replacement, str) and replacement == replacement.strip()
                and replacement and not any(character.isspace() for character in replacement)
                and replacement != want):
            print(f"RETRY {replacement}")
            raise SystemExit(0)
    if unchanged and len(pending) > 1:
        fail('multiple same-device replacement requests appeared')
    if unchanged and len(pending) == 1:
        replacement=pending[0].get('requestId')
        if isinstance(replacement, str) and replacement and replacement != want:
            print(f"RETRY {replacement}")
            raise SystemExit(0)
    last_state=state
    if poll + 1 < SETTLE_ATTEMPTS: time.sleep(SETTLE_POLL_SECONDS)

baseline=paired_context(last_state, snapshot.get('publicKey', ''))
pending=same_device_pending(last_state)
unchanged=(
    baseline is not None
    and baseline['scopes'] == set(snapshot.get('baselineScopes') or [])
    and hashlib.sha256(baseline['token'].encode()).hexdigest() == snapshot.get('baselineTokenHash')
    and auth_matches(last_state, baseline)
)
if unchanged and len(pending) == 1:
    replacement=pending[0].get('requestId')
    if isinstance(replacement, str) and replacement:
        print(f"RETRY {replacement}")
        raise SystemExit(0)
fail('approval did not settle: ' + safe_state_summary(last_state))
PY
}

approval_target_json=
approve_request() {
  local request_id="$1" expected_device_id="$2" approve_output approve_rc prepare_output post_output prepared snapshot_json
  local attempt=1 id_count=0 original_request_id seen_request_ids= target_json=
  while [ "$attempt" -le 3 ]; do
    original_request_id="$request_id"
    if ! prepare_output="$(approval_state prepare "$request_id" "$expected_device_id" 0 3<<<"$target_json" 4</dev/null 5</dev/null)"; then
      return 1
    fi
    case "$prepare_output" in
      "CONVERGED "*)
        approval_target_json="$target_json"
        echo "ISSUE_4462_APPROVAL_CONVERGED attempt=$attempt request=\${request_id:-consumed} device=\${prepare_output#CONVERGED }"
        return 0
        ;;
      "CANDIDATE "*|"RETRY "*)
        prepared="\${prepare_output#* }"
        request_id="\${prepared%% *}"
        snapshot_json="\${prepared#* }"
        ;;
      *) echo "INVALID_APPROVAL_PREPARE_RESULT" >&2; return 1 ;;
    esac
    if [ -n "$original_request_id" ]; then
      case ",$seen_request_ids," in
        *",$original_request_id,"*) unset snapshot_json; echo "REPEATED_SCOPE_REQUEST=$original_request_id" >&2; return 1 ;;
      esac
      if [ "$id_count" -ge 3 ]; then
        unset snapshot_json
        echo "SCOPE_APPROVAL_ID_LIMIT_EXCEEDED next=$original_request_id" >&2
        return 1
      fi
      seen_request_ids="\${seen_request_ids:+$seen_request_ids,}$original_request_id"
      id_count=$((id_count + 1))
    fi
    if [ "$request_id" != "$original_request_id" ]; then
      case ",$seen_request_ids," in
        *",$request_id,"*) unset snapshot_json; echo "REPEATED_SCOPE_REQUEST=$request_id" >&2; return 1 ;;
      esac
      if [ "$id_count" -ge 3 ]; then
        unset snapshot_json
        echo "SCOPE_APPROVAL_ID_LIMIT_EXCEEDED next=$request_id" >&2
        return 1
      fi
      seen_request_ids="\${seen_request_ids:+$seen_request_ids,}$request_id"
      id_count=$((id_count + 1))
    fi
    if [ -z "$target_json" ]; then target_json="$snapshot_json"; fi
    echo "ISSUE_4462_STAGE=approve-scope-upgrade attempt=$attempt request=$request_id"
    echo "ISSUE_4462_APPROVAL_CONTEXT=validated-repair-cli"
    approve_rc=0
    set +e
    approve_output="$(openclaw devices approve "$request_id" --json 2>&1)"
    approve_rc=$?
    set -e
    set +e
    post_output="$(approval_state observe "$request_id" "$expected_device_id" "$approve_rc" \
      3<<<"$target_json" 4<<<"$snapshot_json" 5<<<"$approve_output")"
    post_rc=$?
    set -e
    unset approve_output snapshot_json
    if [ "$post_rc" -ne 0 ]; then return 1; fi
    case "$post_output" in
      "CONVERGED "*)
        approval_target_json="$target_json"
        echo "ISSUE_4462_APPROVAL_CONVERGED attempt=$attempt request=$request_id device=\${post_output#CONVERGED }"
        return 0
        ;;
      "RETRY "*) request_id="\${post_output#RETRY }" ;;
      *) echo "INVALID_APPROVAL_OBSERVE_RESULT" >&2; return 1 ;;
    esac
    if [ "$attempt" -ge 3 ]; then
      echo "SCOPE_APPROVAL_RETRY_EXHAUSTED next=$request_id" >&2
      return 1
    fi
    attempt=$((attempt + 1))
  done
  echo "SCOPE_APPROVAL_RETRY_EXHAUSTED" >&2
  return 1
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
  paired_device_scope=pairing
  seeded_initial=1
else
  paired_device_record="$(printf '%s' "$state" | select_paired_cli_device 2>/dev/null || true)"
  paired_device_id="\${paired_device_record%% *}"
  paired_device_scope="\${paired_device_record#* }"
fi
if [ -z "$paired_device_id" ] || { [ "$paired_device_scope" != pairing ] && [ "$paired_device_scope" != write ]; }; then
  echo "NO_INITIAL_PAIRED_CLI_DEVICE rc=$initial_list_rc" >&2
  exit 5
fi
if [ "$paired_device_scope" = write ]; then
  echo "ISSUE_4462_STAGE=rebootstrap-write-cli-to-pairing"
  paired_device_record="$(rebootstrap_write_cli_to_pairing "$paired_device_id")"
  paired_device_id="\${paired_device_record%% *}"
  paired_device_scope="\${paired_device_record#* }"
  if [ -z "$paired_device_id" ] || [ "$paired_device_scope" != pairing ]; then
    echo "PAIRING_REBOOTSTRAP_DID_NOT_CONVERGE" >&2
    exit 5
  fi
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
fi

approve_request "$request_id" "$paired_device_id"
proof_output="$(approval_state prove "" "$paired_device_id" 0 3<<<"$approval_target_json" 4</dev/null 5</dev/null)"
case "$proof_output" in
  "CONVERGED "*) final_device="\${proof_output#CONVERGED }" ;;
  *) echo "INVALID_FINAL_APPROVAL_PROOF" >&2; exit 9 ;;
esac

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
echo "ISSUE_4462_SCOPE_UPGRADE_OK device=$final_device request=\${request_id:-consumed}"
`;
}

test("keeps issue 4462 scope-upgrade approval on the gateway path without an admin leak", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, secrets, skip }) => {
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  await artifacts.target.declare({
    id: "issue-4462-scope-upgrade-approval",
    sandboxName: SANDBOX_NAME,
    contracts: [
      "install.sh creates a real OpenClaw sandbox",
      "the exact first three host-side nemoclaw sandbox exec openclaw agent turns from issue 4504 stay on the gateway path",
      "the issue 5324 nemoclaw <name> exec transport reaches the local OpenClaw CLI pairing path",
      "the prepared connect shell keeps the injected gateway URL private while retaining port and token",
      "operator.admin remains pending until a reviewed devices approve, cron add retry, and cron run enqueue",
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

  const captureFreshAgentGatewaySnapshot = async (
    phase: string,
    minimumGatewayRuns: number,
  ): Promise<FreshAgentGatewaySnapshot> => {
    const result = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-lc",
        'printf \'%s\' "$1" | base64 -d | python3 - "$2"',
        "fresh-agent-gateway-snapshot",
        FRESH_AGENT_GATEWAY_SNAPSHOT_B64,
        String(minimumGatewayRuns),
      ],
      {
        artifactName: phase,
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    expect(result.exitCode, resultText(result)).toBe(0);
    const snapshot = JSON.parse(result.stdout.trim()) as FreshAgentGatewaySnapshot;
    await artifacts.writeJson(`${phase}.json`, snapshot);
    return snapshot;
  };

  let freshSnapshot = await captureFreshAgentGatewaySnapshot("phase-2-fresh-state-0", 0);
  expect(freshSnapshot.deviceId).not.toBe("");
  expect(freshSnapshot.publicKey).not.toBe("");
  expect(freshSnapshot.pairedCliCount).toBe(1);
  expect(freshSnapshot.matchingPairedCount).toBe(1);
  expect(freshSnapshot.pendingCount).toBe(0);
  expect(freshSnapshot.sameDevicePendingCount).toBe(0);
  expect(freshSnapshot.activeOperatorTokenCount).toBe(1);
  expect(freshSnapshot.deviceScopes).toEqual(["operator.pairing", "operator.write"]);
  expect(freshSnapshot.approvedScopes).toEqual(["operator.pairing", "operator.write"]);
  expect(freshSnapshot.activeOperatorTokenScopes).toEqual([
    "operator.pairing",
    "operator.read",
    "operator.write",
  ]);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const sessionId = `gpu-${attempt}-${Math.floor(Date.now() / 1000)}`;
    const freshAgent = await host.command(
      process.execPath,
      [
        CLI_ENTRYPOINT,
        "sandbox",
        "exec",
        SANDBOX_NAME,
        "--timeout",
        "60",
        "--",
        "openclaw",
        "agent",
        "--agent",
        "main",
        "-m",
        `hi #${attempt}`,
        "--session-id",
        sessionId,
      ],
      {
        artifactName: `phase-2-fresh-agent-${attempt}`,
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      },
    );
    const freshAgentOutput = resultText(freshAgent);
    await artifacts.writeText(`phase-2-fresh-agent-${attempt}.txt`, freshAgentOutput);
    expect(freshAgent.exitCode, freshAgentOutput).toBe(0);
    expect(freshAgentOutput).not.toMatch(
      /EMBEDDED FALLBACK|gateway connect failed|scope upgrade pending approval|device pairing required|pairing required|fallbackFrom[": ]+gateway|transport[": ]+embedded/i,
    );
    expect(freshAgent.stdout.trim(), freshAgentOutput).not.toBe("");

    const nextSnapshot = await captureFreshAgentGatewaySnapshot(
      `phase-2-fresh-state-${attempt}`,
      freshSnapshot.gatewayCompletedRuns + 1,
    );
    expect(nextSnapshot.deviceId).toBe(freshSnapshot.deviceId);
    expect(nextSnapshot.publicKey).toBe(freshSnapshot.publicKey);
    expect(nextSnapshot.pairedCliCount).toBe(1);
    expect(nextSnapshot.matchingPairedCount).toBe(1);
    expect(nextSnapshot.pendingCount).toBe(0);
    expect(nextSnapshot.sameDevicePendingCount).toBe(0);
    expect(nextSnapshot.activeOperatorTokenCount).toBe(1);
    expect(nextSnapshot.deviceScopes).toEqual(freshSnapshot.deviceScopes);
    expect(nextSnapshot.approvedScopes).toEqual(freshSnapshot.approvedScopes);
    expect(nextSnapshot.activeOperatorTokenScopes).toEqual(freshSnapshot.activeOperatorTokenScopes);
    expect(nextSnapshot.gatewayCompletedRuns).toBe(freshSnapshot.gatewayCompletedRuns + 1);
    freshSnapshot = nextSnapshot;
  }

  // Preserve the transactional read/write upgrade proof before deliberately
  // broadening this same CLI device with the manual admin approval below.
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
      artifactName: "phase-3-scope-upgrade-approval",
      env: env(),
      redactionValues: [apiKey],
      timeoutMs: 12 * 60_000,
    },
  );
  expect(probe.exitCode, resultText(probe)).toBe(0);
  expect(resultText(probe)).toContain("ISSUE_4462_SCOPE_UPGRADE_OK");

  // #5324 command coverage (PRA-3): the operator scope-upgrade / approval
  // boundary is scope-keyed and command-agnostic, not per-command. Automatic
  // approval is bounded to {operator.pairing, operator.read, operator.write}
  // (scripts/lib/openclaw_device_approval_policy.py `ALLOWED_SCOPES`), while
  // operator.admin always requires a reviewed `devices approve`. The pending
  // request is selected by its requested scope + CLI/operator role, never by
  // command name (ADMIN_REQUEST_SELECTOR_PY in issue-4462-admin-approval-helper.ts).
  // Every non-TUI OpenClaw command (`agent`, `cron add`, `cron run`, `exec`)
  // reaches the gateway through the same device-token operator client and is
  // gated purely by the scope it requests. This test exercises both tiers on
  // that single shared boundary: operator.write via the gateway-backed `agent`
  // turns above, and operator.admin via the `cron add` trigger + manual
  // approval below. `cron run` and `exec` cannot follow a different approval
  // path — whichever tier they request is one of the two already proven here,
  // so no separate per-command evidence is required to close #5324.
  const cronName = `issue-5324-admin-${Date.now()}-${process.pid}`;
  // #5324's `exec` is NemoClaw's host transport, not an OpenClaw CLI
  // subcommand (the pinned OpenClaw 2026.6.10 command catalog has none).
  // Use the issue's documented `nemoclaw <name> exec -- openclaw ...` form
  // for its cron reproduction while preserving #4504's exact command above.
  const cronTrigger = await host.command(
    process.execPath,
    [
      CLI_ENTRYPOINT,
      SANDBOX_NAME,
      "exec",
      "--timeout",
      "60",
      "--",
      "openclaw",
      "cron",
      "add",
      "--name",
      cronName,
      "--every",
      "2h",
      "--agent",
      "main",
      "--session",
      "isolated",
      "--message",
      "hello",
    ],
    {
      artifactName: "phase-4-trigger-admin-cron",
      env: env(),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    },
  );
  const cronTriggerOutput = resultText(cronTrigger);
  expect(cronTrigger.exitCode, cronTriggerOutput).not.toBe(0);
  expect(cronTriggerOutput).toMatch(
    /operator\.admin|scope upgrade pending approval|device pairing required|pairing required|requestId/i,
  );
  const adminRequestId = extractPendingRequestId(cronTriggerOutput);

  const connectProbe = await host.command(
    process.execPath,
    [CLI_ENTRYPOINT, SANDBOX_NAME, "connect", "--probe-only"],
    {
      artifactName: "phase-5-connect-auto-pair-probe",
      env: env(),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    },
  );
  expect(connectProbe.exitCode, resultText(connectProbe)).toBe(0);

  const adminConnect = await host.command(
    "bash",
    [
      "-lc",
      adminApprovalConnectScript(
        host.commandPath,
        SANDBOX_NAME,
        adminRequestId,
        cronName,
        `issue-5324-connect-${Date.now()}-${process.pid}`,
      ),
    ],
    {
      artifactName: "phase-6-connect-admin-approval",
      env: env(),
      redactionValues: [apiKey],
      timeoutMs: 4 * 60_000,
    },
  );
  const adminConnectOutput = resultText(adminConnect);
  expect(adminConnect.exitCode, adminConnectOutput).toBe(0);
  expect(adminConnectOutput).toContain("ISSUE_5324_ADMIN_APPROVAL_OK");

  await cleanup(host, sandbox);
  await artifacts.target.complete({
    id: "issue-4462-scope-upgrade-approval",
    status: "passed",
  });
});
