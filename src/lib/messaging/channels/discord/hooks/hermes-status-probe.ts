// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Hermes owns connection state and PID reuse detection. Return only fixed states;
// native error messages and account details must stay inside the sandbox.
export const HERMES_DISCORD_STATUS_PROBE = String.raw`
import json, sys
from pathlib import Path
sys.path.insert(0, "/opt/hermes")
state = "unknown"
try:
    from gateway.status import runtime_status_pid_is_live
    with Path("/sandbox/.hermes/runtime/gateway_state.json").open("rb") as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError("oversize status")
    record = json.loads(raw)
    platform = record.get("platforms", {}).get("discord", {})
    pid, start = record.get("pid"), record.get("start_time")
    current = (record.get("kind") == "hermes-gateway"
        and type(pid) is int and pid > 0 and type(start) is int and start > 0
        and type(platform.get("writer_pid")) is int and platform["writer_pid"] == pid
        and type(platform.get("writer_start_time")) is int and platform["writer_start_time"] == start
        and runtime_status_pid_is_live(record))
    if current:
        if platform.get("state") == "fatal" and platform.get("error_code") == "discord_auth_error":
            state = "auth_failed"
        elif record.get("gateway_state") == "running" and platform.get("state") == "connected":
            state = "connected"
        elif platform.get("state") in ("fatal", "disconnected", "retrying", "connecting"):
            state = "inactive"
except Exception:
    pass
print("NEMOCLAW_DISCORD_STATUS_V1")
print(json.dumps({"state": state}))
`;
