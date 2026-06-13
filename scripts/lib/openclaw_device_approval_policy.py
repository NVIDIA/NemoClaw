# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Shared OpenClaw device approval policy for NemoClaw sandbox helpers."""

import json
import os
import re
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


def recover_failed_scope_approval(request_id, state_dir=None, approve_output="", original_request=None):
    """Repair a narrow OpenClaw 2026.5.x nonzero scope-upgrade approval state.

    OpenClaw can apply, replace, or leave behind an allowlisted CLI/webchat
    operator.write upgrade while returning a gateway-connect failure to the
    caller. This helper only edits local OpenClaw device state when the pending
    request and paired device are already present, the approve output matches
    the known gateway scope-upgrade failure signature, the requested scopes are
    limited to NemoClaw's allowlist, and the device already has
    operator.pairing. It never grants operator.admin.
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
    if (
        not device_id
        or not requested
        or not requested.issubset(allowed)
        or "operator.pairing" not in paired_scopes
        or not isinstance(paired_entry, dict)
    ):
        return None

    still_pending = original_key is not None
    if not still_pending and requested.issubset(paired_scopes):
        return {
            "requestId": request_id,
            "deviceId": device_id,
            "approvedScopes": sorted(requested),
            "compatibility": "openclaw-approve-applied-after-nonzero",
        }

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
