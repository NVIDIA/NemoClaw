# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# NemoClaw-managed deterministic read-only MCP invocation.
"""Call one coherently read-only MCP tool without model participation."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import sys
from collections.abc import Mapping
from typing import Any, NoReturn

_COMMAND = "tools call-read-only"
_MAX_INPUT_BYTES = 131_072
_MAX_OUTPUT_BYTES = 131_072
_CALL_TIMEOUT_SECONDS = 15
_CLEANUP_TIMEOUT_SECONDS = 3
_MAX_RESULT_DEPTH = 64
_TOOL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
_TOOL_CALL_ID = "nemoclaw-read-only-mcp"


class _DuplicateKeyError(ValueError):
    """Reject ambiguous JSON objects before MCP dispatch."""


class _CallError(RuntimeError):
    """Carry one stable error code without untrusted detail."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKeyError
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> NoReturn:
    raise ValueError


def _read_arguments() -> dict[str, Any]:
    """Read one bounded, unambiguous JSON object from standard input."""
    if sys.stdin.isatty():
        raise _CallError("input_required", "A JSON object is required on standard input.")
    raw = sys.stdin.buffer.read(_MAX_INPUT_BYTES + 1)
    if not raw or len(raw) > _MAX_INPUT_BYTES:
        code = "input_required" if not raw else "input_too_large"
        message = (
            "A JSON object is required on standard input."
            if not raw
            else "The JSON input exceeds the managed size limit."
        )
        raise _CallError(code, message)
    try:
        parsed = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_json_object,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, _DuplicateKeyError, ValueError) as exc:
        raise _CallError("invalid_input", "Standard input must be one JSON object.") from exc
    if not isinstance(parsed, dict):
        raise _CallError("invalid_input", "Standard input must be one JSON object.")
    return parsed


def _error_payload(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "status": "error", "code": code, "message": message}


def _write_envelope(data: Mapping[str, Any], *, exit_code: int) -> NoReturn:
    envelope = {"schema_version": 1, "command": _COMMAND, "data": dict(data)}
    try:
        encoded = json.dumps(
            envelope,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError):
        encoded = json.dumps(
            {
                "schema_version": 1,
                "command": _COMMAND,
                "data": _error_payload(
                    "malformed_result",
                    "The MCP tool returned an unsupported result.",
                ),
            },
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        exit_code = 1
    if len(encoded) > _MAX_OUTPUT_BYTES:
        encoded = json.dumps(
            {
                "schema_version": 1,
                "command": _COMMAND,
                "data": _error_payload(
                    "result_too_large",
                    "The MCP tool result exceeds the managed size limit.",
                ),
            },
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        exit_code = 1
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()
    raise SystemExit(exit_code)


def _consume_bytes(remaining: int, amount: int) -> int:
    if amount > remaining:
        raise _CallError(
            "result_too_large",
            "The MCP tool result exceeds the managed size limit.",
        )
    return remaining - amount


def _consume_string(value: str, remaining: int) -> int:
    remaining = _consume_bytes(remaining, 2)
    for character in value:
        codepoint = ord(character)
        if character in {'"', "\\"} or character in "\b\f\n\r\t":
            width = 2
        elif codepoint < 0x20 or 0x80 <= codepoint <= 0xFFFF:
            width = 6
        elif codepoint > 0xFFFF:
            width = 12
        else:
            width = 1
        remaining = _consume_bytes(remaining, width)
    return remaining


def _consume_json(
    value: Any,
    remaining: int,
    active: set[int],
    depth: int,
) -> int:
    if value is None:
        return _consume_bytes(remaining, 4)
    if type(value) is bool:
        return _consume_bytes(remaining, 4 if value else 5)
    if type(value) is float and not math.isfinite(value):
        raise _CallError(
            "malformed_result",
            "The MCP tool returned an unsupported result.",
        )
    if type(value) in (int, float):
        return _consume_bytes(
            remaining,
            len(json.dumps(value, separators=(",", ":")).encode("utf-8")),
        )
    if type(value) is str:
        return _consume_string(value, remaining)
    if depth >= _MAX_RESULT_DEPTH or not isinstance(value, (Mapping, list, tuple)):
        raise _CallError(
            "malformed_result",
            "The MCP tool returned an unsupported result.",
        )

    identity = id(value)
    if identity in active:
        raise _CallError(
            "malformed_result",
            "The MCP tool returned an unsupported result.",
        )
    active.add(identity)
    try:
        remaining = _consume_bytes(remaining, 2)
        entries = value.items() if isinstance(value, Mapping) else enumerate(value)
        for index, (key, item) in enumerate(entries):
            if index:
                remaining = _consume_bytes(remaining, 1)
            if isinstance(value, Mapping):
                if type(key) is not str:
                    raise _CallError(
                        "malformed_result",
                        "The MCP tool returned an unsupported result.",
                    )
                remaining = _consume_string(key, remaining)
                remaining = _consume_bytes(remaining, 1)
            remaining = _consume_json(item, remaining, active, depth + 1)
        return remaining
    finally:
        active.remove(identity)


def _redact_result(data: Mapping[str, Any]) -> dict[str, Any]:
    """Redact credential-shaped result values without changing JSON structure."""
    _consume_json(data, _MAX_OUTPUT_BYTES, set(), 0)

    from deepagents_code.nemoclaw_observability import redact_secret_values

    try:
        encoded = json.dumps(
            data,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
        )
        redacted = json.loads(redact_secret_values(encoded))
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise _CallError(
            "malformed_result",
            "The MCP tool returned an unsupported result.",
        ) from exc
    if not isinstance(redacted, dict):
        raise _CallError(
            "malformed_result",
            "The MCP tool returned an unsupported result.",
        )
    return redacted


async def _call_read_only_tool(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Resolve and invoke one exact managed MCP tool."""
    from langchain_core.messages import ToolMessage

    from deepagents_code._nemoclaw_managed import managed_mcp_config_path
    from deepagents_code.auto_mode import (
        is_mcp_tool,
        mcp_tool_is_coherently_read_only,
    )
    from deepagents_code.mcp_tools import resolve_and_load_mcp_tools

    config_path = managed_mcp_config_path()
    manager = None
    try:
        tools, manager, _server_info = await resolve_and_load_mcp_tools(
            explicit_config_path=config_path,
            no_mcp=config_path is None,
            trust_project_mcp=False,
        )
        matches = [tool for tool in tools if tool.name == tool_name]
        if len(matches) != 1:
            code = "tool_not_found" if not matches else "ambiguous_tool"
            message = (
                "The exact MCP tool is unavailable."
                if not matches
                else "The exact MCP tool name is ambiguous."
            )
            raise _CallError(code, message)
        tool = matches[0]
        if not is_mcp_tool(tool):
            raise _CallError("not_mcp_tool", "The selected tool is not an MCP tool.")
        if not mcp_tool_is_coherently_read_only(tool):
            raise _CallError(
                "tool_not_read_only",
                "The selected MCP tool is not coherently read-only.",
            )

        result = await tool.ainvoke(
            {
                "type": "tool_call",
                "name": tool_name,
                "args": arguments,
                "id": _TOOL_CALL_ID,
            }
        )
        if not isinstance(result, ToolMessage):
            raise _CallError(
                "malformed_result",
                "The MCP tool returned an unsupported result.",
            )
        if result.status != "success":
            raise _CallError("tool_failed", "The MCP tool reported a failure.")

        data: dict[str, Any] = {
            "ok": True,
            "status": "ok",
            "tool": tool_name,
            "content": result.content,
        }
        if result.artifact is not None:
            if (
                not isinstance(result.artifact, Mapping)
                or set(result.artifact) != {"structured_content"}
                or not isinstance(result.artifact["structured_content"], Mapping)
            ):
                raise _CallError(
                    "malformed_result",
                    "The MCP tool returned an unsupported result.",
                )
            data["structured_content"] = dict(result.artifact["structured_content"])
        return _redact_result(data)
    finally:
        if manager is not None:
            await manager.cleanup()


def _run_bounded(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Run discovery, invocation, and cleanup within one fixed deadline."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    task = loop.create_task(_call_read_only_tool(tool_name, arguments))
    try:
        done, _pending = loop.run_until_complete(
            asyncio.wait({task}, timeout=_CALL_TIMEOUT_SECONDS)
        )
        if task in done:
            return task.result()

        task.cancel()
        loop.run_until_complete(
            asyncio.wait({task}, timeout=_CLEANUP_TIMEOUT_SECONDS)
        )
        raise _CallError(
            "timeout",
            "The managed MCP tool call exceeded its time limit.",
        )
    finally:
        pending = asyncio.all_tasks(loop)
        for pending_task in pending:
            pending_task.cancel()
        if pending:
            loop.run_until_complete(asyncio.wait(pending, timeout=0.1))
        asyncio.set_event_loop(None)
        loop.close()


def _usage() -> NoReturn:
    sys.stdout.write(
        "usage: dcode tools call-read-only TOOL --json\n\n"
        "Read one JSON object from standard input and call one exact, "
        "coherently read-only MCP tool.\n"
    )
    sys.stdout.flush()
    raise SystemExit(0)


def main() -> NoReturn:
    """Validate the fixed command shape and run the managed MCP call."""
    if sys.argv[1:] in (["-h"], ["--help"]):
        _usage()
    if len(sys.argv) != 3 or sys.argv[2] != "--json":
        _write_envelope(
            _error_payload(
                "invalid_command",
                "Use: dcode tools call-read-only TOOL --json",
            ),
            exit_code=2,
        )
    tool_name = sys.argv[1]
    if _TOOL_NAME.fullmatch(tool_name) is None:
        _write_envelope(
            _error_payload("invalid_tool_name", "The MCP tool name is invalid."),
            exit_code=2,
        )

    # MCP setup and tool failures can include resolved configuration or response
    # content. This command emits only the fixed structured errors below.
    logging.disable(logging.CRITICAL)
    try:
        from deepagents_code._nemoclaw_managed import assert_safe_runtime

        assert_safe_runtime()
        arguments = _read_arguments()
        data = _run_bounded(tool_name, arguments)
    except _CallError as exc:
        _write_envelope(_error_payload(exc.code, str(exc)), exit_code=1)
    except KeyboardInterrupt:
        _write_envelope(
            _error_payload("interrupted", "The MCP tool call was interrupted."),
            exit_code=130,
        )
    except Exception:
        _write_envelope(
            _error_payload("runtime_failure", "The managed MCP tool call failed."),
            exit_code=1,
        )
    _write_envelope(data, exit_code=0)


if __name__ == "__main__":
    main()
