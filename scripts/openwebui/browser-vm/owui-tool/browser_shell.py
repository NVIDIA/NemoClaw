# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# browser_shell — OpenWebUI Tool that executes commands inside the user's
# in-browser CheerpX/WebVM sandbox via the browser-vm relay.
#
# Install: OpenWebUI -> Workspace -> Tools -> "+" -> paste this file. Enable it
# on the chat/workspace you test with. Idempotent and safe to auto-enable: it
# only POSTs to the relay; it never shell-escapes or executes anything on the
# OpenWebUI host. Commands are passed verbatim to the sandboxed browser VM.
#
# Config (inject via the tool's "Env" block or the container env):
#   BROWSER_VM_RELAY_URL   default http://127.0.0.1:8787
#   BROWSER_VM_API_KEY     the relay's RELAY_API_KEY (set before enabling)

import json
import os
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Tool metadata (OpenWebUI card)
# ---------------------------------------------------------------------------

__title__ = "Browser VM shell"
__description__ = (
    "Execute shell commands inside the user's ephemeral in-browser Linux VM "
    "and see them run live in their Local VM terminal. The VM is a sandbox "
    "that boots fresh for every chat; nothing it does can touch the host, "
    "Docker, GPUs, or stored secrets. Commands are installed as-needed; the "
    "environment is NOT persistent between chats."
)

RELAY_URL = os.getenv("BROWSER_VM_RELAY_URL", "http://127.0.0.1:8787").rstrip("/")
RELAY_API_KEY = os.getenv("BROWSER_VM_API_KEY", "").strip()

MAX_TIMEOUT_MS = 300000


def _post(path: str, payload: dict, timeout_s: float) -> dict:
    req = urllib.request.Request(
        f"{RELAY_URL}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if RELAY_API_KEY:
        req.add_header("Authorization", f"Bearer {RELAY_API_KEY}")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        try:
            parsed = json.loads(body.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else {"ok": False}
        except Exception:
            return {"ok": False, "error": f"relay_http_{e.code}"}
    except Exception as e:
        return {"ok": False, "error": "relay_unreachable", "message": str(e)}


def _chat_id() -> str:
    # OpenWebUI injects __chat_id into Tools at call time.
    return str(globals().get("__chat_id") or "").strip()


def browser_shell(command: str, cwd: str = "/root", timeout_ms: int = 30000) -> dict:
    """Run `command` in the user's local browser VM for the current chat.

    Args:
        command: Shell command to execute verbatim (never escaped server-side).
        cwd: Working directory in the VM (default /root).
        timeout_ms: Max execution time in milliseconds (30s default, cap 300s).

    Returns:
        {"ok": true, "exit": 0, "stdout": "...", "stderr": ""}
        or an actionable error dict, e.g.
        {"ok": false, "error": "no_browser", "message": "open the Local VM ..."}
    """
    if not RELAY_URL:
        return {"ok": False, "error": "config", "message": "BROWSER_VM_RELAY_URL is not set"}
    chat_id = _chat_id()
    if not chat_id:
        return {"ok": False, "error": "no_chat", "message": "No live chat_id for this call."}
    try:
        timeout_ms = max(1, min(int(timeout_ms), MAX_TIMEOUT_MS))
    except (TypeError, ValueError):
        timeout_ms = 30000
    if not isinstance(command, str) or not command.strip():
        return {"ok": False, "error": "empty_command"}
    result = _post("/api/cmd", {
        "chat_id": chat_id,
        "command": command,
        "cwd": cwd,
        "timeout_ms": timeout_ms,
    }, timeout_s=(timeout_ms / 1000.0) + 15)
    if not isinstance(result, dict):
        return {"ok": False, "error": "bad_response"}
    return result


def browser_vm_status() -> dict:
    """Return whether a fresh browser VM is live for the current chat.

    Lets the model detect and ask the user to open the Local VM panel when the
    VM is not booted, instead of failing mid-task.
    """
    chat_id = _chat_id()
    if not chat_id:
        return {"status": "down", "reason": "no_chat"}
    if not RELAY_URL:
        return {"status": "down", "reason": "config"}
    try:
        with urllib.request.urlopen(
            f"{RELAY_URL}/api/status?chat_id={_urlencode(chat_id)}", timeout=5
        ) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return {"status": data.get("status"), "fresh": bool(data.get("fresh"))}
    except Exception:
        return {"status": "down", "reason": "relay_unreachable"}


def _urlencode(s: str) -> str:
    return urllib.parse.quote(s, safe="")