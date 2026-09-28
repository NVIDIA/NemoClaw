# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import base64
import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit("device state must be an object")
request_id_path = Path(sys.argv[2])
pending = data.get("pending")
paired = data.get("paired")
pending = [] if pending is None else pending
paired = [] if paired is None else paired
if not isinstance(pending, list) or any(not isinstance(request, dict) for request in pending):
    raise SystemExit("pending records must be an array of objects")
if not isinstance(paired, list) or any(not isinstance(device, dict) for device in paired):
    raise SystemExit("paired records must be an array of objects")
allowed_scopes = {"operator.pairing", "operator.read", "operator.write", "operator.admin"}
non_admin_scopes = {"operator.pairing", "operator.read", "operator.write"}


def norm(value):
    return str(value or "").strip()


def scope_view(value, key):
    if key not in value or value.get(key) is None:
        return None
    raw = value.get(key)
    if not isinstance(raw, list):
        raise SystemExit(f"{key} must be an array")
    normalized = [norm(scope) for scope in raw]
    if any(not isinstance(scope, str) or not normalized[index] for index, scope in enumerate(raw)):
        raise SystemExit(f"{key} contains an invalid scope")
    if len(normalized) != len(set(normalized)):
        raise SystemExit(f"{key} contains duplicate scopes")
    return set(normalized)


def scope_closure(view):
    result = set(view)
    if "operator.admin" in result:
        result.update({"operator.read", "operator.write"})
    if "operator.write" in result:
        result.add("operator.read")
    return result


def requested_scopes(value):
    views = [view for key in ("scopes", "requestedScopes") if (view := scope_view(value, key)) is not None]
    if not views:
        raise SystemExit("pending request has no requested scope array")
    if any(view != views[0] for view in views[1:]):
        raise SystemExit("pending requested scope arrays disagree")
    return views[0]


def approved_scope_views(value):
    views = [view for key in ("scopes", "approvedScopes") if (view := scope_view(value, key)) is not None]
    tokens = value.get("tokens")
    if tokens is not None:
        if isinstance(tokens, list):
            token_entries = tokens
        elif isinstance(tokens, dict):
            token_entries = list(tokens.values())
        else:
            raise SystemExit("paired tokens must be an array or object")
        if any(not isinstance(token, dict) for token in token_entries):
            raise SystemExit("paired tokens contains an invalid token")
        active_operator_tokens = [
            token
            for token in token_entries
            if norm(token.get("role")) == "operator" and not token.get("revokedAtMs")
        ]
        if len(active_operator_tokens) != 1:
            raise SystemExit(
                f"paired tokens must contain exactly one active operator token, found {len(active_operator_tokens)}"
            )
        token_view = scope_view(active_operator_tokens[0], "scopes")
        if token_view is not None:
            views.append(token_view)
    if not views:
        raise SystemExit("paired device has no approved scope array")
    views = [scope_closure(view) for view in views]
    if any(view != views[0] for view in views[1:]):
        raise SystemExit("paired approved scope arrays disagree")
    return views


def roles(value):
    result = set()
    raw_roles = value.get("roles")
    if raw_roles is not None:
        if not isinstance(raw_roles, list):
            raise SystemExit("roles must be an array")
        for role in raw_roles:
            if not isinstance(role, str) or not norm(role):
                raise SystemExit("roles contains an invalid role")
            result.add(norm(role))
    raw_role = value.get("role")
    if raw_role is not None:
        if not isinstance(raw_role, str) or not norm(raw_role):
            raise SystemExit("role is invalid")
        result.add(norm(raw_role))
    return result


def is_cli(value):
    return value.get("clientId") in {"cli", "openclaw-cli"} and value.get("clientMode") == "cli"


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


state_root = Path(os.environ.get("OPENCLAW_STATE_DIR") or "/sandbox/.openclaw")
helper_path = Path(
    os.environ.get("NEMOCLAW_OPENCLAW_PAIRING_STATE_HELPER")
    or "/usr/local/lib/nemoclaw/openclaw_pairing_state.py"
)
spec = importlib.util.spec_from_file_location("nemoclaw_admin_pairing_state", helper_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
records, _metadata = module.read_openclaw_pairing_state(str(state_root), timeout=1)
identity = records.get("identity")
if not isinstance(identity, dict):
    raise SystemExit("local CLI identity must be an object")
identity_device_id = norm(identity.get("deviceId"))
identity_key = identity_public_key(identity)
try:
    identity_key_raw = base64.urlsafe_b64decode(identity_key + "=" * (-len(identity_key) % 4))
except Exception:
    raise SystemExit("local CLI identity public key is invalid")
if (
    not identity_device_id
    or len(identity_key_raw) != 32
    or hashlib.sha256(identity_key_raw).hexdigest() != identity_device_id
):
    raise SystemExit("local CLI identity binding is invalid")

request_entries = pending
if len(request_entries) != 1:
    raise SystemExit(f"expected exactly one pending request, found {len(request_entries)}")
request = request_entries[0]
request_id = norm(request.get("requestId"))
if not re.fullmatch(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    request_id,
    re.IGNORECASE,
):
    raise SystemExit("pending admin request has an invalid requestId")
expected_request_id = norm(sys.argv[3]) if len(sys.argv) > 3 else ""
if expected_request_id and request_id != expected_request_id:
    raise SystemExit("pending admin request does not match the triggered request")
request_scopes = requested_scopes(request)
if not is_cli(request) or roles(request) != {"operator"}:
    raise SystemExit("cron requestId does not belong to the expected CLI operator")
if "operator.admin" not in request_scopes or not request_scopes.issubset(allowed_scopes):
    raise SystemExit(f"cron requestId has unexpected scopes: {sorted(request_scopes)}")
device_id = norm(request.get("deviceId"))
public_key = norm(request.get("publicKey"))
if device_id != identity_device_id or public_key != identity_key:
    raise SystemExit("pending admin request does not match the local CLI identity")
matching_devices = [
    device
    for device in paired
    if norm(device.get("deviceId")) == device_id
]
if not device_id or len(matching_devices) != 1:
    raise SystemExit(f"cron requestId must match exactly one paired device, found {len(matching_devices)}")
device = matching_devices[0]
if not is_cli(device) or roles(device) != {"operator"}:
    raise SystemExit("paired device does not belong to the expected CLI operator")
if not public_key or public_key != norm(device.get("publicKey")):
    raise SystemExit("cron requestId public key does not match its paired device")
device_scope_views = approved_scope_views(device)
if any("operator.admin" in view for view in device_scope_views):
    raise SystemExit("operator.admin was already granted before explicit approval")
if any(not view.issubset(non_admin_scopes) for view in device_scope_views):
    raise SystemExit("paired device has unexpected approved scopes")
request_id_path.write_text(request_id, encoding="utf-8")
