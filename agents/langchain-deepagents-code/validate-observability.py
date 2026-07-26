# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate managed observability against the pinned real NeMo Relay runtime."""

from __future__ import annotations

import asyncio
import http.server
import importlib
import importlib.metadata
import importlib.util
import math
import os
import re
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from types import SimpleNamespace
from typing import Any
from typing import cast

import nemo_relay
from langchain.agents.middleware import ModelRequest
from langchain.agents.middleware import ModelResponse
from langchain.agents.middleware.types import ToolCallRequest
from langchain_core.messages import AIMessage
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.callbacks import CallbackManager
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.runnables.config import get_async_callback_manager_for_config
from langchain_core.runnables.config import get_callback_manager_for_config
from langgraph._internal._config import ensure_config as ensure_langgraph_config
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

_EXPECTED_RELAY_VERSION = "0.4.0"
_EXPECTED_LANGGRAPH_VERSION = "1.2.6"
_EXPECTED_PRODUCTION_ENDPOINT = "http://host.openshell.internal:4318/v1/traces"
_EXPECTED_REQUEST_COUNT = 13
_EXPECTED_WIRE_HEADERS = {
    "accept",
    "content-length",
    "content-type",
    "host",
    "user-agent",
}
_MAX_REQUEST_BODY_BYTES = 1_048_576
_SAFE_IDENTIFIER = re.compile(r"[A-Za-z0-9_.:/-]+")

_PROMPT_SECRET = "NEMOCLAW_PROMPT_SECRET"
_CREDENTIAL_SHAPED_SECRET = "sk-EXAMPLE0000000000000000000000"
_WIRE_PROMPT = f"{_PROMPT_SECRET}: {_CREDENTIAL_SHAPED_SECRET}"
_MODEL_OUTPUT_SECRET = "NEMOCLAW_MODEL_OUTPUT_SECRET"
_TOOL_ARGUMENT_SECRET = "NEMOCLAW_TOOL_ARGUMENT_SECRET"
_TOOL_RESULT_SECRET = "NEMOCLAW_TOOL_RESULT_SECRET"
_MODEL_WRAPPER_OUTPUT = "NEMOCLAW_MODEL_WRAPPER_OUTPUT"
_TOOL_MESSAGE_OUTPUT = "NEMOCLAW_TOOL_MESSAGE_OUTPUT"
_OPAQUE_ARTIFACT_SECRET = "NEMOCLAW_OPAQUE_ARTIFACT_SECRET"
_EXCEPTION_SECRET = "NEMOCLAW_EXCEPTION_SECRET"
_AMBIENT_EXPORTER_SECRET = "NEMOCLAW_AMBIENT_EXPORTER_SECRET"
_DROPPED_REQUEST_SURFACE_SECRET = "NEMOCLAW_DROPPED_REQUEST_SURFACE_SECRET"
_TRUNCATION_SENTINEL = "MUST_NOT_REACH_RELAY"
_STABLE_ERROR_CODE = "NEMOCLAW_DCODE_OPERATION_FAILED"
_CONTROL_CHARACTERS = "\r\n\t\x00\u202e"
_OVERLONG_IDENTIFIER = "x" * 200
_HOSTILE_EXCEPTION_DISPATCHES = [0]


@dataclass(frozen=True)
class _CapturedRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


class _HostileCallback(BaseCallbackHandler):
    """Invocation callback that must never enter the managed graph."""


class _OpaqueArtifact:
    def __init__(self) -> None:
        self.api_token = _OPAQUE_ARTIFACT_SECRET

    def __str__(self) -> str:
        return _OPAQUE_ARTIFACT_SECRET


class _HostileMessage:
    def __repr__(self) -> str:
        raise AssertionError("observability evaluated a hostile message repr")

    def __str__(self) -> str:
        raise AssertionError("observability evaluated a hostile message string")


class _HostileException(RuntimeError):
    @property
    def __traceback__(self) -> Any:
        _HOSTILE_EXCEPTION_DISPATCHES[0] += 1
        raise RuntimeError(f"hostile-traceback:{_EXCEPTION_SECRET}")

    def with_traceback(self, _traceback: Any) -> Any:
        _HOSTILE_EXCEPTION_DISPATCHES[0] += 1
        raise RuntimeError(f"hostile-restore:{_EXCEPTION_SECRET}")


class _CollectorServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _CollectorHandler)
        self._capture_lock = threading.Lock()
        self._requests: list[_CapturedRequest] = []
        self._failures: list[str] = []

    def capture(self, request: _CapturedRequest) -> None:
        with self._capture_lock:
            self._requests.append(request)

    def fail(self, message: str) -> None:
        with self._capture_lock:
            self._failures.append(message)

    def snapshot(self) -> tuple[list[_CapturedRequest], list[str]]:
        with self._capture_lock:
            return list(self._requests), list(self._failures)


class _CollectorHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        collector = cast(_CollectorServer, self.server)
        try:
            content_length = int(self.headers.get("content-length", ""))
        except ValueError:
            collector.fail("OTLP request had an invalid content-length")
            self.send_error(400)
            return
        if not 0 < content_length <= _MAX_REQUEST_BODY_BYTES:
            collector.fail("OTLP request body exceeded the validation bound")
            self.send_error(413)
            return

        body = self.rfile.read(content_length)
        if len(body) != content_length:
            collector.fail("OTLP request body was truncated")
            self.send_error(400)
            return
        collector.capture(
            _CapturedRequest(
                method="POST",
                path=self.path,
                headers={key.lower(): value for key, value in self.headers.items()},
                body=body,
            )
        )
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, _format: str, *_args: Any) -> None:
        pass


def _load_observability_module() -> ModuleType:
    """Import the patched package module, or an explicit source path for local checks."""
    if len(sys.argv) == 1:
        return importlib.import_module("deepagents_code.nemoclaw_observability")
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate-observability.py [nemoclaw_observability.py]")

    path = Path(sys.argv[1]).resolve(strict=True)
    spec = importlib.util.spec_from_file_location(
        "nemoclaw_observability_validation", path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load observability module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _raw_identifier(prefix: str) -> str:
    return (
        f"{prefix}{_CONTROL_CHARACTERS}{_OVERLONG_IDENTIFIER}"
        f"-{_TRUNCATION_SENTINEL}"
    )


def _tool_request(name: str) -> ToolCallRequest:
    return ToolCallRequest(
        tool_call={
            "name": name,
            "args": {"command": _TOOL_ARGUMENT_SECRET},
            "id": "managed-observability-validation",
        },
        tool=None,
        state={},
        runtime=None,
    )


def _assert_original_exception(
    caught: BaseException,
    expected: BaseException,
    handler_name: str,
) -> None:
    if caught is not expected:
        raise AssertionError(f"Relay changed the {handler_name} exception identity")
    traceback = BaseException.__traceback__.__get__(caught, BaseException)
    frame_names: list[str] = []
    while traceback is not None:
        frame_names.append(traceback.tb_frame.f_code.co_name)
        traceback = traceback.tb_next
    if handler_name not in frame_names:
        raise AssertionError(f"Relay removed the {handler_name} traceback frame")


async def _exercise_async_boundaries(
    observability: ModuleType,
    middleware: Any,
    raw_names: dict[str, str],
) -> None:
    request = nemo_relay.LLMRequest(
        {"authorization": _PROMPT_SECRET},
        {
            "model": raw_names["model"],
            "messages": [{"role": "user", "content": _WIRE_PROMPT}],
            "model_settings": {"api_key": _DROPPED_REQUEST_SURFACE_SECRET},
            "response_format": {"schema": _DROPPED_REQUEST_SURFACE_SECRET},
            "tools": [{"description": _DROPPED_REQUEST_SURFACE_SECRET}],
        },
    )

    async def successful_model(inner_request: Any) -> dict[str, str]:
        if inner_request.headers != {"authorization": _PROMPT_SECRET}:
            raise AssertionError("model telemetry changed execution headers")
        if inner_request.content["messages"][0]["content"] != _WIRE_PROMPT:
            raise AssertionError("model telemetry changed the execution prompt")
        return {"content": _MODEL_OUTPUT_SECRET}

    model_result = await middleware._llm_execute(
        raw_names["model"],
        request,
        None,
        None,
        successful_model,
    )
    if model_result != {"content": _MODEL_OUTPUT_SECRET}:
        raise AssertionError("model telemetry changed the callback result")

    async_model_error = RuntimeError(f"async-model:{_EXCEPTION_SECRET}")

    async def failing_async_model(_request: Any) -> Any:
        raise async_model_error

    try:
        await middleware._llm_execute(
            "failure-model", request, None, None, failing_async_model
        )
    except RuntimeError as caught:
        _assert_original_exception(caught, async_model_error, "failing_async_model")
    else:
        raise AssertionError("Relay swallowed the async model exception")

    hostile_cause = ValueError(f"hostile-cause:{_EXCEPTION_SECRET}")
    hostile_error = _HostileException(f"hostile-error:{_EXCEPTION_SECRET}")
    hostile_error.__cause__ = hostile_cause

    async def hostile_async_model(_request: Any) -> Any:
        raise hostile_error

    try:
        await middleware._llm_execute(
            "hostile-model", request, None, None, hostile_async_model
        )
    except RuntimeError as caught:
        _assert_original_exception(caught, hostile_error, "hostile_async_model")
        cause = BaseException.__cause__.__get__(caught, BaseException)
        if cause is not hostile_cause:
            raise AssertionError("Relay removed the hostile exception cause")
        if _HOSTILE_EXCEPTION_DISPATCHES[0] != 0:
            raise AssertionError("observability used hostile exception dispatch")
    else:
        raise AssertionError("Relay swallowed the hostile async model exception")

    async_request = _tool_request(raw_names["async_tool"])

    async def successful_async_tool(inner_request: Any) -> dict[str, str]:
        if inner_request.tool_call["args"] != {"command": _TOOL_ARGUMENT_SECRET}:
            raise AssertionError("tool telemetry changed execution arguments")
        return {"result": _TOOL_RESULT_SECRET}

    tool_result = await middleware.awrap_tool_call(
        async_request, successful_async_tool
    )
    if tool_result != {"result": _TOOL_RESULT_SECRET}:
        raise AssertionError("tool telemetry changed the callback result")

    async_tool_error = RuntimeError(f"async-tool:{_EXCEPTION_SECRET}")

    async def failing_async_tool(_request: Any) -> Any:
        raise async_tool_error

    try:
        await middleware.awrap_tool_call(async_request, failing_async_tool)
    except RuntimeError as caught:
        _assert_original_exception(caught, async_tool_error, "failing_async_tool")
    else:
        raise AssertionError("Relay swallowed the async tool exception")

    control_flow_error = KeyboardInterrupt(f"control-flow:{_EXCEPTION_SECRET}")

    async def interrupted_model(_request: Any) -> Any:
        raise control_flow_error

    try:
        await middleware._llm_execute(
            "interrupt-model", request, None, None, interrupted_model
        )
    except KeyboardInterrupt as caught:
        _assert_original_exception(caught, control_flow_error, "interrupted_model")
    else:
        raise AssertionError("Relay swallowed the control-flow exception")

    if not observability._lifecycle.active:
        raise AssertionError("observability deactivated while handling callbacks")


def _exercise_sync_tool(middleware: Any, raw_tool_name: str) -> None:
    request = _tool_request(raw_tool_name)
    sync_tool_error = RuntimeError(f"sync-tool:{_EXCEPTION_SECRET}")

    def failing_sync_tool(inner_request: Any) -> Any:
        if inner_request.tool_call["args"] != {"command": _TOOL_ARGUMENT_SECRET}:
            raise AssertionError("tool telemetry changed sync execution arguments")
        raise sync_tool_error

    try:
        middleware.wrap_tool_call(request, failing_sync_tool)
    except RuntimeError as caught:
        _assert_original_exception(caught, sync_tool_error, "failing_sync_tool")
    else:
        raise AssertionError("Relay swallowed the sync tool exception")


def _exercise_framework_result_transparency(middleware: Any) -> None:
    model_request = ModelRequest(
        model=SimpleNamespace(model="managed-wrapper-model"),
        messages=[HumanMessage(content=_PROMPT_SECRET)],
    )
    expected_model_result = ModelResponse(
        result=[AIMessage(content=_MODEL_WRAPPER_OUTPUT)],
        structured_response={"value": float("nan")},
    )

    def model_handler(_request: Any) -> ModelResponse[Any]:
        return expected_model_result

    actual_model_result = middleware.wrap_model_call(model_request, model_handler)
    if actual_model_result is not expected_model_result:
        raise AssertionError("observability replaced the LangChain ModelResponse")
    structured_value = actual_model_result.structured_response["value"]
    if not math.isnan(structured_value):
        raise AssertionError("observability mutated non-finite structured model output")

    artifact = _OpaqueArtifact()
    expected_tool_result = ToolMessage(
        content=_TOOL_MESSAGE_OUTPUT,
        tool_call_id="managed-observability-validation",
        artifact=artifact,
    )

    def tool_handler(_request: Any) -> ToolMessage:
        return expected_tool_result

    actual_tool_result = middleware.wrap_tool_call(
        _tool_request("framework-result-tool"), tool_handler
    )
    if actual_tool_result is not expected_tool_result:
        raise AssertionError("observability replaced the LangChain ToolMessage")
    if actual_tool_result.artifact is not artifact:
        raise AssertionError("observability mutated the ToolMessage artifact")


def _exercise_real_relay_json_domain(middleware: Any) -> None:
    original_args = {
        "huge_negative": -(10**1000),
        "huge_positive": 10**1000,
        "lone_surrogate": "before\ud800after",
    }
    expected_result = {
        "huge_result": 10**1000,
        "lone_surrogate_result": "before\udfffafter",
    }
    request = ToolCallRequest(
        tool_call={
            "name": "relay-json-domain-tool",
            "args": original_args,
            "id": "managed-observability-json-domain",
        },
        tool=None,
        state={},
        runtime=None,
    )
    calls = 0

    def handler(inner_request: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        if inner_request.tool_call["args"] != original_args:
            raise AssertionError("observability mutated non-Relay-safe tool arguments")
        return expected_result

    actual_result = middleware.wrap_tool_call(request, handler)
    if calls != 1 or actual_result is not expected_result:
        raise AssertionError("Relay changed a non-Relay-safe application value")


def _exercise_relay_failure_transparency(middleware: Any) -> None:
    request = _tool_request("relay-failure-tool")
    expected_result = object()
    original_execute = nemo_relay.tools.execute

    def run_case(mode: str) -> None:
        calls = 0

        def handler(_request: Any) -> Any:
            nonlocal calls
            calls += 1
            return expected_result

        async def injected_execute(**kwargs: Any) -> Any:
            if mode == "before":
                raise RuntimeError("injected Relay failure before callback")
            await original_execute(**kwargs)
            raise RuntimeError("injected Relay failure after callback")

        nemo_relay.tools.execute = injected_execute
        try:
            actual_result = middleware.wrap_tool_call(request, handler)
        finally:
            nemo_relay.tools.execute = original_execute
        if calls != 1 or actual_result is not expected_result:
            raise AssertionError(
                f"Relay {mode}-callback failure changed application execution"
            )

    run_case("before")
    run_case("after")

    fallback_cause = ValueError("fallback application cause")
    fallback_context = LookupError("fallback application context")
    fallback_error = RuntimeError("fallback application error")
    fallback_error.__cause__ = fallback_cause
    fallback_error.__context__ = fallback_context
    fallback_calls = 0

    def failing_fallback_handler(_request: Any) -> Any:
        nonlocal fallback_calls
        fallback_calls += 1
        raise fallback_error

    async def fail_before_callback(**_kwargs: Any) -> Any:
        raise RuntimeError("injected Relay failure before callback")

    nemo_relay.tools.execute = fail_before_callback
    try:
        try:
            middleware.wrap_tool_call(request, failing_fallback_handler)
        except RuntimeError as caught:
            if caught is not fallback_error or fallback_calls != 1:
                raise AssertionError("Relay changed the fallback application error")
            cause = BaseException.__cause__.__get__(caught, BaseException)
            context = BaseException.__context__.__get__(caught, BaseException)
            if cause is not fallback_cause or context is not fallback_context:
                raise AssertionError("Relay contaminated fallback exception chaining")
        else:
            raise AssertionError("Relay swallowed the fallback application error")
    finally:
        nemo_relay.tools.execute = original_execute

    application_error = RuntimeError(f"relay-control:{_EXCEPTION_SECRET}")
    control_flow = KeyboardInterrupt("operator interrupt")
    control_calls = 0

    def interrupted_handler(_request: Any) -> Any:
        nonlocal control_calls
        control_calls += 1
        raise application_error

    async def replace_relay_error_with_control_flow(**kwargs: Any) -> Any:
        try:
            return await original_execute(**kwargs)
        except Exception:
            raise control_flow

    nemo_relay.tools.execute = replace_relay_error_with_control_flow
    try:
        try:
            middleware.wrap_tool_call(request, interrupted_handler)
        except KeyboardInterrupt as caught:
            if caught is not control_flow or control_calls != 1:
                raise AssertionError("observability changed Relay control flow")
        else:
            raise AssertionError("observability swallowed Relay control flow")
    finally:
        nemo_relay.tools.execute = original_execute


def _assert_capture_traversal_bounds(observability: ModuleType) -> None:
    shared: list[Any] = ["leaf"]
    for _ in range(observability._MAX_CAPTURE_DEPTH + 1):
        shared = [shared] * observability._MAX_CAPTURE_ITEMS
    captured_shared = observability._bounded_capture(shared)
    encoded_shared = repr(captured_shared)
    if len(encoded_shared) > observability._MAX_CAPTURE_JSON_CHARS:
        raise AssertionError("shared-container capture exceeded the aggregate bound")
    if "shared_or_cycle" not in encoded_shared:
        raise AssertionError("shared-container capture did not record reference omission")

    cyclic: list[Any] = []
    cyclic.append(cyclic)
    captured_cycle = observability._bounded_capture(cyclic)
    if "shared_or_cycle" not in repr(captured_cycle):
        raise AssertionError("cyclic capture did not terminate with a reference marker")

    large_request = SimpleNamespace(
        model=SimpleNamespace(model="bounded-message-model"),
        system_message=None,
        messages=[HumanMessage(content="x" * 9_000) for _ in range(100)]
        + [_HostileMessage()],
    )
    _, captured_request = observability._bounded_model_call_request(large_request)
    encoded_request = repr(captured_request.content)
    if len(encoded_request) > observability._MAX_CAPTURE_JSON_CHARS:
        raise AssertionError("projected model messages exceeded the aggregate bound")
    if "_truncated" not in encoded_request:
        raise AssertionError("projected model messages did not record truncation")

    large_response = ModelResponse(
        result=[AIMessage(content="y" * 9_000) for _ in range(100)]
    )
    encoded_response = repr(observability._bounded_model_call_response(large_response))
    if len(encoded_response) > observability._MAX_CAPTURE_JSON_CHARS:
        raise AssertionError("projected model response exceeded the aggregate bound")
    if "_truncated" not in encoded_response:
        raise AssertionError("projected model response did not record truncation")


def _assert_secret_value_redaction(observability: ModuleType) -> None:
    private_key_marker = "PRIVATE" + " KEY"
    private_key_probe = (
        f"-----BEGIN TEST {private_key_marker}-----\nopaque-private-key-material\n"
        f"-----END TEST {private_key_marker}-----"
    )
    probes = (
        (
            "reported OpenAI-shaped token",
            f"My key is {_CREDENTIAL_SHAPED_SECRET} - do not repeat.",
            _CREDENTIAL_SHAPED_SECRET,
        ),
        (
            "standalone provider key",
            "nvapi-abcdefghijklmnop",
            "nvapi-abcdefghijklmnop",
        ),
        (
            "case-insensitive bearer token",
            "Authorization: bEaReR\ufeffopaqueRandomSessionTokenZ1234567890",
            "opaqueRandomSessionTokenZ1234567890",
        ),
        (
            "case-insensitive key assignment",
            "Api_Key=opaqueCredentialPayloadZ1234567890",
            "opaqueCredentialPayloadZ1234567890",
        ),
        (
            "case-insensitive passwd assignment",
            "Custom_Passwd=opaqueCredentialPayloadZ1234567890",
            "opaqueCredentialPayloadZ1234567890",
        ),
        (
            "password-leading punctuation",
            "Custom_Pass=!OpaquePassword123",
            "!OpaquePassword123",
        ),
        (
            "password-tail punctuation",
            "Custom_Pass=abcdefghij!tail-secret",
            "tail-secret",
        ),
        (
            "private key block",
            private_key_probe,
            "opaque-private-key-material",
        ),
    )
    for label, value, forbidden in probes:
        encoded = repr(observability._bounded_capture({"content": value}))
        if forbidden in encoded:
            raise AssertionError(f"{label} survived capture redaction")
        if observability._REDACTED_SECRET_VALUE not in encoded:
            raise AssertionError(f"{label} was not replaced by the redaction marker")

    benign_values = (
        "sk-too-short",
        "Bearer short",
        "COMPASS=opaqueNonSecretPayload123",
        "BYPASS=allowedValue123",
        "-----BEGIN PUBLIC KEY-----\nnot-private\n-----END PUBLIC KEY-----",
    )
    for value in benign_values:
        if observability._bounded_capture(value) != value:
            raise AssertionError(f"benign near-miss was redacted: {value!r}")

    original_scrubber = observability._scrub_secret_values
    scrubbed_lengths: list[int] = []

    def recording_scrubber(
        value: str, *, source_was_truncated: bool = False
    ) -> str:
        scrubbed_lengths.append(len(value))
        return original_scrubber(
            value, source_was_truncated=source_was_truncated
        )

    repeated_secret = f"{_CREDENTIAL_SHAPED_SECRET} " * 400
    budget = observability._CaptureBudget()
    observability._scrub_secret_values = recording_scrubber
    try:
        captured = observability._capture_jsonable(repeated_secret, budget=budget)
    finally:
        observability._scrub_secret_values = original_scrubber
    if scrubbed_lengths != [observability._MAX_CAPTURE_STRING_CHARS]:
        raise AssertionError(
            "secret scrubbing did not run only on the bounded source segment"
        )
    expected_remaining = (
        observability._MAX_CAPTURE_AGGREGATE_STRING_CHARS
        - observability._MAX_CAPTURE_STRING_CHARS
    )
    if budget.remaining_string_chars != expected_remaining:
        raise AssertionError("secret redaction changed source-character budget accounting")
    truncated_chars = len(repeated_secret) - observability._MAX_CAPTURE_STRING_CHARS
    if f"[truncated {truncated_chars} chars]" not in captured:
        raise AssertionError("secret-heavy source did not retain its truncation marker")
    if _CREDENTIAL_SHAPED_SECRET in captured:
        raise AssertionError("bounded secret-heavy source retained a raw credential")

    boundary_probes = (
        ("provider prefix", _CREDENTIAL_SHAPED_SECRET),
        ("AWS access key", "AK" + "IA" + "ABCDEFGHIJKLMNOP"),
        (
            "Telegram token",
            "bot123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678",
        ),
        (
            "Discord token",
            "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
        ),
        ("Bearer token", "Bearer ABCDEFGHIJ"),
        # Context patterns require a real non-identifier boundary. Without the
        # space this is an oversized x...Api_Key identifier, not an assignment.
        ("key assignment", " " + "Api_" + "Key" + "=" + "ABCDEFGHIJ"),
    )
    for label, credential in boundary_probes:
        boundary_prefix = credential[:-3]
        boundary_value = (
            "x" * (observability._MAX_CAPTURE_STRING_CHARS - len(boundary_prefix))
            + credential
        )
        boundary_capture = observability._bounded_capture(boundary_value)
        if boundary_prefix in boundary_capture:
            raise AssertionError(f"capture boundary retained a partial {label}")
        if observability._REDACTED_SECRET_VALUE not in boundary_capture:
            raise AssertionError(f"capture-boundary {label} lacks a redaction marker")

    mapping_keys = (
        "sk-AAAAAAAAAAAAAAAAAAAA",
        "sk-BBBBBBBBBBBBBBBBBBBB",
    )
    mapping_capture = observability._bounded_capture(
        {mapping_keys[0]: "first", mapping_keys[1]: "second"}
    )
    encoded_mapping = repr(mapping_capture)
    if any(key in encoded_mapping for key in mapping_keys):
        raise AssertionError("credential-shaped mapping key survived redaction")
    if set(mapping_capture.values()) != {"first", "second"}:
        raise AssertionError("redacted mapping-key collision dropped captured values")
    if not all(
        observability._REDACTED_SECRET_VALUE in key for key in mapping_capture
    ):
        raise AssertionError("credential-shaped mapping key lacks a redaction marker")

    identifier = observability._safe_identifier(
        f"tool-{mapping_keys[0]}", "unknown"
    )
    if mapping_keys[0] in identifier or "redacted-secret" not in identifier:
        raise AssertionError("credential-shaped identifier survived redaction")
    expanding_identifier_source = ("hf_aaaaaaaaaa-" * 9).rstrip("-")
    expanding_identifier = observability._safe_identifier(
        expanding_identifier_source, "unknown"
    )
    if len(expanding_identifier) > observability._MAX_SCOPE_NAME_CHARS:
        raise AssertionError("redaction expansion exceeded the identifier bound")
    if "hf_aaaaaaaaaa" in expanding_identifier:
        raise AssertionError("expanded identifier retained a raw credential")

    unterminated_private_key = (
        "-----BEGIN TEST PRIVATE KEY-----\n" + "private-key-body" * 1_000
    )
    captured_private_key = observability._bounded_capture(unterminated_private_key)
    if "private-key-body" in captured_private_key:
        raise AssertionError("bounded private key prefix retained partial key material")
    if observability._REDACTED_SECRET_VALUE not in captured_private_key:
        raise AssertionError("bounded private key prefix lacks the redaction marker")


def _exercise_graph(observability: ModuleType, raw_graph_name: str) -> None:
    callback = observability.new_metadata_only_callback_handler()
    callback.on_chain_start(
        None,
        {},
        run_id="managed-observability-validation",
        name=raw_graph_name,
    )
    callback.on_chain_error(
        RuntimeError(f"graph:{_EXCEPTION_SECRET}"),
        run_id="managed-observability-validation",
    )


def _safe_names(
    observability: ModuleType, raw_names: dict[str, str]
) -> dict[str, str]:
    fallbacks = {
        "model": "unknown",
        "sync_tool": "unknown",
        "async_tool": "unknown",
        "graph": "LangGraph",
    }
    safe_names = {
        name: observability._safe_identifier(value, fallbacks[name])
        for name, value in raw_names.items()
    }
    for name, value in safe_names.items():
        if len(value) > 128:
            raise AssertionError(f"{name} identifier exceeds the 128-character cap")
        if _SAFE_IDENTIFIER.fullmatch(value) is None:
            raise AssertionError(f"{name} identifier contains an unsafe character")
        if _TRUNCATION_SENTINEL in value:
            raise AssertionError(f"{name} identifier was not truncated")
    return safe_names


def _assert_only_managed_handler(manager: Any, managed_handler: Any) -> None:
    if manager.handlers != [managed_handler]:
        raise AssertionError("an invocation callback entered the managed handler set")
    if manager.inheritable_handlers != [managed_handler]:
        raise AssertionError("an invocation callback became inheritable")


def _assert_unique_attributes(attributes: Any, location: str) -> None:
    seen: set[str] = set()
    for attribute in attributes:
        if attribute.key in seen:
            raise AssertionError(f"{location} contains duplicate OTLP attribute keys")
        seen.add(attribute.key)


def _assert_unique_otlp_attribute_keys(body: bytes, request_index: int) -> None:
    request = ExportTraceServiceRequest.FromString(body)
    for resource_index, resource_spans in enumerate(request.resource_spans, 1):
        resource_location = (
            f"OTLP request {request_index} resource {resource_index}"
        )
        _assert_unique_attributes(
            resource_spans.resource.attributes, resource_location
        )
        for scope_index, scope_spans in enumerate(resource_spans.scope_spans, 1):
            scope_location = f"{resource_location} scope {scope_index}"
            _assert_unique_attributes(
                scope_spans.scope.attributes, scope_location
            )
            for span_index, span in enumerate(scope_spans.spans, 1):
                span_location = f"{scope_location} span {span_index}"
                _assert_unique_attributes(span.attributes, span_location)
                for event_index, event in enumerate(span.events, 1):
                    _assert_unique_attributes(
                        event.attributes,
                        f"{span_location} event {event_index}",
                    )
                for link_index, link in enumerate(span.links, 1):
                    _assert_unique_attributes(
                        link.attributes,
                        f"{span_location} link {link_index}",
                    )


def _assert_callback_manager_boundary(observability: ModuleType) -> None:
    bound_manager = observability.new_metadata_only_callback_manager()
    managed_handler = bound_manager.handlers[0]
    hostile_handler = _HostileCallback()

    bound_manager.add_handler(hostile_handler)
    bound_manager.set_handler(hostile_handler)
    bound_manager.set_handlers([hostile_handler])
    bound_manager.remove_handler(managed_handler)
    _assert_only_managed_handler(bound_manager, managed_handler)
    _assert_only_managed_handler(bound_manager.copy(), managed_handler)

    hostile_manager = CallbackManager(
        handlers=[hostile_handler],
        inheritable_handlers=[hostile_handler],
        tags=["invocation-manager-tag"],
        inheritable_tags=["invocation-manager-inheritable-tag"],
        metadata={"invocation_manager": "preserved"},
        inheritable_metadata={"invocation_manager_inheritable": "preserved"},
    )
    merged_manager = bound_manager.merge(hostile_manager)
    _assert_only_managed_handler(merged_manager, managed_handler)
    if merged_manager.tags != ["invocation-manager-tag"]:
        raise AssertionError("callback-manager tags were not preserved")
    if merged_manager.metadata != {"invocation_manager": "preserved"}:
        raise AssertionError("callback-manager metadata was not preserved")

    # Pregel 1.2.6 invokes this as ensure_config(self.config, input_config).
    list_config = ensure_langgraph_config(
        {
            "callbacks": bound_manager,
            "tags": ["managed-tag"],
            "metadata": {"managed": "preserved"},
        },
        {
            "callbacks": [hostile_handler],
            "tags": ["invocation-list-tag"],
            "metadata": {"invocation_list": "preserved"},
        },
    )
    manager_config = ensure_langgraph_config(
        {"callbacks": bound_manager},
        {"callbacks": hostile_manager},
    )
    configured_cases = (
        (
            list_config,
            {"managed-tag", "invocation-list-tag"},
            {"managed": "preserved", "invocation_list": "preserved"},
        ),
        (
            manager_config,
            {"invocation-manager-tag"},
            {"invocation_manager": "preserved"},
        ),
    )
    for config, expected_tags, expected_metadata in configured_cases:
        _assert_only_managed_handler(config["callbacks"], managed_handler)
        sync_manager = get_callback_manager_for_config(config)
        async_manager = get_async_callback_manager_for_config(config)
        for configured_manager in (sync_manager, async_manager):
            _assert_only_managed_handler(configured_manager, managed_handler)
            if set(configured_manager.tags) != expected_tags:
                raise AssertionError("configured callback tags were not preserved")
            if configured_manager.metadata != expected_metadata:
                raise AssertionError("configured callback metadata was not preserved")

    if set(list_config["tags"]) != {"managed-tag", "invocation-list-tag"}:
        raise AssertionError("runnable tags were not preserved")
    if list_config["metadata"] != {
        "managed": "preserved",
        "invocation_list": "preserved",
    }:
        raise AssertionError("runnable metadata was not preserved")


def _assert_wire_requests(
    requests: list[_CapturedRequest],
    failures: list[str],
    observability: ModuleType,
    raw_names: dict[str, str],
) -> int:
    if failures:
        raise AssertionError(f"loopback collector failures: {failures}")
    if len(requests) != _EXPECTED_REQUEST_COUNT:
        raise AssertionError(
            f"expected {_EXPECTED_REQUEST_COUNT} OTLP requests, received {len(requests)}"
        )

    for request_index, request in enumerate(requests, 1):
        if request.method != "POST" or request.path != "/v1/traces":
            raise AssertionError(
                f"unexpected OTLP route: {request.method} {request.path}"
            )
        header_names = set(request.headers)
        if header_names != _EXPECTED_WIRE_HEADERS:
            raise AssertionError(
                f"unexpected OTLP wire headers: {sorted(header_names)}"
            )
        if request.headers["content-type"] != "application/x-protobuf":
            raise AssertionError("OTLP request is not binary protobuf")
        if int(request.headers["content-length"]) != len(request.body):
            raise AssertionError("OTLP content-length does not match its body")
        _assert_unique_otlp_attribute_keys(request.body, request_index)

    bodies = b"".join(request.body for request in requests)
    header_values = "\n".join(
        value for request in requests for value in request.headers.values()
    ).encode()
    captured_content = (
        _PROMPT_SECRET,
        _MODEL_OUTPUT_SECRET,
        _TOOL_ARGUMENT_SECRET,
        _TOOL_RESULT_SECRET,
        _MODEL_WRAPPER_OUTPUT,
        _TOOL_MESSAGE_OUTPUT,
    )
    for sentinel in captured_content:
        if sentinel.encode() not in bodies:
            raise AssertionError(f"expected captured content {sentinel} is absent from OTLP")
    credential_bytes = _CREDENTIAL_SHAPED_SECRET.encode()
    if credential_bytes in bodies or credential_bytes in header_values:
        raise AssertionError("credential-shaped prompt content reached the OTLP request")
    if observability._REDACTED_SECRET_VALUE.encode() not in bodies:
        raise AssertionError("credential-shaped OTLP content lacks the redaction marker")
    relay_json_content = (
        observability._OUT_OF_RANGE_INTEGER,
        "before\ufffdafter",
    )
    for sentinel in relay_json_content:
        if sentinel.encode() not in bodies:
            raise AssertionError(
                f"normalized Relay JSON content {sentinel} is absent from OTLP"
            )

    excluded = (
        _EXCEPTION_SECRET,
        _AMBIENT_EXPORTER_SECRET,
        _DROPPED_REQUEST_SURFACE_SECRET,
        _OPAQUE_ARTIFACT_SECRET,
        _TRUNCATION_SENTINEL,
    )
    for sentinel in excluded:
        encoded = sentinel.encode()
        if encoded in bodies or encoded in header_values:
            raise AssertionError(f"sensitive {sentinel} reached the OTLP request")
    for sentinel in captured_content:
        if sentinel.encode() in header_values:
            raise AssertionError(f"captured content {sentinel} reached OTLP HTTP headers")

    stable_message = observability._REDACTED_EXCEPTION_MESSAGE.encode()
    if stable_message not in bodies or _STABLE_ERROR_CODE.encode() not in bodies:
        raise AssertionError("stable redacted error code is absent from OTLP")
    if observability._SERVICE_NAME.encode() not in bodies:
        raise AssertionError("managed service name is absent from OTLP")

    for name, safe_value in _safe_names(observability, raw_names).items():
        if safe_value.encode() not in bodies:
            raise AssertionError(f"sanitized {name} identifier is absent from OTLP")
        if raw_names[name].encode() in bodies:
            raise AssertionError(f"raw {name} identifier reached OTLP")

    return len(bodies)


def _set_validation_environment(canary_endpoint: str) -> dict[str, str | None]:
    values = {
        "NEMOCLAW_OBSERVABILITY": "1",
        "LANGCHAIN_TRACING": "false",
        "LANGCHAIN_TRACING_V2": "false",
        "LANGSMITH_TRACING": "false",
        "LANGSMITH_TRACING_V2": "false",
        "OTEL_ENABLED": "true",
        "OTEL_SDK_DISABLED": "true",
        "OTEL_SERVICE_NAME": _AMBIENT_EXPORTER_SECRET,
        "OTEL_RESOURCE_ATTRIBUTES": (
            f"service.name={_AMBIENT_EXPORTER_SECRET},ambient.secret="
            f"{_AMBIENT_EXPORTER_SECRET}"
        ),
        "OTEL_TRACES_SAMPLER": "always_off",
        "OTEL_EXPORTER_OTLP_ENDPOINT": canary_endpoint,
        "OTEL_EXPORTER_OTLP_HEADERS": (
            f"authorization={_AMBIENT_EXPORTER_SECRET}"
        ),
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": canary_endpoint,
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS": (
            f"x-api-key={_AMBIENT_EXPORTER_SECRET}"
        ),
        "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
        "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/protobuf",
        "OTEL_EXPORTER_OTLP_COMPRESSION": "gzip",
        "OTEL_EXPORTER_OTLP_TIMEOUT": "999999",
        "OTEL_EXPORTER_OTLP_CERTIFICATE": (
            f"/nonexistent/{_AMBIENT_EXPORTER_SECRET}/ca.pem"
        ),
        "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE": (
            f"/nonexistent/{_AMBIENT_EXPORTER_SECRET}/client.pem"
        ),
        "OTEL_EXPORTER_OTLP_CLIENT_KEY": (
            f"/nonexistent/{_AMBIENT_EXPORTER_SECRET}/client.key"
        ),
    }
    previous = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    return previous


def _restore_environment(previous: dict[str, str | None]) -> None:
    for name, value in previous.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value


def main() -> None:
    observability = _load_observability_module()
    relay_version = importlib.metadata.version("nemo-relay")
    if relay_version != _EXPECTED_RELAY_VERSION:
        raise AssertionError(
            f"expected nemo-relay {_EXPECTED_RELAY_VERSION}, found {relay_version}"
        )
    langgraph_version = importlib.metadata.version("langgraph")
    if langgraph_version != _EXPECTED_LANGGRAPH_VERSION:
        raise AssertionError(
            f"expected langgraph {_EXPECTED_LANGGRAPH_VERSION}, found {langgraph_version}"
        )
    if observability._OTLP_ENDPOINT != _EXPECTED_PRODUCTION_ENDPOINT:
        raise AssertionError(
            f"unexpected production OTLP endpoint: {observability._OTLP_ENDPOINT}"
        )

    raw_names = {
        "model": _raw_identifier("model"),
        "sync_tool": _raw_identifier("sync-tool"),
        "async_tool": _raw_identifier("async-tool"),
        "graph": _raw_identifier("graph"),
    }
    _safe_names(observability, raw_names)

    collector = _CollectorServer()
    canary = _CollectorServer()
    collector_thread = threading.Thread(target=collector.serve_forever, daemon=True)
    canary_thread = threading.Thread(target=canary.serve_forever, daemon=True)
    collector_thread.start()
    canary_thread.start()
    original_endpoint = observability._OTLP_ENDPOINT
    previous_environment = _set_validation_environment(
        f"http://127.0.0.1:{canary.server_port}/v1/traces"
    )
    initialized = False
    try:
        observability._OTLP_ENDPOINT = (
            f"http://127.0.0.1:{collector.server_port}/v1/traces"
        )
        initialized = observability.initialize_observability()
        if not initialized or observability._lifecycle.subscriber is None:
            raise AssertionError("real Relay observability failed to initialize")

        _assert_callback_manager_boundary(observability)
        _assert_capture_traversal_bounds(observability)
        _assert_secret_value_redaction(observability)
        middleware = observability.new_relay_middleware()
        asyncio.run(
            _exercise_async_boundaries(observability, middleware, raw_names)
        )
        _exercise_sync_tool(middleware, raw_names["sync_tool"])
        _exercise_framework_result_transparency(middleware)
        _exercise_real_relay_json_domain(middleware)
        _exercise_relay_failure_transparency(middleware)
        _exercise_graph(observability, raw_names["graph"])

        nemo_relay.subscribers.flush()
        observability._lifecycle.subscriber.force_flush()
        requests, failures = collector.snapshot()
        canary_requests, canary_failures = canary.snapshot()
        if canary_requests or canary_failures:
            raise AssertionError("ambient OTLP canary received managed telemetry")
        total_bytes = _assert_wire_requests(
            requests, failures, observability, raw_names
        )
        print(
            "Validated real NeMo Relay observability: "
            f"relay={relay_version} langgraph={langgraph_version} "
            f"requests={len(requests)} bytes={total_bytes}"
        )
    finally:
        if initialized:
            observability.shutdown_observability()
        observability._OTLP_ENDPOINT = original_endpoint
        _restore_environment(previous_environment)
        collector.shutdown()
        collector.server_close()
        canary.shutdown()
        canary.server_close()
        collector_thread.join(timeout=5)
        canary_thread.join(timeout=5)
        if collector_thread.is_alive() or canary_thread.is_alive():
            raise RuntimeError("loopback OTLP collectors did not stop")


if __name__ == "__main__":
    main()
