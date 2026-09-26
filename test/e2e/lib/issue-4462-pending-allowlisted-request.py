# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import re
from pathlib import Path

STATE_ROOT = Path("/sandbox/.openclaw")
HELPER_PATH = Path("/usr/local/lib/nemoclaw/openclaw_pairing_state.py")
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
if not isinstance(identity, dict) or not isinstance(pending, list):
    raise SystemExit("canonical identity or pending state is unavailable")
device_id = norm(identity.get("deviceId"))
matches = [request for request in pending if norm(request.get("deviceId")) == device_id]
if not device_id or len(matches) != 1:
    raise SystemExit(f"expected one pending request for the current CLI identity, found {len(matches)}")
request = matches[0]
request_id = norm(request.get("requestId"))
if not re.fullmatch(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    request_id,
    re.IGNORECASE,
):
    raise SystemExit("pending allowlisted request has an invalid requestId")
scopes = requested_scopes(request)
if (
    request.get("clientId") not in ALLOWED_CLIENTS
    or request.get("clientMode") != "cli"
    or roles(request) != {"operator"}
    or "operator.pairing" not in scopes
    or not scopes.issubset(ALLOWED_SCOPES)
):
    raise SystemExit("pending request is outside the bounded allowlisted contract")
print(f"ISSUE_4462_ALLOWLISTED_REQUEST_ID={request_id.lower()}")
