# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Shared OpenClaw device approval policy for NemoClaw sandbox helpers."""

import json
import os
import re
import base64
import hashlib
import secrets
import time
from pathlib import Path


ALLOWED_CLIENTS = {"openclaw-control-ui"}
ALLOWED_MODES = {"webchat", "cli"}
ALLOWED_SCOPES = {"operator.pairing", "operator.read", "operator.write"}

GATEWAY_APPROVAL_ENV_KEYS = (
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_TOKEN",
)


def requested_scopes(device):
    if "scopes" in device:
        scopes = device.get("scopes")
    elif "requestedScopes" in device:
        scopes = device.get("requestedScopes")
    else:
        return set()
    if not isinstance(scopes, list):
        return None
    return {str(scope).strip() for scope in scopes if str(scope or "").strip()}


def approval_request_decision(device):
    client_id = str(device.get("clientId", ""))
    client_mode = str(device.get("clientMode", ""))
    if client_id not in ALLOWED_CLIENTS and client_mode not in ALLOWED_MODES:
        return {
            "allowed": False,
            "reason": "unknown-client",
            "client_id": client_id,
            "client_mode": client_mode,
            "scopes": set(),
        }

    scopes = requested_scopes(device)
    if scopes is None:
        return {
            "allowed": False,
            "reason": "malformed-scopes",
            "client_id": client_id,
            "client_mode": client_mode,
            "scopes": set(),
        }
    if scopes and not scopes.issubset(ALLOWED_SCOPES):
        return {
            "allowed": False,
            "reason": "disallowed-scopes",
            "client_id": client_id,
            "client_mode": client_mode,
            "scopes": scopes,
        }

    return {
        "allowed": True,
        "reason": "allowlisted",
        "client_id": client_id,
        "client_mode": client_mode,
        "scopes": scopes,
    }


def gateway_approval_env(source_env=None):
    env = dict(os.environ if source_env is None else source_env)
    for key in GATEWAY_APPROVAL_ENV_KEYS:
        env.pop(key, None)
    return env


def _norm(value):
    return str(value or "").strip()


def _scope_set(entry, key="scopes"):
    if not isinstance(entry, dict):
        return set()
    return {_norm(scope) for scope in (entry.get(key) or []) if _norm(scope)}


def _role_set(entry):
    if not isinstance(entry, dict):
        return set()
    roles = {_norm(role) for role in (entry.get("roles") or []) if _norm(role)}
    role = _norm(entry.get("role"))
    if role:
        roles.add(role)
    return roles


def _identity_public_key(identity):
    direct = _norm(identity.get("publicKey"))
    if direct:
        return direct
    pem = _norm(identity.get("publicKeyPem"))
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


def _identity_key_matches_device_id(public_key, device_id):
    try:
        raw = base64.urlsafe_b64decode(public_key + "=" * (-len(public_key) % 4))
    except Exception:
        return False
    return len(raw) == 32 and hashlib.sha256(raw).hexdigest() == device_id


def _load_device_state(devices_dir, name):
    try:
        value = json.loads((devices_dir / name).read_text(encoding="utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _save_device_state(devices_dir, name, value):
    path = devices_dir / name
    tmp = path.with_name(f".{path.name}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _output_mentions_request_id(output, request_id):
    request = _norm(request_id)
    if not request:
        return False
    return bool(re.search(r"(?<![0-9A-Za-z_-])" + re.escape(request) + r"(?![0-9A-Za-z_-])", output or ""))


def _is_scope_upgrade_approval_compat_failure(output):
    text = _norm(output).lower()
    return "scope upgrade pending approval" in text and (
        "gatewayclientrequesterror" in text or "gateway" in text
    )


def _is_pairing_required_approval_compat_failure(output):
    text = _norm(output).lower()
    return ("device pairing required" in text or "pairing required" in text) and (
        "gatewayclientrequesterror" in text
        or "gateway requires device pairing" in text
        or "gateway connect failed" in text
    )


def _compatible_cli_pairing_request(item, device_id, public_key, allowed):
    if not isinstance(item, dict):
        return False
    scopes = _scope_set(item) or _scope_set(item, "requestedScopes")
    client_id = _norm(item.get("clientId"))
    return bool(
        _norm(item.get("requestId"))
        and _norm(item.get("deviceId")) == device_id
        and _norm(item.get("publicKey")) == public_key
        and _norm(item.get("clientMode")).lower() == "cli"
        and (not client_id or client_id in {"cli", "openclaw-cli"})
        and _role_set(item) == {"operator"}
        and scopes
        and "operator.pairing" in scopes
        and scopes.issubset(allowed)
    )


def _write_json_path(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(tmp, flags, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
        os.fchmod(handle.fileno(), mode)
    os.replace(tmp, path)


def recover_failed_scope_approval(request_id, state_dir=None, approve_output="", original_request=None):
    """Repair narrow OpenClaw 2026.5.x nonzero CLI approval states.

    OpenClaw can apply, replace, or leave behind allowlisted CLI operator
    pairing/write requests while returning a gateway-connect failure to the
    caller. This helper only edits local OpenClaw device state when the pending
    request matches the persisted CLI identity, the approve output matches a
    known gateway pairing/scope-upgrade failure signature, and the requested
    scopes are limited to NemoClaw's allowlist. It never grants operator.admin.
    """

    request_id = _norm(request_id)
    if not request_id:
        return None
    devices_dir = Path(state_dir or os.environ.get("OPENCLAW_STATE_DIR") or "/sandbox/.openclaw") / "devices"
    pending = _load_device_state(devices_dir, "pending.json")
    paired = _load_device_state(devices_dir, "paired.json")

    original_key = None
    original = original_request if isinstance(original_request, dict) else None
    for key, item in pending.items():
        if isinstance(item, dict) and _norm(item.get("requestId")) == request_id:
            original_key = key
            original = item
            break
    if not isinstance(original, dict):
        return None

    requested = _scope_set(original) or _scope_set(original, "requestedScopes")
    device_id = _norm(original.get("deviceId"))
    paired_entry = paired.get(device_id) if device_id else None
    paired_scopes = _scope_set(paired_entry or {}, "approvedScopes") | _scope_set(paired_entry or {})
    allowed = {"operator.pairing", "operator.read", "operator.write"}
    if not device_id or not requested or not requested.issubset(allowed):
        return None

    still_pending = original_key is not None
    if not still_pending and requested.issubset(paired_scopes):
        return {
            "requestId": request_id,
            "deviceId": device_id,
            "approvedScopes": sorted(requested),
            "compatibility": "openclaw-approve-applied-after-nonzero",
        }

    public_key = _norm(original.get("publicKey"))
    client_id = _norm(original.get("clientId"))
    same_device_pending = [
        (key, item)
        for key, item in pending.items()
        if isinstance(item, dict) and _norm(item.get("deviceId")) == device_id
    ]
    if (
        not isinstance(paired_entry, dict)
        and public_key
        and "operator.pairing" in requested
        and _norm(original.get("clientMode")).lower() == "cli"
        and (not client_id or client_id in {"cli", "openclaw-cli"})
        and _role_set(original) == {"operator"}
        and same_device_pending
        and all(
            _compatible_cli_pairing_request(item, device_id, public_key, allowed)
            for _, item in same_device_pending
        )
        and _is_pairing_required_approval_compat_failure(approve_output)
    ):
        identity_path = devices_dir.parent / "identity" / "device.json"
        auth_path = devices_dir.parent / "identity" / "device-auth.json"
        try:
            identity = json.loads(identity_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        identity_public_key = _identity_public_key(identity if isinstance(identity, dict) else {})
        if (
            _norm(identity.get("deviceId") if isinstance(identity, dict) else "") != device_id
            or identity_public_key != public_key
            or not _identity_key_matches_device_id(public_key, device_id)
        ):
            return None

        approved = set(requested)
        if "operator.write" in approved:
            approved.add("operator.read")
        if {"operator.read", "operator.write"} & approved:
            approved.add("operator.pairing")
        if not approved.issubset(allowed):
            return None
        approved_list = [
            scope for scope in ("operator.pairing", "operator.read", "operator.write") if scope in approved
        ]
        token = secrets.token_urlsafe(32)
        if not token or token == _norm(os.environ.get("OPENCLAW_GATEWAY_TOKEN")):
            return None
        now = int(time.time() * 1000)
        operator_token = {
            "token": token,
            "role": "operator",
            "scopes": approved_list,
            "createdAtMs": now,
        }
        paired_entry = {
            "deviceId": device_id,
            "publicKey": public_key,
            "displayName": original.get("displayName"),
            "platform": original.get("platform"),
            "deviceFamily": original.get("deviceFamily"),
            "clientId": original.get("clientId"),
            "clientMode": original.get("clientMode"),
            "role": "operator",
            "roles": ["operator"],
            "scopes": approved_list,
            "approvedScopes": approved_list,
            "remoteIp": original.get("remoteIp"),
            "tokens": {"operator": operator_token},
            "createdAtMs": now,
            "approvedAtMs": now,
        }
        paired_entry = {key: value for key, value in paired_entry.items() if value is not None}
        for key, _ in same_device_pending:
            pending.pop(key, None)
        paired[device_id] = paired_entry
        auth = {
            "version": 1,
            "deviceId": device_id,
            "tokens": {
                "operator": {
                    "token": token,
                    "role": "operator",
                    "scopes": approved_list,
                    "updatedAtMs": now,
                }
            },
        }
        _save_device_state(devices_dir, "pending.json", pending)
        _save_device_state(devices_dir, "paired.json", paired)
        _write_json_path(auth_path, auth)
        return {
            "requestId": request_id,
            "deviceId": device_id,
            "approvedScopes": approved_list,
            "compatibility": "openclaw-approve-recovered-initial-cli",
        }

    if "operator.pairing" not in paired_scopes or not isinstance(paired_entry, dict):
        return None

    replacement_allowed = allowed | {"operator.admin"}
    candidates = []
    mentioned = []
    for key, item in pending.items():
        item_scopes = _scope_set(item) if isinstance(item, dict) else set()
        if (
            isinstance(item, dict)
            and _norm(item.get("requestId")) != request_id
            and _norm(item.get("deviceId")) == device_id
            and "operator.admin" in item_scopes
            and requested.issubset(item_scopes)
            and item_scopes.issubset(replacement_allowed)
        ):
            candidates.append((key, item))
            if _output_mentions_request_id(approve_output, item.get("requestId")):
                mentioned.append((key, item))

    recovery_key = None
    compatibility = None
    if len(mentioned) == 1:
        recovery_key = mentioned[0][0]
        compatibility = "openclaw-approve-recovered-replacement"
    elif len(candidates) == 1 and not re.search(r"\brequestId\b|\brequest[-_ ]?id\b", approve_output or "", re.IGNORECASE):
        recovery_key = candidates[0][0]
        compatibility = "openclaw-approve-recovered-replacement"
    elif still_pending and not candidates and _is_scope_upgrade_approval_compat_failure(approve_output):
        recovery_key = original_key
        compatibility = "openclaw-approve-recovered-original"
    else:
        return None

    approved = set(paired_scopes) | requested
    if "operator.write" in approved:
        approved.add("operator.read")
    if {"operator.read", "operator.write"} & approved:
        approved.add("operator.pairing")
    if not approved.issubset(allowed):
        return None
    approved_list = [scope for scope in ("operator.pairing", "operator.read", "operator.write") if scope in approved]
    paired_entry["scopes"] = approved_list
    paired_entry["approvedScopes"] = approved_list
    token = paired_entry.get("tokens", {}).get("operator")
    if isinstance(token, dict):
        token["scopes"] = approved_list
    pending.pop(request_id, None)
    if recovery_key:
        pending.pop(recovery_key, None)
    paired[device_id] = paired_entry
    _save_device_state(devices_dir, "pending.json", pending)
    _save_device_state(devices_dir, "paired.json", paired)
    return {
        "requestId": request_id,
        "deviceId": device_id,
        "approvedScopes": approved_list,
        "compatibility": compatibility,
    }
