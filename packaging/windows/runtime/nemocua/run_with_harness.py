# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Experimental native-Windows NemoCUA harness for the existing terminal-agent contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


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


def request_json(url: str, *, method: str = "GET", payload: Any = None) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=body,
        headers={"content-type": "application/json"},
        method=method,
    )
    try:
        with urlopen(request, timeout=60) as response:  # noqa: S310 - fixed loopback URL is validated by caller.
            raw = response.read(4 * 1024 * 1024)
    except (HTTPError, URLError, TimeoutError) as error:
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


def model_action(bridge: str, task: str, observation: dict[str, Any]) -> dict[str, Any]:
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


def qualify(bridge_url: str, result_path: Path) -> int:
    bridge = validated_bridge_url(bridge_url)
    turns: list[dict[str, Any]] = []
    for index, (task, postcondition, token) in enumerate(TURN_TASKS, start=1):
        observation = request_json(f"{bridge}/observe")
        screenshot_hash = observation.get("screenshotSha256")
        if not isinstance(screenshot_hash, str) or len(screenshot_hash) != 64:
            raise HarnessError("NemoCUA observation lacks screenshot evidence")
        action = model_action(bridge, task, observation)
        action_receipt = request_json(f"{bridge}/act", method="POST", payload=action)
        if action_receipt.get("applied") is not True:
            raise HarnessError("NemoCUA browser action was not applied")
        after = request_json(f"{bridge}/observe")
        verify_postcondition(postcondition, after)
        print(f"NEMOCUA> TURN {index} PASS {token}", flush=True)
        turns.append(
            {
                "task": task,
                "action": action,
                "beforeScreenshotSha256": screenshot_hash,
                "afterScreenshotSha256": after["screenshotSha256"],
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
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="run_with_harness.py")
    result.add_argument("--version", action="store_true")
    result.add_argument("--qualification", action="store_true")
    result.add_argument("--bridge-url")
    result.add_argument("--result-path", type=Path)
    return result


def main() -> int:
    args = parser().parse_args()
    if args.version:
        print(VERSION)
        return 0
    if not args.qualification or not args.bridge_url or args.result_path is None:
        parser().error("--qualification, --bridge-url, and --result-path are required")
    return qualify(args.bridge_url, args.result_path)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HarnessError as error:
        print(f"NemoCUA failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
