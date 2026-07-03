# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Shared OpenClaw device approval policy for NemoClaw sandbox helpers."""

import base64
import json
import os
import re
import tempfile
import time
from pathlib import Path


ALLOWED_CLIENTS = {"openclaw-control-ui"}
ALLOWED_MODES = {"webchat", "cli"}
ALLOWED_SCOPES = {"operator.pairing", "operator.read", "operator.write"}
CLI_CLIENT_IDS = {"cli", "openclaw-cli"}
READ_WRITE_SCOPES = {"operator.read", "operator.write"}

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


def _is_cli_request(device):
    client_id = str(device.get("clientId", "")).strip().lower()
    client_mode = str(device.get("clientMode", "")).strip().lower()
    return client_mode == "cli" or client_id in CLI_CLIENT_IDS


def _is_same_public_key(left, right):
    left_key = _norm((left or {}).get("publicKey"))
    right_key = _norm((right or {}).get("publicKey"))
    return not left_key or not right_key or left_key == right_key


def _iter_paired(paired):
    if isinstance(paired, dict):
        return [item for item in paired.values() if isinstance(item, dict)]
    if isinstance(paired, list):
        return [item for item in paired if isinstance(item, dict)]
    return []


def _paired_lookup(paired):
    out = {}
    for item in _iter_paired(paired):
        device_id = _norm(item.get("deviceId"))
        if device_id:
            out[device_id] = item
    return out


def _paired_scope_set(entry):
    if not isinstance(entry, dict):
        return set()
    scopes = _scope_set(entry, "approvedScopes") | _scope_set(entry)
    operator = entry.get("tokens", {}).get("operator") if isinstance(entry.get("tokens"), dict) else None
    scopes |= _scope_set(operator or {})
    return scopes


def approval_request_decision(device, paired=None):
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

    if _is_cli_request(device):
        paired_entry = _paired_lookup(paired).get(_norm(device.get("deviceId")))
        if not isinstance(paired_entry, dict) or not _is_same_public_key(device, paired_entry):
            return {
                "allowed": False,
                "reason": "cli-first-pairing",
                "client_id": client_id,
                "client_mode": client_mode,
                "scopes": scopes,
            }
        paired_scopes = _paired_scope_set(paired_entry)
        if "operator.pairing" not in paired_scopes:
            return {
                "allowed": False,
                "reason": "cli-missing-pairing-baseline",
                "client_id": client_id,
                "client_mode": client_mode,
                "scopes": scopes,
            }
        if not (scopes & READ_WRITE_SCOPES):
            return {
                "allowed": False,
                "reason": "cli-pairing-only",
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
    _save_json_file(devices_dir / name, value)


def _save_json_file(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = None
            os.fchmod(handle.fileno(), mode)
            handle.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        tmp = None
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                # Best-effort cleanup; preserve the original write/replace error.
                pass
        if tmp is not None:
            try:
                tmp.unlink()
            except FileNotFoundError:
                # The temp path may already have been replaced or removed.
                pass


def _output_mentions_request_id(output, request_id):
    request = _norm(request_id)
    if not request:
        return False
    return bool(re.search(r"(?<![0-9A-Za-z_-])" + re.escape(request) + r"(?![0-9A-Za-z_-])", output or ""))


def _state_dir_path(state_dir=None):
    return Path(state_dir or os.environ.get("OPENCLAW_STATE_DIR") or "/sandbox/.openclaw")


def _devices_dir_path(state_dir=None):
    return _state_dir_path(state_dir) / "devices"


def _pending_items(pending):
    if not isinstance(pending, dict):
        return []
    return [(key, item) for key, item in pending.items() if isinstance(item, dict)]


def _load_pairing_state(state_dir=None):
    devices_dir = _devices_dir_path(state_dir)
    return (
        devices_dir,
        _load_device_state(devices_dir, "pending.json"),
        _load_device_state(devices_dir, "paired.json"),
    )


def local_pairing_list(state_dir=None):
    """Return OpenClaw device-pairing state without opening a CLI gateway connection."""

    _devices_dir, pending, paired = _load_pairing_state(state_dir)
    return {
        "pending": [item for _key, item in _pending_items(pending)],
        "paired": _iter_paired(paired),
    }


def _role_list(entry):
    roles = []
    raw_roles = entry.get("roles")
    if isinstance(raw_roles, list):
        roles.extend(_norm(role) for role in raw_roles if _norm(role))
    role = _norm(entry.get("role"))
    if role:
        roles.append(role)
    if not roles and any(scope.startswith("operator.") for scope in requested_scopes(entry) or set()):
        roles.append("operator")
    out = []
    for role in roles:
        if role not in out:
            out.append(role)
    return out


def _merge_lists(*items):
    out = []
    for item in items:
        if not isinstance(item, list):
            continue
        for value in item:
            normalized = _norm(value)
            if normalized and normalized not in out:
                out.append(normalized)
    return out


def _canonical_scopes(scopes):
    order = ("operator.pairing", "operator.read", "operator.write")
    return [scope for scope in order if scope in scopes] + sorted(scope for scope in scopes if scope not in order)


def _new_pairing_token():
    return base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode("ascii")


def _token_scopes_for_role(role, approved_scopes):
    if role == "operator":
        return [scope for scope in approved_scopes if scope.startswith("operator.")]
    return [scope for scope in approved_scopes if not scope.startswith("operator.")]


def _clear_identity_device_auth_token(state_dir, device_id, role="operator"):
    auth_path = _state_dir_path(state_dir) / "identity" / "device-auth.json"
    store = _load_device_state(auth_path.parent, auth_path.name)
    if store.get("version") != 1 or _norm(store.get("deviceId")) != _norm(device_id):
        return False
    tokens = store.get("tokens")
    if not isinstance(tokens, dict) or role not in tokens:
        return False
    next_store = dict(store)
    next_tokens = dict(tokens)
    next_tokens.pop(role, None)
    next_store["tokens"] = next_tokens
    _save_json_file(auth_path, next_store)
    return True


def approve_allowlisted_request(request_id, state_dir=None, original_request=None):
    """Approve one allowlisted pending device request by editing local OpenClaw state.

    This deliberately avoids running `openclaw devices list/approve`: those
    commands are ordinary CLI gateway clients, so using them from NemoClaw's
    background approval path can silently create a pairing-only CLI device and
    turn a later `openclaw agent -m` into a scope-upgrade prompt.
    """

    request_id = _norm(request_id)
    if not request_id:
        return None
    devices_dir, pending, paired = _load_pairing_state(state_dir)
    request_key = None
    request = original_request if isinstance(original_request, dict) else None
    for key, item in _pending_items(pending):
        if _norm(item.get("requestId")) == request_id:
            request_key = key
            request = item
            break
    if not isinstance(request, dict):
        return None
    decision = approval_request_decision(request, paired)
    if not decision.get("allowed"):
        return None

    requested = requested_scopes(request) or set()
    if not requested or not requested.issubset(ALLOWED_SCOPES):
        return None
    device_id = _norm(request.get("deviceId"))
    if not device_id:
        return None
    existing = paired.get(device_id) if isinstance(paired, dict) else None
    existing = existing if isinstance(existing, dict) else {}
    now = int(time.time() * 1000)
    approved_scopes = _canonical_scopes(
        _scope_set(existing, "approvedScopes") | _scope_set(existing) | requested
    )
    roles = _merge_lists(existing.get("roles"), _role_list(request))
    role = _norm(request.get("role")) or (roles[0] if roles else None)
    tokens = dict(existing.get("tokens") if isinstance(existing.get("tokens"), dict) else {})
    for token_role in roles:
        current = tokens.get(token_role) if isinstance(tokens.get(token_role), dict) else {}
        tokens[token_role] = {
            "token": _new_pairing_token(),
            "role": token_role,
            "scopes": _token_scopes_for_role(token_role, approved_scopes),
            "createdAtMs": current.get("createdAtMs") if isinstance(current.get("createdAtMs"), int) else now,
            **({"rotatedAtMs": now} if current else {}),
            **({"lastUsedAtMs": current.get("lastUsedAtMs")} if isinstance(current.get("lastUsedAtMs"), int) else {}),
        }

    paired[device_id] = {
        "deviceId": device_id,
        "publicKey": _norm(request.get("publicKey")) or _norm(existing.get("publicKey")),
        **({"displayName": request.get("displayName")} if _norm(request.get("displayName")) else {}),
        **({"platform": request.get("platform")} if _norm(request.get("platform")) else {}),
        **({"deviceFamily": request.get("deviceFamily")} if _norm(request.get("deviceFamily")) else {}),
        **({"clientId": request.get("clientId")} if _norm(request.get("clientId")) else {}),
        **({"clientMode": request.get("clientMode")} if _norm(request.get("clientMode")) else {}),
        **({"role": role} if role else {}),
        **({"roles": roles} if roles else {}),
        "scopes": approved_scopes,
        "approvedScopes": approved_scopes,
        **({"remoteIp": request.get("remoteIp")} if _norm(request.get("remoteIp")) else {}),
        "tokens": tokens,
        "createdAtMs": existing.get("createdAtMs") if isinstance(existing.get("createdAtMs"), int) else now,
        "approvedAtMs": now,
        "lastSeenAtMs": now,
        "lastSeenReason": "nemoclaw-auto-approve",
    }
    if request_key:
        pending.pop(request_key, None)
    pending.pop(request_id, None)
    _save_device_state(devices_dir, "pending.json", pending)
    _save_device_state(devices_dir, "paired.json", paired)
    return {
        "requestId": request_id,
        "deviceId": device_id,
        "approvedScopes": approved_scopes,
        "compatibility": "nemoclaw-local-state-approve",
    }


def prune_cli_pairing_only_devices(state_dir=None):
    """Remove stale CLI devices that NemoClaw previously paired with pairing-only scope."""

    devices_dir, pending, paired = _load_pairing_state(state_dir)
    if not isinstance(paired, dict):
        return []
    pending_device_ids = {_norm(item.get("deviceId")) for _key, item in _pending_items(pending)}
    removed = []
    for device_id, entry in list(paired.items()):
        if not isinstance(entry, dict) or not _is_cli_request(entry):
            continue
        normalized_id = _norm(entry.get("deviceId")) or _norm(device_id)
        if not normalized_id or normalized_id in pending_device_ids:
            continue
        roles = set(_role_list(entry))
        if roles and roles != {"operator"}:
            continue
        scopes = _paired_scope_set(entry)
        if scopes != {"operator.pairing"}:
            continue
        paired.pop(device_id, None)
        _clear_identity_device_auth_token(state_dir, normalized_id, "operator")
        removed.append(normalized_id)
    if removed:
        _save_device_state(devices_dir, "paired.json", paired)
    return removed


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
