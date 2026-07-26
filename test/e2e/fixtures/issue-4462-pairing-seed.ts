// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Python source shared by the live #4462 sandbox probe and its executable
 * support test. The live probe appends `run_cli()` after embedding this source.
 */
export const ISSUE_4462_PAIRING_SEED_PY = String.raw`
import base64
import hashlib
import json
import os
import secrets
import sys
import time
from pathlib import Path

ALLOWED_SCOPES = {'operator.pairing', 'operator.read', 'operator.write'}


class PairingSeedError(Exception):
    pass


def norm(value):
    return str(value or '').strip()


def load_json(path):
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    return value if isinstance(value, dict) else {}


def stage_json(path, value, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    fd = os.open(tmp, flags, mode)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
        os.fchmod(handle.fileno(), mode)
    return tmp


def roles(value):
    result = {norm(role) for role in (value.get('roles') or []) if norm(role)}
    if norm(value.get('role')):
        result.add(norm(value.get('role')))
    return result


def identity_public_key(value):
    direct = norm(value.get('publicKey'))
    if direct:
        return direct
    pem = norm(value.get('publicKeyPem'))
    if not pem:
        return ''
    body = ''.join(line.strip() for line in pem.splitlines() if not line.startswith('-----'))
    try:
        der = base64.b64decode(body, validate=True)
    except Exception:
        return ''
    prefix = bytes.fromhex('302a300506032b6570032100')
    if len(der) != len(prefix) + 32 or not der.startswith(prefix):
        return ''
    return base64.urlsafe_b64encode(der[len(prefix):]).decode('ascii').rstrip('=')


def requested_scopes(value):
    views = []
    for key in ('scopes', 'requestedScopes'):
        if key not in value:
            continue
        if not isinstance(value[key], list):
            return None
        view = {norm(scope) for scope in value[key] if norm(scope)}
        if 'operator.write' in view:
            view.add('operator.read')
        views.append(view)
    if not views or any(not view or not view.issubset(ALLOWED_SCOPES) for view in views):
        return None
    if any(view != views[0] for view in views[1:]):
        return None
    return views[0]


def is_compatible_initial_request(value, device_id, public_key):
    scopes = requested_scopes(value)
    return bool(
        norm(value.get('requestId'))
        and norm(value.get('deviceId')) == device_id
        and norm(value.get('publicKey')) == public_key
        and value.get('clientId') == 'cli'
        and value.get('clientMode') == 'cli'
        and roles(value) == {'operator'}
        and scopes is not None
        and 'operator.pairing' in scopes
    )


def is_safe_repair(value, device_id, public_key):
    scopes = requested_scopes(value)
    return bool(
        value.get('isRepair') is True
        and norm(value.get('requestId'))
        and norm(value.get('deviceId')) == device_id
        and norm(value.get('publicKey')) == public_key
        and value.get('clientId') == 'cli'
        and value.get('clientMode') == 'cli'
        and roles(value) == {'operator'}
        and scopes is not None
    )


def default_token_factory():
    return secrets.token_urlsafe(32)


def default_now_ms():
    return int(time.time() * 1000)


def seed_initial_pairing_request(
    root,
    requested_id,
    *,
    replace_file=os.replace,
    token_factory=default_token_factory,
    now_ms=default_now_ms,
    seed_token_path=None,
    gateway_token=None,
):
    root = Path(root)
    pending_path = root / 'devices' / 'pending.json'
    paired_path = root / 'devices' / 'paired.json'
    identity_path = root / 'identity' / 'device.json'
    auth_path = root / 'identity' / 'device-auth.json'
    seed_token_path = Path(seed_token_path or '/tmp/issue4462-seed-token.sha256')
    gateway_token = norm(
        os.environ.get('OPENCLAW_GATEWAY_TOKEN') if gateway_token is None else gateway_token
    )

    identity = load_json(identity_path)
    device_id = norm(identity.get('deviceId'))
    public_key = identity_public_key(identity)
    if not device_id or not public_key:
        raise PairingSeedError('persisted CLI identity is incomplete')
    try:
        public_key_raw = base64.urlsafe_b64decode(public_key + '=' * (-len(public_key) % 4))
    except Exception as error:
        raise PairingSeedError('persisted CLI public key is malformed') from error
    if len(public_key_raw) != 32 or hashlib.sha256(public_key_raw).hexdigest() != device_id:
        raise PairingSeedError('persisted CLI identity key does not match its device id')

    pending = load_json(pending_path)
    paired = load_json(paired_path)
    if device_id in paired or any(
        isinstance(item, dict) and norm(item.get('deviceId')) == device_id
        for item in paired.values()
    ):
        raise PairingSeedError('refusing to seed over an existing paired CLI device')

    same_device = [
        (key, item)
        for key, item in pending.items()
        if isinstance(item, dict) and norm(item.get('deviceId')) == device_id
    ]
    if not same_device or any(
        not is_compatible_initial_request(item, device_id, public_key)
        for _, item in same_device
    ):
        raise PairingSeedError('pending state contains no exclusively compatible CLI pairing request')

    selected = next(
        ((key, item) for key, item in same_device if norm(item.get('requestId')) == requested_id),
        None,
    )
    if selected is None:
        selected = max(same_device, key=lambda pair: pair[1].get('ts') or 0)
    _, request = selected

    token = token_factory()
    if not token or token == gateway_token:
        raise PairingSeedError('temporary device token generation failed')
    seed_token_path.parent.mkdir(parents=True, exist_ok=True)
    seed_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, 'O_NOFOLLOW'):
        seed_flags |= os.O_NOFOLLOW
    seed_fd = os.open(seed_token_path, seed_flags, 0o600)
    with os.fdopen(seed_fd, 'w', encoding='utf-8') as handle:
        handle.write(hashlib.sha256(token.encode('utf-8')).hexdigest())
        handle.flush()
        os.fsync(handle.fileno())
        os.fchmod(handle.fileno(), 0o600)

    approved = ['operator.pairing']
    now = now_ms()
    operator_token = {
        'token': token,
        'role': 'operator',
        'scopes': approved,
        'createdAtMs': now,
    }
    device = {
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
    device = {key: value for key, value in device.items() if value is not None}
    for key, _ in same_device:
        pending.pop(key, None)
    paired[device_id] = device
    auth = {
        'version': 1,
        'deviceId': device_id,
        'tokens': {
            'operator': {
                'token': token,
                'role': 'operator',
                'scopes': approved,
                'updatedAtMs': now,
            }
        },
    }

    staged = []
    try:
        paired_tmp = stage_json(paired_path, paired, 0o600)
        staged.append(paired_tmp)
        auth_tmp = stage_json(auth_path, auth, 0o600)
        staged.append(auth_tmp)
        pending_tmp = stage_json(pending_path, pending, 0o600)
        staged.append(pending_tmp)
        # A live nemoclaw-start poll can create a pairing request between these
        # writes. Make the paired baseline and credential visible before the
        # old pending request is cleared so any concurrent request is a repair.
        replace_file(paired_tmp, paired_path)
        replace_file(auth_tmp, auth_path)
        replace_file(pending_tmp, pending_path)
    finally:
        for tmp in staged:
            tmp.unlink(missing_ok=True)

    remaining_same_device = [
        item
        for item in load_json(pending_path).values()
        if isinstance(item, dict) and norm(item.get('deviceId')) == device_id
    ]
    if any(not is_safe_repair(item, device_id, public_key) for item in remaining_same_device):
        raise PairingSeedError('temporary pairing seed left an unsafe same-device request pending')

    seeded = load_json(paired_path).get(device_id)
    seeded_auth = load_json(auth_path)
    if (
        not isinstance(seeded, dict)
        or norm(seeded.get('publicKey')) != public_key
        or roles(seeded) != {'operator'}
        or seeded.get('scopes') != approved
        or seeded.get('approvedScopes') != approved
        or seeded.get('tokens', {}).get('operator', {}).get('token') != token
        or seeded_auth.get('deviceId') != device_id
        or seeded_auth.get('tokens', {}).get('operator', {}).get('token') != token
    ):
        raise PairingSeedError('temporary pairing seed did not persist the reviewed low-scope state')
    return device_id


def run_cli(argv=None, environ=None):
    argv = sys.argv if argv is None else argv
    environ = os.environ if environ is None else environ
    if len(argv) != 2 or not norm(argv[1]):
        raise SystemExit('usage: issue-4462-pairing-seed <request-id>')
    try:
        device_id = seed_initial_pairing_request(
            Path(environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw'),
            argv[1],
        )
    except PairingSeedError as error:
        raise SystemExit(str(error)) from None
    print(device_id)
`;
