# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import base64
import binascii
import hashlib
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

timeout_seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 30
if timeout_seconds <= 0:
    raise SystemExit("observation timeout must be positive")
root = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/sandbox/.openclaw")
pairing_state_helper = (
    Path(sys.argv[3])
    if len(sys.argv) > 3
    else Path("/usr/local/lib/nemoclaw/openclaw_pairing_state.py")
)
observation_deadline = time.monotonic() + timeout_seconds
pairing_state_reader = None


def norm(value):
    return str(value or "").strip()


def load_map(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise SystemExit(f"{path.name} must contain an object")
    return value


def load_canonical_pairing_state():
    global pairing_state_reader
    if pairing_state_reader is None:
        spec = importlib.util.spec_from_file_location(
            "nemoclaw_issue_4462_pairing_state", pairing_state_helper
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("canonical pairing-state helper is unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        pairing_state_reader = module.read_openclaw_pairing_state
    records, _database_metadata = pairing_state_reader(str(root), timeout=1)
    return records


def load_pairing_records():
    sqlite_path = root / "state" / "openclaw.sqlite"
    if os.path.lexists(sqlite_path):
        records = load_canonical_pairing_state()
        identity = records.get("identity")
        pending = records.get("pending")
        paired = records.get("paired")
    else:
        identity = load_map(root / "identity" / "device.json")
        pending = load_map(root / "devices" / "pending.json")
        paired = load_map(root / "devices" / "paired.json")
        if os.path.lexists(sqlite_path):
            raise RuntimeError("canonical pairing state appeared during legacy read")
    if not isinstance(identity, dict):
        raise RuntimeError("CLI identity must be an object")
    if not isinstance(pending, dict) or not isinstance(paired, dict):
        raise RuntimeError("pairing state must contain pending and paired maps")
    if any(not isinstance(value, dict) for value in pending.values()):
        raise RuntimeError("pending pairing records must be objects")
    if any(not isinstance(value, dict) for value in paired.values()):
        raise RuntimeError("paired pairing records must be objects")
    return identity, list(pending.values()), list(paired.values())


def identity_public_key(value):
    direct = norm(value.get("publicKey"))
    if direct:
        return direct
    pem = norm(value.get("publicKeyPem"))
    if not pem:
        return ""
    body = "".join(line.strip() for line in pem.splitlines() if not line.startswith("-----"))
    try:
        der = base64.b64decode(body, validate=True)
    except Exception:
        return ""
    prefix = bytes.fromhex("302a300506032b6570032100")
    if len(der) != len(prefix) + 32 or not der.startswith(prefix):
        return ""
    return base64.urlsafe_b64encode(der[len(prefix) :]).decode("ascii").rstrip("=")


while True:
    try:
        identity, pending, paired = load_pairing_records()
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        if time.monotonic() >= observation_deadline:
            raise SystemExit("canonical pairing state is unavailable") from None
        time.sleep(0.1)
        continue
    device_id = norm(identity.get("deviceId"))
    if not device_id:
        if time.monotonic() >= observation_deadline:
            raise SystemExit("CLI identity has no deviceId")
        time.sleep(0.1)
        continue
    identity_key = identity_public_key(identity)
    if not identity_key:
        if time.monotonic() >= observation_deadline:
            raise SystemExit("CLI identity has no public key")
        time.sleep(0.1)
        continue
    try:
        identity_key_raw = base64.b64decode(
            identity_key + "=" * (-len(identity_key) % 4),
            altchars=b"-_",
            validate=True,
        )
    except (binascii.Error, ValueError):
        raise SystemExit("CLI identity public key is invalid") from None
    if (
        len(identity_key_raw) != 32
        or hashlib.sha256(identity_key_raw).hexdigest() != device_id
    ):
        raise SystemExit("CLI identity binding is invalid")
    paired_cli = [
        value
        for value in paired
        if value.get("clientId") == "cli" and value.get("clientMode") == "cli"
    ]
    matching = [
        value
        for value in paired_cli
        if norm(value.get("deviceId")) == device_id
        and norm(value.get("publicKey")) == identity_key
    ]
    if len(matching) > 1:
        break
    if len(matching) == 1:
        device = matching[0]
        tokens = device.get("tokens")
        if isinstance(tokens, dict):
            token_entries = list(tokens.values())
        elif isinstance(tokens, list):
            token_entries = tokens
        else:
            token_entries = []
        active = [
            token
            for token in token_entries
            if isinstance(token, dict)
            and norm(token.get("role")) == "operator"
            and not token.get("revokedAtMs")
        ]
        snapshot = {
            "activeOperatorTokenCount": len(active),
            "activeOperatorTokenScopes": sorted(
                {
                    norm(scope)
                    for token in active
                    for scope in (token.get("scopes") or [])
                    if norm(scope)
                }
            ),
            "approvedScopes": sorted(
                {
                    norm(scope)
                    for scope in (device.get("approvedScopes") or [])
                    if norm(scope)
                }
            ),
            "deviceScopes": sorted(
                {norm(scope) for scope in (device.get("scopes") or []) if norm(scope)}
            ),
            "matchingPairedCount": len(matching),
            "pairedCliCount": len(paired_cli),
            "pendingCount": len(pending),
            "sameDevicePendingCount": sum(
                1 for value in pending if norm(value.get("deviceId")) == device_id
            ),
        }
        settled = (
            snapshot["activeOperatorTokenCount"] == 1
            and snapshot["activeOperatorTokenScopes"]
            == ["operator.pairing", "operator.read", "operator.write"]
            and snapshot["approvedScopes"] == ["operator.pairing", "operator.write"]
            and snapshot["deviceScopes"] == ["operator.pairing", "operator.write"]
            and snapshot["pairedCliCount"] == 1
            and snapshot["pendingCount"] == 0
        )
        if settled:
            print(json.dumps(snapshot, sort_keys=True))
            raise SystemExit(0)
        if time.monotonic() >= observation_deadline:
            print(json.dumps(snapshot, sort_keys=True))
            raise SystemExit("CLI pairing state is unsettled at observation deadline")
    if time.monotonic() >= observation_deadline:
        break
    time.sleep(0.1)

if len(matching) != 1:
    observed = [
        {
            "clientId": norm(value.get("clientId")),
            "clientMode": norm(value.get("clientMode")),
            "deviceIdMatches": norm(value.get("deviceId")) == device_id,
        }
        for value in paired
    ]
    raise SystemExit(
        "CLI identity must match exactly one paired device, "
        f"found {len(matching)}; observed={json.dumps(observed, sort_keys=True)}"
    )
