# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Shared OpenClaw device approval policy for NemoClaw sandbox helpers."""

import os


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
