// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { ISSUE_4462_PAIRING_SEED_PY } from "../fixtures/issue-4462-pairing-seed.ts";

const BEHAVIOR_HARNESS_PY = String.raw`
import base64
import hashlib
import json
import os
import tempfile
from pathlib import Path


RAW_PUBLIC_KEY = bytes(range(32))
PUBLIC_KEY = base64.urlsafe_b64encode(RAW_PUBLIC_KEY).decode('ascii').rstrip('=')
DEVICE_ID = hashlib.sha256(RAW_PUBLIC_KEY).hexdigest()
DER_PREFIX = bytes.fromhex('302a300506032b6570032100')
PUBLIC_KEY_PEM = (
    '-----BEGIN PUBLIC KEY-----\n'
    + base64.b64encode(DER_PREFIX + RAW_PUBLIC_KEY).decode('ascii')
    + '\n-----END PUBLIC KEY-----\n'
)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def prepare_fixture(root):
    identity_path = root / 'identity' / 'device.json'
    pending_path = root / 'devices' / 'pending.json'
    paired_path = root / 'devices' / 'paired.json'
    auth_path = root / 'identity' / 'device-auth.json'
    write_json(identity_path, {
        'version': 1,
        'deviceId': DEVICE_ID,
        'publicKeyPem': PUBLIC_KEY_PEM,
    })
    write_json(pending_path, {
        'initial': {
            'requestId': 'initial',
            'deviceId': DEVICE_ID,
            'publicKey': PUBLIC_KEY,
            'clientId': 'cli',
            'clientMode': 'cli',
            'role': 'operator',
            'roles': ['operator'],
            'scopes': ['operator.pairing'],
            'ts': 1,
        },
        'unrelated': {
            'requestId': 'unrelated',
            'deviceId': 'other-device',
            'publicKey': 'other-key',
        },
    })
    return pending_path, paired_path, auth_path


def repair_request(**overrides):
    value = {
        'requestId': 'concurrent-repair',
        'deviceId': DEVICE_ID,
        'publicKey': PUBLIC_KEY,
        'clientId': 'cli',
        'clientMode': 'cli',
        'role': 'operator',
        'roles': ['operator'],
        'scopes': ['operator.write'],
        'isRepair': True,
        'ts': 2,
    }
    value.update(overrides)
    return value


def run_publication_order_proof():
    with tempfile.TemporaryDirectory(prefix='nemoclaw-4462-order-') as tmp:
        root = Path(tmp)
        pending_path, paired_path, auth_path = prepare_fixture(root)
        observed = []

        def replace_and_observe(source, destination):
            os.replace(source, destination)
            destination = Path(destination)
            observed.append(destination.name)
            if destination == paired_path:
                assert DEVICE_ID in read_json(paired_path)
                assert 'initial' in read_json(pending_path)
                assert not auth_path.exists()
            elif destination == auth_path:
                assert DEVICE_ID in read_json(paired_path)
                assert read_json(auth_path)['deviceId'] == DEVICE_ID
                assert 'initial' in read_json(pending_path)
            elif destination == pending_path:
                assert DEVICE_ID in read_json(paired_path)
                assert read_json(auth_path)['deviceId'] == DEVICE_ID
                pending = read_json(pending_path)
                assert 'initial' not in pending
                pending['concurrent-repair'] = repair_request()
                write_json(pending_path, pending)

        result = seed_initial_pairing_request(
            root,
            'initial',
            replace_file=replace_and_observe,
            token_factory=lambda: 'fixture-device-token',
            now_ms=lambda: 1234,
            seed_token_path=root / 'seed-token.sha256',
            gateway_token='fixture-gateway-token',
        )
        assert result == DEVICE_ID
        assert observed == ['paired.json', 'device-auth.json', 'pending.json']
        paired = read_json(paired_path)[DEVICE_ID]
        auth = read_json(auth_path)
        pending = read_json(pending_path)
        assert paired['tokens']['operator']['token'] == 'fixture-device-token'
        assert auth['tokens']['operator']['token'] == 'fixture-device-token'
        assert pending['concurrent-repair']['isRepair'] is True
        assert 'unrelated' in pending


def run_unsafe_concurrency_proof():
    unsafe_overrides = [
        {'isRepair': False},
        {'clientId': ' cli '},
        {'scopes': ['operator.admin']},
    ]
    for index, overrides in enumerate(unsafe_overrides):
        with tempfile.TemporaryDirectory(prefix=f'nemoclaw-4462-unsafe-{index}-') as tmp:
            root = Path(tmp)
            pending_path, _, _ = prepare_fixture(root)

            def replace_and_inject(source, destination):
                os.replace(source, destination)
                if Path(destination) == pending_path:
                    pending = read_json(pending_path)
                    pending['unsafe-concurrent'] = repair_request(**overrides)
                    write_json(pending_path, pending)

            try:
                seed_initial_pairing_request(
                    root,
                    'initial',
                    replace_file=replace_and_inject,
                    token_factory=lambda: f'fixture-device-token-{index}',
                    now_ms=lambda: 2000 + index,
                    seed_token_path=root / 'seed-token.sha256',
                    gateway_token='fixture-gateway-token',
                )
            except PairingSeedError as error:
                assert str(error) == 'temporary pairing seed left an unsafe same-device request pending'
            else:
                raise AssertionError(f'unsafe concurrent request {index} was accepted')


run_publication_order_proof()
run_unsafe_concurrency_proof()
print('ISSUE_4462_FIXTURE_BEHAVIOR_OK')
`;

describe("scope-upgrade approval live fixture", () => {
  it("executes ordered publication and rejects unsafe concurrent requests", () => {
    const result = spawnSync("python3", ["-"], {
      encoding: "utf8",
      input: `${ISSUE_4462_PAIRING_SEED_PY}\n${BEHAVIOR_HARNESS_PY}`,
      timeout: 10_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("ISSUE_4462_FIXTURE_BEHAVIOR_OK");
  });
});
