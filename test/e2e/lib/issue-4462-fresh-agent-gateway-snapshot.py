# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import base64
import binascii
import hashlib
import json
import re
import sys
import time
from pathlib import Path

minimum_gateway_runs = int(sys.argv[1])
output_mode = sys.argv[2] if len(sys.argv) > 2 else "snapshot"
if output_mode not in {"snapshot", "gateway-runs"}:
    raise SystemExit(f"unsupported output mode: {output_mode}")
timeout_seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 30
if timeout_seconds <= 0:
    raise SystemExit("observation timeout must be positive")
root = Path(sys.argv[4]) if len(sys.argv) > 4 else Path("/sandbox/.openclaw")
gateway_log = Path(sys.argv[5]) if len(sys.argv) > 5 else Path("/tmp/gateway.log")
observation_deadline = time.monotonic() + timeout_seconds


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


def gateway_completed_runs():
    try:
        value = gateway_log.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return 0
    return len(re.findall(r"\[agent\] run \S+ ended with stopReason=", value))


def wait_for_gateway_runs():
    runs = gateway_completed_runs()
    while runs < minimum_gateway_runs and time.monotonic() < observation_deadline:
        time.sleep(0.1)
        runs = gateway_completed_runs()
    return runs


if output_mode == "gateway-runs":
    print(json.dumps({"gatewayCompletedRuns": wait_for_gateway_runs()}, sort_keys=True))
    raise SystemExit(0)


identity = load_map(root / "identity" / "device.json")
device_id = norm(identity.get("deviceId"))
if not device_id:
    raise SystemExit("CLI identity has no deviceId")
identity_key = identity_public_key(identity)
if not identity_key:
    raise SystemExit("CLI identity has no public key")
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
while True:
    pending = [
        value
        for value in load_map(root / "devices" / "pending.json").values()
        if isinstance(value, dict)
    ]
    paired = [
        value
        for value in load_map(root / "devices" / "paired.json").values()
        if isinstance(value, dict)
    ]
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
    if len(matching) == 1 or time.monotonic() >= observation_deadline:
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
device = matching[0]
tokens = device.get("tokens")
if isinstance(tokens, dict):
    token_entries = list(tokens.values())
elif isinstance(tokens, list):
    token_entries = tokens
else:
    raise SystemExit("paired tokens must be an object or array")
active = [
    token
    for token in token_entries
    if isinstance(token, dict)
    and norm(token.get("role")) == "operator"
    and not token.get("revokedAtMs")
]
runs = wait_for_gateway_runs()
print(
    json.dumps(
        {
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
            "gatewayCompletedRuns": runs,
            "matchingPairedCount": len(matching),
            "pairedCliCount": len(paired_cli),
            "pendingCount": len(pending),
            "sameDevicePendingCount": sum(
                1 for value in pending if norm(value.get("deviceId")) == device_id
            ),
        },
        sort_keys=True,
    )
)
