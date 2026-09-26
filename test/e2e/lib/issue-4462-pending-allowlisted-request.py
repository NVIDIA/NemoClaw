# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import os
import re
from pathlib import Path

STATE_ROOT = Path(os.environ.get("OPENCLAW_STATE_DIR", "/sandbox/.openclaw"))
HELPER_PATH = Path(
    os.environ.get(
        "NEMOCLAW_OPENCLAW_PAIRING_STATE_HELPER",
        "/usr/local/lib/nemoclaw/openclaw_pairing_state.py",
    )
)
ALLOWED_CLIENTS = {"cli", "openclaw-cli", "openclaw-control-ui"}
ALLOWED_SCOPES = {"operator.pairing", "operator.read", "operator.write"}


def norm(value):
    return str(value or "").strip()


def roles(value):
    result = {norm(role) for role in (value.get("roles") or []) if norm(role)}
    if norm(value.get("role")):
        result.add(norm(value.get("role")))
    return result


def requested_scopes(value):
    views = []
    for key in ("scopes", "requestedScopes"):
        if key not in value:
            continue
        raw = value.get(key)
        if not isinstance(raw, list):
            raise SystemExit(f"pending {key} must be an array")
        views.append({norm(scope) for scope in raw if norm(scope)})
    if not views or any(view != views[0] for view in views[1:]):
        raise SystemExit("pending requested scope arrays are unavailable or disagree")
    return views[0]


spec = importlib.util.spec_from_file_location("nemoclaw_pending_pairing_state", HELPER_PATH)
if spec is None or spec.loader is None:
    raise SystemExit("canonical pairing-state helper is unavailable")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
records, _metadata = module.read_openclaw_pairing_state(str(STATE_ROOT), timeout=1)
identity = records.get("identity")
pending = records.get("pending")
if not isinstance(identity, dict) or not isinstance(pending, dict):
    raise SystemExit("canonical identity or pending state is unavailable")
if any(not isinstance(request, dict) for request in pending.values()):
    raise SystemExit("canonical pending records must be objects")
primary_device_id = norm(identity.get("deviceId"))
matches = [
    request
    for request in pending.values()
    if norm(request.get("deviceId"))
    and norm(request.get("deviceId")) != primary_device_id
    and request.get("clientId") in ALLOWED_CLIENTS
    and request.get("clientMode") == "cli"
    and roles(request) == {"operator"}
    and "operator.pairing" in requested_scopes(request)
    and requested_scopes(request).issubset(ALLOWED_SCOPES)
]
if not primary_device_id or len(matches) != 1:
    raise SystemExit(f"expected one bounded secondary CLI request, found {len(matches)}")
request = matches[0]
request_id = norm(request.get("requestId"))
if not re.fullmatch(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    request_id,
    re.IGNORECASE,
):
    raise SystemExit("pending allowlisted request has an invalid requestId")
print(f"ISSUE_4462_ALLOWLISTED_REQUEST_ID={request_id.lower()}")
