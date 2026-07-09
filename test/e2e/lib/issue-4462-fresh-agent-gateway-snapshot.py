# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import re
import sys
import time
from pathlib import Path

minimum_gateway_runs = int(sys.argv[1])
root = Path("/sandbox/.openclaw")


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


def gateway_completed_runs():
    try:
        value = Path("/tmp/gateway.log").read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return 0
    return len(re.findall(r"\[agent\] run \S+ ended with stopReason=", value))


identity = load_map(root / "identity" / "device.json")
device_id = norm(identity.get("deviceId"))
if not device_id:
    raise SystemExit("CLI identity has no deviceId")
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
matching = [value for value in paired_cli if norm(value.get("deviceId")) == device_id]
if len(matching) != 1:
    raise SystemExit(
        f"CLI identity must match exactly one paired device, found {len(matching)}"
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
deadline = time.monotonic() + 5
runs = gateway_completed_runs()
while runs < minimum_gateway_runs and time.monotonic() < deadline:
    time.sleep(0.1)
    runs = gateway_completed_runs()
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
            "deviceId": device_id,
            "deviceScopes": sorted(
                {norm(scope) for scope in (device.get("scopes") or []) if norm(scope)}
            ),
            "gatewayCompletedRuns": runs,
            "matchingPairedCount": len(matching),
            "pairedCliCount": len(paired_cli),
            "pendingCount": len(pending),
            "publicKey": norm(device.get("publicKey")),
            "sameDevicePendingCount": sum(
                1 for value in pending if norm(value.get("deviceId")) == device_id
            ),
        },
        sort_keys=True,
    )
)
