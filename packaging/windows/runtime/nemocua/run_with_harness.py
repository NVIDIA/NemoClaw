# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Experimental native-Windows NemoCUA harness for the existing terminal-agent contract."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


VERSION = "0.1.0-windows-experimental"
TURN_TASKS = (
    (
        "Inspect the visible browser task and focus its input field.",
        "inputFocused",
        "NATIVE_NEMOCUA_TURN_1_OK",
    ),
    (
        "Type NEMOCUA_NATIVE_WINDOWS into the focused task input.",
        "inputValue",
        "NATIVE_NEMOCUA_TURN_2_OK",
    ),
    (
        "Submit the task and verify that the browser reports completion.",
        "completed",
        "NATIVE_NEMOCUA_TURN_3_OK",
    ),
)


class HarnessError(RuntimeError):
    """Raised when the browser, model, or action receipt violates the contract."""


class NoBridgeRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(
    url: str,
    *,
    token: str,
    method: str = "GET",
    payload: Any = None,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=body,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        method=method,
    )
    try:
        # This is local IPC carried through the owned MXC file relay. Never use
        # environment/Windows proxy settings or forward its token on redirects.
        with build_opener(ProxyHandler({}), NoBridgeRedirects()).open(request, timeout=60) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise HarnessError("NemoCUA bridge response exceeded its limit")
    except (HTTPError, URLError, TimeoutError) as error:
        if isinstance(error, HTTPError):
            error.close()
        raise HarnessError(f"NemoCUA bridge request failed: {error}") from error
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HarnessError("NemoCUA bridge returned invalid JSON") from error
    if not isinstance(decoded, dict):
        raise HarnessError("NemoCUA bridge response must be an object")
    return decoded


def validated_bridge_url(value: str) -> str:
    if not value.startswith("http://127.0.0.1:") or any(ch in value for ch in "\r\n?#"):
        raise HarnessError("NemoCUA bridge must be a fixed IPv4 loopback endpoint")
    port = value.removeprefix("http://127.0.0.1:")
    if not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise HarnessError("NemoCUA bridge port is invalid")
    return value


def model_action(
    bridge: str,
    token: str,
    task: str,
    observation: dict[str, Any],
) -> dict[str, Any]:
    prompt = {
        "task": task,
        "observation": {
            "url": observation.get("url"),
            "title": observation.get("title"),
            "bodyText": observation.get("bodyText"),
            "screenshotSha256": observation.get("screenshotSha256"),
            "state": observation.get("state"),
        },
    }
    response = request_json(
        f"{bridge}/v1/chat/completions",
        token=token,
        method="POST",
        payload={
            "model": "nemocua-native-preview",
            "messages": [{"role": "user", "content": json.dumps(prompt)}],
            "stream": False,
        },
    )
    try:
        content = response["choices"][0]["message"]["content"]
        action = json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
        raise HarnessError("NemoCUA model response did not contain a valid action") from error
    if not isinstance(action, dict) or action.get("kind") not in {"focus", "type", "click"}:
        raise HarnessError("NemoCUA model action is unsupported")
    return action


def verify_postcondition(name: str, observation: dict[str, Any]) -> None:
    state = observation.get("state")
    if not isinstance(state, dict):
        raise HarnessError("NemoCUA browser observation did not contain state")
    if name == "inputFocused" and state.get("inputFocused") is not True:
        raise HarnessError("NemoCUA did not focus the real browser input")
    if name == "inputValue" and state.get("inputValue") != "NEMOCUA_NATIVE_WINDOWS":
        raise HarnessError("NemoCUA did not type the expected value in the real browser")
    if name == "completed" and state.get("completed") is not True:
        raise HarnessError("NemoCUA did not complete the real browser task")


def run(bridge_url: str, bridge_token: str, result_path: Path) -> int:
    bridge = validated_bridge_url(bridge_url)
    if not bridge_token or len(bridge_token) > 256 or any(ch.isspace() for ch in bridge_token):
        raise HarnessError("NemoCUA bridge token is invalid")
    turns: list[dict[str, Any]] = []
    for index, (task, postcondition, token) in enumerate(TURN_TASKS, start=1):
        observation = request_json(f"{bridge}/observe", token=bridge_token)
        screenshot_hash = observation.get("screenshotSha256")
        if not isinstance(screenshot_hash, str) or len(screenshot_hash) != 64:
            raise HarnessError("NemoCUA observation lacks screenshot evidence")
        action = model_action(bridge, bridge_token, task, observation)
        action_receipt = request_json(
            f"{bridge}/act",
            token=bridge_token,
            method="POST",
            payload=action,
        )
        if action_receipt.get("applied") is not True:
            raise HarnessError("NemoCUA browser action was not applied")
        after = request_json(f"{bridge}/observe", token=bridge_token)
        after_screenshot_hash = after.get("screenshotSha256")
        if not isinstance(after_screenshot_hash, str) or len(after_screenshot_hash) != 64:
            raise HarnessError("NemoCUA observation lacks screenshot evidence")
        verify_postcondition(postcondition, after)
        print(f"NEMOCUA> TURN {index} PASS {token}", flush=True)
        turns.append(
            {
                "task": task,
                "action": action,
                "beforeScreenshotSha256": screenshot_hash,
                "afterScreenshotSha256": after_screenshot_hash,
                "postcondition": postcondition,
                "token": token,
            }
        )

    receipt = {
        "schemaVersion": 1,
        "classification": "native-windows-nemocua-agent-result",
        "nemocuaVersion": VERSION,
        "turnCount": len(turns),
        "turns": turns,
        "modelTransport": "openai-chat-completions-loopback",
        "browserTransport": "playwright-loopback-bridge",
        "verdict": "pass",
    }
    if not result_path.parent.is_dir():
        raise RuntimeError("The host-owned NemoCUA result slot is unavailable")
    with result_path.open("x", encoding="utf-8") as output:
        output.write(json.dumps(receipt, indent=2) + "\n")
        output.flush()
        os.fsync(output.fileno())
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="run_with_harness.py")
    result.add_argument("--version", action="store_true")
    result.add_argument("--qualification", action="store_true")
    result.add_argument("--configured", action="store_true")
    result.add_argument("--bridge-url")
    result.add_argument("--result-path", type=Path)
    return result


def main() -> int:
    args = parser().parse_args()
    if args.version:
        print(VERSION)
        return 0
    if args.qualification == args.configured:
        parser().error("select exactly one of --qualification or --configured")
    bridge_token = os.environ.get("NEMOCLAW_NEMOCUA_BRIDGE_TOKEN", "")
    if not args.bridge_url or not bridge_token or args.result_path is None:
        parser().error("--bridge-url, --result-path, and the inherited bridge token are required")
    return run(args.bridge_url, bridge_token, args.result_path)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HarnessError as error:
        print(f"NemoCUA failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
