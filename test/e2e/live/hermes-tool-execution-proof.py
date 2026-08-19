#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Reduce a Hermes session response to fixed E2E tool-execution proof."""

from __future__ import annotations

import json
import sys
from pathlib import Path

MARKER = "__NEMOCLAW_HERMES_TOOL_PROOF__="
MAX_MESSAGES_BYTES = 2 * 1024 * 1024


def _empty_proof(http_status: str) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "messagesHttpStatus": http_status,
        "sessionRecordFound": False,
        "exactTerminalCallCount": 0,
        "otherToolCallCount": 0,
        "matchingToolResultCount": 0,
        "successfulToolResultCount": 0,
        "passed": False,
    }


def _read_document(path: Path) -> object:
    with path.open("rb") as source:
        raw = source.read(MAX_MESSAGES_BYTES + 1)
    if len(raw) > MAX_MESSAGES_BYTES:
        raise ValueError("session response exceeds the size limit")
    return json.loads(raw)


def _tool_arguments(tool_call: object) -> tuple[str, object] | None:
    if not isinstance(tool_call, dict):
        return None
    function = tool_call.get("function")
    if not isinstance(function, dict):
        return None
    name = function.get("name")
    arguments = function.get("arguments")
    if not isinstance(name, str):
        return None
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            return None
    return name, arguments


def project(path: Path, expected_command: str, http_status: str) -> dict[str, object]:
    proof = _empty_proof(http_status)
    try:
        document = _read_document(path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return proof
    if not isinstance(document, dict) or not isinstance(document.get("data"), list):
        return proof

    proof["sessionRecordFound"] = True
    matching_ids: set[str] = set()
    exact_call_count = 0
    other_calls = 0
    for message in document["data"]:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for tool_call in tool_calls:
            parsed = _tool_arguments(tool_call)
            call_id = tool_call.get("id") if isinstance(tool_call, dict) else None
            exact = (
                parsed == ("terminal", {"command": expected_command})
                and isinstance(call_id, str)
                and bool(call_id)
            )
            if exact:
                exact_call_count += 1
                matching_ids.add(call_id)
            else:
                other_calls += 1

    matching_results = 0
    successful_results = 0
    for message in document["data"]:
        if (
            not isinstance(message, dict)
            or message.get("role") != "tool"
            or message.get("tool_name") != "terminal"
            or message.get("tool_call_id") not in matching_ids
        ):
            continue
        matching_results += 1
        content = message.get("content")
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except json.JSONDecodeError:
                content = None
        if (
            isinstance(content, dict)
            and type(content.get("exit_code")) is int
            and content.get("exit_code") == 0
            and content.get("error") is None
        ):
            successful_results += 1

    proof.update(
        {
            "exactTerminalCallCount": exact_call_count,
            "otherToolCallCount": other_calls,
            "matchingToolResultCount": matching_results,
            "successfulToolResultCount": successful_results,
        }
    )
    proof["passed"] = (
        http_status == "200"
        and exact_call_count == 1
        and other_calls == 0
        and matching_results == 1
        and successful_results == 1
    )
    return proof


def main() -> int:
    if len(sys.argv) != 4:
        return 2
    proof = project(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
    print(f"{MARKER}{json.dumps(proof, separators=(',', ':'))}")
    return 0 if proof["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
