# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Backend-neutral, bounded observability for managed Deep Agents Code."""

from __future__ import annotations

import atexit
import json
import logging
import math
import os
import re
import threading
from types import TracebackType
from typing import Any
from typing import NoReturn

_OBSERVABILITY_ENV = "NEMOCLAW_OBSERVABILITY"
_OTLP_ENDPOINT = "http://host.openshell.internal:4318/v1/traces"
_SERVICE_NAME = "nemoclaw-langchain-deepagents-code"
_SUBSCRIBER_NAME = "nemoclaw-dcode-openinference"
_GUARDRAIL_NAME = "nemoclaw-dcode-bounded-content"
_EXPORT_TIMEOUT_MILLIS = 1_000
_REDACTED_EXCEPTION_MESSAGE = (
    "NEMOCLAW_DCODE_OPERATION_FAILED: managed operation failed (details redacted)"
)
_SCOPE_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_.:/-]+")
_CAPTURE_KEY_ACRONYM_BOUNDARY = re.compile(r"(?<=[A-Z])(?=[A-Z][a-z])")
_CAPTURE_KEY_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_CAPTURE_KEY_DELIMITER = re.compile(r"[^A-Za-z0-9]+")
_UNICODE_SURROGATE = re.compile(r"[\ud800-\udfff]")
_MAX_SCOPE_NAME_CHARS = 128
_MAX_CAPTURE_DEPTH = 8
_MAX_CAPTURE_ITEMS = 50
_MAX_CAPTURE_NODES = 2_048
_MAX_CAPTURE_STRING_CHARS = 8_000
_MAX_CAPTURE_AGGREGATE_STRING_CHARS = 50_000
_MAX_CAPTURE_JSON_CHARS = 50_000
_MAX_CAPTURE_PREVIEW_CHARS = 16_000
_MIN_RELAY_JSON_INTEGER = -(1 << 63)
_MAX_RELAY_JSON_INTEGER = (1 << 64) - 1
_AMBIENT_OTEL_PREFIX = "OTEL_"
_REDACTED_VALUE = "<redacted>"
_OUT_OF_RANGE_INTEGER = "<integer outside Relay JSON range>"
_UNSAFE_RELAY_SERIALIZATION_TAGS = {
    "__nv_fallback_str__",
    "__nv_pickle__",
}
_RESULT_UNSET = object()
_SENSITIVE_CAPTURE_KEYS = {
    "api_key",
    "auth",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "headers",
    "password",
    "proxy_authorization",
    "secret",
    "set_cookie",
    "token",
}
_STATE_CAPTURE_KEYS = {
    "__interrupt__",
    "channel_values",
    "checkpoint",
    "checkpoint_id",
    "checkpoint_ns",
    "interrupt",
    "interrupts",
    "pending_sends",
    "resume",
}

logger = logging.getLogger(__name__)

_lifecycle_lock = threading.RLock()


class _LifecycleState:
    """Mutable exporter state guarded by ``_lifecycle_lock``."""

    def __init__(self) -> None:
        self.initialization_attempted = False
        self.active = False
        self.subscriber: Any = None


_lifecycle = _LifecycleState()


class _CaptureBudget:
    """Bound aggregate traversal and repeated container expansion."""

    def __init__(self) -> None:
        self.remaining_nodes = _MAX_CAPTURE_NODES
        self.remaining_string_chars = _MAX_CAPTURE_AGGREGATE_STRING_CHARS
        self.seen_containers: set[int] = set()

    def claim_node(self) -> bool:
        if self.remaining_nodes <= 0:
            return False
        self.remaining_nodes -= 1
        return True

    def claim_container(self, value: Any) -> bool:
        identity = id(value)
        if identity in self.seen_containers:
            return False
        self.seen_containers.add(identity)
        return True


def observability_requested(env: dict[str, str] | None = None) -> bool:
    """Return whether the host requested the fixed managed observability path."""
    source = os.environ if env is None else env
    return source.get(_OBSERVABILITY_ENV) == "1"


def _safe_identifier(value: Any, fallback: str) -> str:
    """Sanitize and cap identifiers at 128 characters before Relay receives them."""
    if type(value) is not str:
        return fallback
    bounded = value[:_MAX_SCOPE_NAME_CHARS]
    scrubbed = _scrub_secret_values(
        bounded, source_was_truncated=len(value) > _MAX_SCOPE_NAME_CHARS
    )
    normalized = _SCOPE_NAME_UNSAFE.sub("_", scrubbed).strip("_")
    return normalized[:_MAX_SCOPE_NAME_CHARS] or fallback


_REDACTED_SECRET_VALUE = "<redacted-secret>"
# Python's \s also includes control separators that ECMAScript excludes, so
# spell out the canonical whitespace set for cross-runtime parity.
_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR = (
    r"[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029"
    r"\u202f\u205f\u3000\ufeff'\"]"
)
# SECURITY -- Invalid state: Relay legitimately carries raw model and tool
# content, but NemoClaw's managed exporter must not emit recognized credential
# shapes from that content. This isolated Python package cannot import the
# canonical TypeScript groups in src/lib/security/secret-patterns.ts, so these
# expressions mirror them at NemoClaw's final span-projection boundary. Host
# collector processors remain defense in depth, not the source fix. The parity
# regression in test/langchain-deepagents-code-secret-pattern-parity.test.ts and
# the real Relay wire assertions in validate-observability.py guard this mirror.
# Remove it only when a shared Python artifact or upstream pre-export hook can
# enforce the same managed redaction contract before OTLP serialization.
_STANDALONE_SECRET_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r"nvapi-[A-Za-z0-9_-]{10,}",
        r"nvcf-[A-Za-z0-9_-]{10,}",
        r"ghp_[A-Za-z0-9_-]{10,}",
        r"github_pat_[A-Za-z0-9_]{30,}",
        r"sk-proj-[A-Za-z0-9_-]{10,}",
        r"sk-ant-[A-Za-z0-9_-]{10,}",
        r"sk-[A-Za-z0-9_-]{20,}",
        r"(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}",
        r"A(?:K|S)IA[A-Z0-9]{16}",
        r"hf_[A-Za-z0-9]{10,}",
        r"glpat-[A-Za-z0-9_-]{10,}",
        r"gsk_[A-Za-z0-9]{10,}",
        r"pypi-[A-Za-z0-9_-]{10,}",
        r"\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b",
        r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b",
        r"\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b",
        r"tvly-[A-Za-z0-9_-]{10,}",
        r"lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*",
        r"(?s)-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----",
    )
)
_ANCHORED_SECRET_PATTERNS = (
    re.compile(
        r"(Bearer[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029"
        r"\u202f\u205f\u3000\ufeff]+)[A-Za-z0-9_.+/=-]{10,}",
        re.IGNORECASE,
    ),
    re.compile(
        r"((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_"
        r"(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|"
        r"(?:X[-_])?API[-_]KEY|"
        r"TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)"
        r"['\"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})['\"]?)"
        rf"{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}{{10,}}",
        re.IGNORECASE,
    ),
    re.compile(
        r"((?:^|[^A-Za-z0-9])"
        r"(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|"
        r"[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|"
        r"[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|"
        r"[Aa]pp|[Rr]esolved)Key|"
        r"[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))"
        r"['\"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})['\"]?)"
        rf"{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}{{10,}}",
    ),
    re.compile(
        r"((?:^|[^A-Za-z0-9])KEY['\"]?"
        r"(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})['\"]?)"
        rf"{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}{{10,}}",
    ),
)
_ANCHORED_SECRET_REPLACEMENT = rf"\g<1>{_REDACTED_SECRET_VALUE}"
_UNTERMINATED_PRIVATE_KEY_PATTERN = re.compile(
    r"(?s)-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----.*\Z"
)
_TRUNCATED_SECRET_PATTERNS = tuple(
    re.compile(pattern, flags)
    for pattern, flags in (
        (
            r"(?:nvapi-|nvcf-|ghp_|github_pat_|sk-proj-|sk-ant-|sk-|"
            r"(?:xox[bpas]|xapp)-|hf_|glpat-|gsk_|pypi-|tvly-|"
            r"lsv2_(?:pt|sk)_)[A-Za-z0-9_-]*\Z",
            0,
        ),
        (r"A(?:K|S)IA[A-Z0-9]*\Z", 0),
        (r"(?:bot)?\d{1,10}:[A-Za-z0-9_-]*\Z", 0),
        (
            r"[A-Za-z0-9]{1,24}\.[A-Za-z0-9_-]{0,6}"
            r"(?:\.[A-Za-z0-9_-]*)?\Z",
            0,
        ),
        (
            r"(?:Bearer[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029"
            r"\u202f\u205f\u3000\ufeff]+)"
            r"[A-Za-z0-9_.+/=-]*\Z",
            re.IGNORECASE,
        ),
        (
            r"(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_"
            r"(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|"
            r"(?:X[-_])?API[-_]KEY|"
            r"TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)"
            r"['\"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})['\"]?"
            rf"{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}*\Z",
            re.IGNORECASE,
        ),
        (
            r"(?:^|[^A-Za-z0-9])"
            r"(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|"
            r"[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|"
            r"[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|"
            r"[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|"
            r"[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))"
            r"['\"]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})['\"]?"
            rf"{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}*\Z",
            0,
        ),
        (
            r"(?:^|[^A-Za-z0-9])KEY['\"]?"
            r"(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})['\"]?"
            rf"{_ECMASCRIPT_NON_WHITESPACE_SECRET_CHAR}*\Z",
            0,
        ),
    )
)


def _scrub_secret_values(
    value: str, *, source_was_truncated: bool = False
) -> str:
    """Best-effort redaction of recognized credential-shaped tokens in text."""
    scrubbed = value
    for pattern in _STANDALONE_SECRET_PATTERNS:
        scrubbed = pattern.sub(_REDACTED_SECRET_VALUE, scrubbed)
    for pattern in _ANCHORED_SECRET_PATTERNS:
        scrubbed = pattern.sub(_ANCHORED_SECRET_REPLACEMENT, scrubbed)
    # Bounding can cut a private-key block before its END marker. Once a BEGIN
    # marker is present, redact the remaining bounded segment rather than emit a
    # partial key body.
    scrubbed = _UNTERMINATED_PRIVATE_KEY_PATTERN.sub(
        _REDACTED_SECRET_VALUE, scrubbed
    )
    if source_was_truncated:
        for pattern in _TRUNCATED_SECRET_PATTERNS:
            scrubbed = pattern.sub(_REDACTED_SECRET_VALUE, scrubbed)
    return scrubbed


def _bounded_string(
    value: str,
    budget: _CaptureBudget | None = None,
    *,
    scrub_secrets: bool = False,
) -> str:
    limit = min(len(value), _MAX_CAPTURE_STRING_CHARS)
    if budget is not None:
        limit = min(limit, budget.remaining_string_chars)
        budget.remaining_string_chars -= limit
    bounded_source = value if limit == len(value) else value[:limit]
    if scrub_secrets:
        bounded_source = _scrub_secret_values(
            bounded_source, source_was_truncated=limit < len(value)
        )
    bounded = (
        bounded_source
        if limit == len(value)
        else f"{bounded_source}...[truncated {len(value) - limit} chars]"
    )
    # Relay's native JSON bridge requires valid UTF-8. Replace unpaired UTF-16
    # surrogates without rejecting the application value or mutating it in place.
    return _UNICODE_SURROGATE.sub("\ufffd", bounded)


def _redact_capture_key(key: Any) -> bool:
    if type(key) is not str:
        return True
    segmented = _CAPTURE_KEY_ACRONYM_BOUNDARY.sub("_", key.strip())
    normalized = _CAPTURE_KEY_DELIMITER.sub(
        "_", _CAPTURE_KEY_CAMEL_BOUNDARY.sub("_", segmented)
    ).strip("_").lower()
    segments = set(normalized.split("_"))
    return (
        normalized in _SENSITIVE_CAPTURE_KEYS
        or normalized in _STATE_CAPTURE_KEYS
        or bool(
            segments
            & {
                "auth",
                "authentication",
                "authorization",
                "bearer",
                "cookie",
                "credential",
                "credentials",
                "header",
                "password",
                "secret",
                "token",
            }
        )
        or ("key" in segments and bool(segments & {"access", "api", "private", "signing"}))
        or normalized.endswith("_api_key")
        or normalized.endswith("_access_key")
        or normalized.endswith("_headers")
        or normalized in {"pass", "passwd"}
        or normalized.endswith("_pass")
        or normalized.endswith("_passwd")
        or normalized.endswith("_password")
        or normalized.endswith("_private_key")
        or normalized.endswith("_secret")
        or normalized.endswith("_token")
        or normalized.startswith("checkpoint_")
    )


def _opaque_capture_marker(_value: Any) -> dict[str, str]:
    # Keep this marker constant. Even type-name lookup can invoke attacker-owned
    # metaclass behavior, and the concrete class name is not useful trace data.
    return {"_omitted_type": "opaque"}


def _unique_capture_key(candidate: str, captured: dict[str, Any]) -> str:
    """Keep redacted or bounded mapping keys distinct without exposing originals."""
    if candidate not in captured:
        return candidate
    for index in range(2, _MAX_CAPTURE_ITEMS + 2):
        suffix = f"#{index}"
        unique = f"{candidate[: _MAX_CAPTURE_STRING_CHARS - len(suffix)]}{suffix}"
        if unique not in captured:
            return unique
    return f"_duplicate_key_{len(captured)}"


def _capture_jsonable(
    value: Any,
    *,
    depth: int = 0,
    budget: _CaptureBudget | None = None,
) -> Any:
    """Bound arbitrary Relay values and redact credential/checkpoint-shaped keys."""
    if budget is None:
        budget = _CaptureBudget()
    if depth >= _MAX_CAPTURE_DEPTH:
        return {"_omitted_at_depth": _MAX_CAPTURE_DEPTH}
    if not budget.claim_node():
        return {"_truncated_by_budget": True}
    if value is None or type(value) is bool:
        return value
    if type(value) is int:
        if _MIN_RELAY_JSON_INTEGER <= value <= _MAX_RELAY_JSON_INTEGER:
            return value
        return _OUT_OF_RANGE_INTEGER
    if type(value) is float:
        return value if math.isfinite(value) else "<non-finite float>"
    if type(value) is str:
        return _bounded_string(value, budget, scrub_secrets=True)
    if type(value) in (bytes, bytearray):
        return f"<{len(value)} bytes>"
    if type(value) is dict:
        # Relay's best-effort arbitrary-object codec can encode opaque values as
        # base64 pickle or attacker-controlled string output before guardrails
        # run. Never inspect or export either fallback representation.
        if any(tag in value for tag in _UNSAFE_RELAY_SERIALIZATION_TAGS):
            return _opaque_capture_marker(value)
        if not budget.claim_container(value):
            return {"_omitted_reference": "shared_or_cycle"}
        captured: dict[str, Any] = {}
        omitted_items = 0
        inspected_items = 0
        for key, item in value.items():
            if inspected_items >= _MAX_CAPTURE_ITEMS:
                break
            inspected_items += 1
            if type(key) is not str:
                omitted_items += 1
                continue
            bounded_key = _unique_capture_key(
                _bounded_string(key, budget, scrub_secrets=True), captured
            )
            captured[bounded_key] = (
                _REDACTED_VALUE
                if _redact_capture_key(key)
                else _capture_jsonable(item, depth=depth + 1, budget=budget)
            )
        truncated_items = len(value) - inspected_items
        if truncated_items > 0:
            captured["_truncated_items"] = truncated_items
        if omitted_items > 0:
            captured["_omitted_non_string_keys"] = omitted_items
        return captured
    if type(value) in (list, tuple):
        if not budget.claim_container(value):
            return {"_omitted_reference": "shared_or_cycle"}
        captured_items: list[Any] = []
        inspected_items = 0
        for item in value:
            if inspected_items >= _MAX_CAPTURE_ITEMS or budget.remaining_nodes <= 0:
                break
            inspected_items += 1
            captured_items.append(
                _capture_jsonable(item, depth=depth + 1, budget=budget)
            )
        if len(value) > inspected_items:
            captured_items.append({"_truncated_items": len(value) - inspected_items})
        return captured_items
    return _opaque_capture_marker(value)


def _finalize_capture(captured: Any, original: Any) -> Any:
    try:
        encoded = json.dumps(
            captured,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except Exception:  # noqa: BLE001 - preserve a bounded diagnostic shape
        return {"_truncated": True, **_opaque_capture_marker(original)}
    if len(encoded) <= _MAX_CAPTURE_JSON_CHARS:
        return captured
    return {
        "_truncated": True,
        **_opaque_capture_marker(original),
        "preview": encoded[:_MAX_CAPTURE_PREVIEW_CHARS],
    }


def _bounded_capture(value: Any, *, budget: _CaptureBudget | None = None) -> Any:
    active_budget = budget or _CaptureBudget()
    return _finalize_capture(
        _capture_jsonable(value, budget=active_budget),
        value,
    )


def _bounded_llm_request(request: Any) -> Any:
    """Capture the model payload without transport headers or ambient credentials."""
    import nemo_relay

    content = request.content if type(getattr(request, "content", None)) is dict else {}
    model = _safe_identifier(content.get("model"), "unknown")
    messages = _bounded_capture(content.get("messages", []))
    return nemo_relay.LLMRequest({}, {"messages": messages, "model": model})


def _bounded_llm_response(response: Any) -> dict[str, Any]:
    """Capture bounded LangChain output while preserving its observable shape."""
    captured = _bounded_capture(response)
    return captured if type(captured) is dict else {"content": captured}


def _bounded_tool_request(_tool_name: str, args: Any) -> Any:
    """Capture bounded tool arguments for the emitted event only."""
    return _bounded_capture(args)


def _bounded_tool_response(_tool_name: str, result: Any) -> Any:
    """Capture bounded tool results for the emitted event only."""
    return _bounded_capture(result)


def _safe_object_attribute(value: Any, name: str, default: Any = None) -> Any:
    """Read a framework-owned field without invoking an instance override."""
    try:
        return object.__getattribute__(value, name)
    except Exception:  # noqa: BLE001 - an unreadable field is omitted from telemetry
        return default


def _bounded_langchain_message(
    message: Any, budget: _CaptureBudget
) -> dict[str, Any]:
    """Project known LangChain messages without generic model serialization."""
    try:
        from langchain_core.messages import AIMessage
        from langchain_core.messages import ChatMessage
        from langchain_core.messages import FunctionMessage
        from langchain_core.messages import HumanMessage
        from langchain_core.messages import SystemMessage
        from langchain_core.messages import ToolMessage
    except Exception:  # noqa: BLE001 - observability remains fail-safe
        return _opaque_capture_marker(message)

    message_type = type(message)
    roles = {
        HumanMessage: "user",
        AIMessage: "assistant",
        SystemMessage: "system",
        ToolMessage: "tool",
        FunctionMessage: "function",
        ChatMessage: "chat",
    }
    role = roles.get(message_type)
    if role is None:
        return _opaque_capture_marker(message)

    captured: dict[str, Any] = {
        "content": _capture_jsonable(
            _safe_object_attribute(message, "content"), budget=budget
        ),
        "role": role,
    }
    name = _safe_object_attribute(message, "name")
    if type(name) is str:
        captured["name"] = _bounded_string(
            _safe_identifier(name, "unknown"), budget
        )
    if message_type is AIMessage:
        captured["tool_calls"] = _capture_jsonable(
            _safe_object_attribute(message, "tool_calls", []), budget=budget
        )
    if message_type is ToolMessage:
        captured["artifact"] = _capture_jsonable(
            _safe_object_attribute(message, "artifact"), budget=budget
        )
        captured["status"] = _bounded_string(
            _safe_identifier(_safe_object_attribute(message, "status"), "unknown"),
            budget,
        )
        captured["tool_call_id"] = _bounded_string(
            _safe_identifier(
                _safe_object_attribute(message, "tool_call_id"), "unknown"
            ),
            budget,
        )
    return captured


def _bounded_langchain_messages(
    messages: Any,
    *,
    budget: _CaptureBudget,
    prefix: tuple[Any, ...] = (),
) -> Any:
    raw_messages = messages if type(messages) in (list, tuple) else ()
    total_items = len(prefix) + len(raw_messages)
    captured = [
        _bounded_langchain_message(message, budget)
        for message in (*prefix, *raw_messages[:_MAX_CAPTURE_ITEMS])[
            :_MAX_CAPTURE_ITEMS
        ]
    ]
    if total_items > len(captured):
        captured.append({"_truncated_items": total_items - len(captured)})
    return _finalize_capture(captured, messages)


def _managed_model_name(request: Any) -> str:
    model = _safe_object_attribute(request, "model")
    for field in ("model", "model_name", "model_id", "deployment_name"):
        value = _safe_object_attribute(model, field)
        if type(value) is str and value:
            return _safe_identifier(value, "unknown")
    return "unknown"


def _bounded_model_call_request(request: Any) -> tuple[str, Any]:
    """Build a telemetry-only request without model settings, schemas, or tools."""
    import nemo_relay

    budget = _CaptureBudget()
    system_message = _safe_object_attribute(request, "system_message")
    request_messages = _safe_object_attribute(request, "messages", [])
    messages = _bounded_langchain_messages(
        request_messages,
        budget=budget,
        prefix=(() if system_message is None else (system_message,)),
    )
    model_name = _managed_model_name(request)
    return model_name, nemo_relay.LLMRequest(
        {},
        {"messages": messages, "model": model_name},
    )


def _bounded_model_call_response(response: Any) -> dict[str, Any]:
    """Project a ModelResponse without Relay's arbitrary-object codec."""
    try:
        from langchain.agents.middleware import ModelResponse
    except Exception:  # noqa: BLE001 - observability remains fail-safe
        ModelResponse = None  # type: ignore[assignment,misc]

    if ModelResponse is not None and type(response) is ModelResponse:
        budget = _CaptureBudget()
        raw_messages = _safe_object_attribute(response, "result", [])
        captured = {
            "messages": _bounded_langchain_messages(
                raw_messages,
                budget=budget,
            ),
            "structured_response": _capture_jsonable(
                _safe_object_attribute(response, "structured_response"),
                budget=budget,
            ),
        }
        finalized = _finalize_capture(captured, response)
        return finalized if type(finalized) is dict else {"content": finalized}

    captured = _bounded_capture(response)
    return captured if type(captured) is dict else {"content": captured}


def _bounded_tool_call_response(response: Any) -> Any:
    """Project a ToolMessage while leaving graph-control objects opaque."""
    try:
        from langchain_core.messages import ToolMessage
    except Exception:  # noqa: BLE001 - observability remains fail-safe
        ToolMessage = None  # type: ignore[assignment,misc]
    if ToolMessage is not None and type(response) is ToolMessage:
        budget = _CaptureBudget()
        return _finalize_capture(
            _bounded_langchain_message(response, budget), response
        )
    return _bounded_capture(response)


class _MetadataOnlyGraphCallbacks:
    """LangGraph callback methods that never serialize graph data or errors."""

    run_inline = True

    def __init__(self) -> None:
        super().__init__()
        self._nemoclaw_scope_handles: dict[Any, Any] = {}
        self._nemoclaw_scope_lock = threading.RLock()

    def on_chain_start(
        self,
        _serialized: dict[str, Any] | None,
        _inputs: dict[str, Any],
        *,
        run_id: Any,
        parent_run_id: Any | None = None,
        **kwargs: Any,
    ) -> None:
        """Open a scope identified only by its bounded graph node name."""
        import nemo_relay

        name = _safe_identifier(kwargs.get("name"), "LangGraph")
        with self._nemoclaw_scope_lock:
            parent = self._nemoclaw_scope_handles.get(parent_run_id)
        try:
            handle = nemo_relay.scope.push(
                name,
                nemo_relay.ScopeType.Agent,
                handle=parent,
            )
        except Exception:  # noqa: BLE001 - observability must not fail agent work
            logger.debug("NeMo Relay scope start failed")
            return
        with self._nemoclaw_scope_lock:
            self._nemoclaw_scope_handles[run_id] = handle

    def on_chain_end(
        self,
        _outputs: dict[str, Any],
        *,
        run_id: Any,
        **_kwargs: Any,
    ) -> None:
        """Close a successful scope without recording graph outputs."""
        self._nemoclaw_pop_scope(run_id, "OK")

    def on_chain_error(
        self,
        _error: BaseException,
        *,
        run_id: Any,
        **_kwargs: Any,
    ) -> None:
        """Close a failed scope without recording exception text."""
        self._nemoclaw_pop_scope(run_id, "ERROR")

    def _nemoclaw_pop_scope(self, run_id: Any, status: str) -> None:
        import nemo_relay

        with self._nemoclaw_scope_lock:
            handle = self._nemoclaw_scope_handles.pop(run_id, None)
        if handle is None:
            return
        try:
            nemo_relay.scope.pop(
                handle,
                metadata={
                    "integration": "langgraph",
                    "otel.status_code": status,
                },
            )
        except Exception:  # noqa: BLE001 - observability must not fail agent work
            logger.debug("NeMo Relay scope end failed")

    def on_interrupt(self, _event: Any) -> None:
        """Record an interrupt mark without its potentially sensitive payload."""
        self._nemoclaw_graph_mark("Graph Interrupt")

    def on_resume(self, _event: Any) -> None:
        """Record a resume mark without checkpoint or interrupt payloads."""
        self._nemoclaw_graph_mark("Graph Resume")

    @staticmethod
    def _nemoclaw_graph_mark(name: str) -> None:
        import nemo_relay

        try:
            nemo_relay.scope.event(
                name,
                metadata={"integration": "langgraph"},
            )
        except Exception:  # noqa: BLE001 - observability must not fail agent work
            logger.debug("NeMo Relay graph mark failed")


def new_metadata_only_callback_handler() -> Any:
    """Create an isolated metadata-only callback for one compiled graph."""
    from langgraph.callbacks import GraphCallbackHandler

    class MetadataOnlyGraphCallbackHandler(
        _MetadataOnlyGraphCallbacks, GraphCallbackHandler
    ):
        pass

    return MetadataOnlyGraphCallbackHandler()


def new_metadata_only_callback_manager() -> Any:
    """Create the locked base manager for pinned self-config-first graph merges."""
    from langchain_core.callbacks import CallbackManager

    class MetadataOnlyCallbackManager(CallbackManager):
        """Keep exactly one managed handler while preserving config context."""

        def __init__(
            self,
            handlers: list[Any],
            inheritable_handlers: list[Any] | None = None,
            parent_run_id: Any | None = None,
            *,
            tags: list[str] | None = None,
            inheritable_tags: list[str] | None = None,
            metadata: dict[str, Any] | None = None,
            inheritable_metadata: dict[str, Any] | None = None,
        ) -> None:
            candidates = [*handlers, *(inheritable_handlers or ())]
            managed_handlers: list[Any] = []
            for handler in candidates:
                if isinstance(handler, _MetadataOnlyGraphCallbacks) and not any(
                    existing is handler for existing in managed_handlers
                ):
                    managed_handlers.append(handler)
            if len(managed_handlers) != 1:
                raise RuntimeError(
                    "managed observability callback manager requires exactly one handler"
                )
            managed_handler = managed_handlers[0]
            super().__init__(
                handlers=[managed_handler],
                inheritable_handlers=[managed_handler],
                parent_run_id=parent_run_id,
                tags=list(tags or ()),
                inheritable_tags=list(inheritable_tags or ()),
                metadata=dict(metadata or {}),
                inheritable_metadata=dict(inheritable_metadata or {}),
            )

        def copy(self) -> MetadataOnlyCallbackManager:
            return self.__class__(
                handlers=self.handlers.copy(),
                inheritable_handlers=self.inheritable_handlers.copy(),
                parent_run_id=self.parent_run_id,
                tags=self.tags.copy(),
                inheritable_tags=self.inheritable_tags.copy(),
                metadata=self.metadata.copy(),
                inheritable_metadata=self.inheritable_metadata.copy(),
            )

        def merge(self, other: Any) -> MetadataOnlyCallbackManager:
            """Merge tags and metadata while discarding external handlers."""
            # LangGraph 1.2.6 calls this locked manager as the base manager.
            return self.__class__(
                handlers=self.handlers.copy(),
                inheritable_handlers=self.inheritable_handlers.copy(),
                parent_run_id=self.parent_run_id or other.parent_run_id,
                tags=list(dict.fromkeys([*self.tags, *other.tags])),
                inheritable_tags=list(
                    dict.fromkeys([*self.inheritable_tags, *other.inheritable_tags])
                ),
                metadata={**self.metadata, **other.metadata},
                inheritable_metadata={
                    **self.inheritable_metadata,
                    **other.inheritable_metadata,
                },
            )

        def add_handler(self, _handler: Any, inherit: bool = True) -> None:
            """Reject handler additions performed while runnable configs merge."""

        def remove_handler(self, _handler: Any) -> None:
            """Keep the managed handler installed for the graph lifetime."""

        def set_handler(self, _handler: Any, inherit: bool = True) -> None:
            """Reject attempts to replace the managed handler."""

        def set_handlers(self, _handlers: list[Any], inherit: bool = True) -> None:
            """Reject attempts to replace the managed handler set."""

    return MetadataOnlyCallbackManager(handlers=[new_metadata_only_callback_handler()])


class _CaptureCallbackException:
    def __init__(self, boundary: _RelayExceptionBoundary) -> None:
        self._boundary = boundary

    def __enter__(self) -> None:
        return None

    def __exit__(
        self,
        _error_type: type[BaseException] | None,
        error: BaseException | None,
        _traceback: TracebackType | None,
    ) -> bool:
        if error is None:
            return False
        self._boundary.capture(error)
        return True


class _SuppressRelayException:
    def __init__(self, boundary: _RelayExceptionBoundary) -> None:
        self._boundary = boundary

    def __enter__(self) -> None:
        return None

    def __exit__(
        self,
        _error_type: type[BaseException] | None,
        error: BaseException | None,
        _traceback: TracebackType | None,
    ) -> bool:
        return isinstance(error, Exception) and self._boundary.has_original


class _RelayExceptionBoundary:
    """Hide callback exceptions from Relay, then restore them for the agent."""

    def __init__(self) -> None:
        self._original: tuple[BaseException, TracebackType | None] | None = None

    @property
    def has_original(self) -> bool:
        return self._original is not None

    def capture(self, error: BaseException) -> None:
        if self._original is None:
            # Bypass attacker-controlled exception-subclass dispatch. A custom
            # ``__getattribute__`` must not replace the application exception
            # with a secret-bearing failure that Relay can observe.
            traceback = BaseException.__traceback__.__get__(error, BaseException)
            self._original = (error, traceback)

    def capture_callback_exception(self) -> _CaptureCallbackException:
        return _CaptureCallbackException(self)

    def suppress_relay_exception(self) -> _SuppressRelayException:
        return _SuppressRelayException(self)

    @staticmethod
    def raise_redacted() -> NoReturn:
        # This method is called only after leaving the handler's ``except``
        # block. The constant exception therefore has no ``__context__`` link
        # back to the original exception for Relay to inspect or serialize.
        raise RuntimeError(_REDACTED_EXCEPTION_MESSAGE)

    def restore_original(self) -> NoReturn:
        if self._original is None:
            raise RuntimeError("NemoClaw Relay exception boundary is empty")
        error, traceback = self._original
        self._original = None
        # Call the base implementation directly so an exception subclass cannot
        # intercept restoration. A plain raise preserves an explicit __cause__.
        BaseException.with_traceback(error, traceback)
        raise error


def new_relay_middleware() -> Any:
    """Create Relay middleware that never exposes agent exception text."""
    import nemo_relay
    from nemo_relay.integrations.langchain import NemoRelayMiddleware
    from nemo_relay.utils import run_sync

    class BoundedNemoRelayMiddleware(NemoRelayMiddleware):
        def wrap_model_call(self, request: Any, handler: Any) -> Any:
            prepared_request: tuple[str, Any] | None = None
            try:
                prepared_request = _bounded_model_call_request(request)
            except Exception:  # noqa: BLE001 - optional instrumentation is fail-open
                pass
            if prepared_request is None:
                return handler(request)
            model_name, relay_request = prepared_request

            original_result: Any = _RESULT_UNSET
            callback_started = False
            callback_completed = False

            async def bounded_call(_relay_request: Any) -> Any:
                nonlocal callback_completed, callback_started, original_result
                if callback_started:
                    if callback_completed:
                        return _bounded_model_call_response(original_result)
                    return {"content": _opaque_capture_marker(None)}
                callback_started = True
                original_result = handler(request)
                callback_completed = True
                return _bounded_model_call_response(original_result)

            invoke_fallback = False
            try:
                run_sync(
                    self._llm_execute(
                        model_name=model_name,
                        request=relay_request,
                        codec=None,
                        response_codec=None,
                        func=bounded_call,
                    )
                )
            except Exception:  # noqa: BLE001 - optional instrumentation is fail-open
                if callback_completed:
                    return original_result
                if callback_started:
                    raise
                invoke_fallback = True
            if invoke_fallback:
                return handler(request)
            if not callback_completed:
                return handler(request)
            return original_result

        async def awrap_model_call(self, request: Any, handler: Any) -> Any:
            prepared_request: tuple[str, Any] | None = None
            try:
                prepared_request = _bounded_model_call_request(request)
            except Exception:  # noqa: BLE001 - optional instrumentation is fail-open
                pass
            if prepared_request is None:
                return await handler(request)
            model_name, relay_request = prepared_request

            original_result: Any = _RESULT_UNSET
            callback_started = False
            callback_completed = False

            async def bounded_call(_relay_request: Any) -> Any:
                nonlocal callback_completed, callback_started, original_result
                if callback_started:
                    if callback_completed:
                        return _bounded_model_call_response(original_result)
                    return {"content": _opaque_capture_marker(None)}
                callback_started = True
                original_result = await handler(request)
                callback_completed = True
                return _bounded_model_call_response(original_result)

            invoke_fallback = False
            try:
                await self._llm_execute(
                    model_name=model_name,
                    request=relay_request,
                    codec=None,
                    response_codec=None,
                    func=bounded_call,
                )
            except Exception:  # noqa: BLE001 - optional instrumentation is fail-open
                if callback_completed:
                    return original_result
                if callback_started:
                    raise
                invoke_fallback = True
            if invoke_fallback:
                return await handler(request)
            if not callback_completed:
                return await handler(request)
            return original_result

        async def _llm_execute(
            self,
            model_name: str,
            request: Any,
            codec: Any,
            response_codec: Any,
            func: Any,
        ) -> Any:
            boundary = _RelayExceptionBoundary()

            async def redacted_call(*args: Any, **kwargs: Any) -> Any:
                callback_result: Any = None
                with boundary.capture_callback_exception():
                    callback_result = await func(*args, **kwargs)
                if boundary.has_original:
                    boundary.raise_redacted()
                return callback_result

            result: Any = None
            with boundary.suppress_relay_exception():
                result = await super()._llm_execute(
                    model_name=_safe_identifier(model_name, "unknown"),
                    request=request,
                    codec=codec,
                    response_codec=response_codec,
                    func=redacted_call,
                )
            if boundary.has_original:
                boundary.restore_original()
            return result

        def wrap_tool_call(self, request: Any, handler: Any) -> Any:
            prepared_call: tuple[Any, Any, Any, Any] | None = None
            try:
                prepared_call = self._prepare_tool_call(request)
            except Exception:  # noqa: BLE001 - optional instrumentation is fail-open
                pass
            if prepared_call is None:
                return handler(request)
            parent, _codec, tool_name, tool_args = prepared_call

            boundary = _RelayExceptionBoundary()
            original_result: Any = _RESULT_UNSET
            callback_started = False
            callback_completed = False

            def redacted_call(_args: Any) -> Any:
                nonlocal callback_completed, callback_started, original_result
                if callback_started:
                    if callback_completed:
                        return _bounded_tool_call_response(original_result)
                    return _opaque_capture_marker(None)

                callback_result: Any = None
                with boundary.capture_callback_exception():
                    callback_request = request.override(
                        tool_call={**request.tool_call, "args": tool_args}
                    )
                    callback_started = True
                    callback_result = handler(callback_request)
                if boundary.has_original:
                    boundary.raise_redacted()
                original_result = callback_result
                callback_completed = True
                return _bounded_tool_call_response(callback_result)

            async def execute_tool() -> Any:
                return await nemo_relay.tools.execute(
                    name=_safe_identifier(tool_name, "unknown"),
                    args=_bounded_capture(tool_args),
                    func=redacted_call,
                    handle=parent,
                )

            invoke_fallback = False
            try:
                with boundary.suppress_relay_exception():
                    run_sync(execute_tool())
                if boundary.has_original:
                    boundary.restore_original()
            except Exception:  # noqa: BLE001 - optional instrumentation is fail-open
                if callback_completed:
                    return original_result
                if callback_started:
                    raise
                invoke_fallback = True
            if invoke_fallback:
                return handler(request)
            if not callback_completed:
                return handler(request)
            return original_result

        async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
            prepared_call: tuple[Any, Any, Any, Any] | None = None
            try:
                prepared_call = self._prepare_tool_call(request)
            except Exception:  # noqa: BLE001 - optional instrumentation is fail-open
                pass
            if prepared_call is None:
                return await handler(request)
            parent, _codec, tool_name, tool_args = prepared_call

            boundary = _RelayExceptionBoundary()
            original_result: Any = _RESULT_UNSET
            callback_started = False
            callback_completed = False

            async def redacted_call(_args: Any) -> Any:
                nonlocal callback_completed, callback_started, original_result
                if callback_started:
                    if callback_completed:
                        return _bounded_tool_call_response(original_result)
                    return _opaque_capture_marker(None)

                callback_result: Any = None
                with boundary.capture_callback_exception():
                    callback_request = request.override(
                        tool_call={**request.tool_call, "args": tool_args}
                    )
                    callback_started = True
                    callback_result = await handler(callback_request)
                if boundary.has_original:
                    boundary.raise_redacted()
                original_result = callback_result
                callback_completed = True
                return _bounded_tool_call_response(callback_result)

            invoke_fallback = False
            try:
                with boundary.suppress_relay_exception():
                    await nemo_relay.tools.execute(
                        name=_safe_identifier(tool_name, "unknown"),
                        args=_bounded_capture(tool_args),
                        func=redacted_call,
                        handle=parent,
                    )
                if boundary.has_original:
                    boundary.restore_original()
            except Exception:  # noqa: BLE001 - optional instrumentation is fail-open
                if callback_completed:
                    return original_result
                if callback_started:
                    raise
                invoke_fallback = True
            if invoke_fallback:
                return await handler(request)
            if not callback_completed:
                return await handler(request)
            return original_result

    return BoundedNemoRelayMiddleware(name="NemoClawObservabilityMiddleware")


def _deregister_guardrails() -> None:
    try:
        import nemo_relay

        nemo_relay.guardrails.deregister_llm_sanitize_request(_GUARDRAIL_NAME)
        nemo_relay.guardrails.deregister_llm_sanitize_response(_GUARDRAIL_NAME)
        nemo_relay.guardrails.deregister_tool_sanitize_request(_GUARDRAIL_NAME)
        nemo_relay.guardrails.deregister_tool_sanitize_response(_GUARDRAIL_NAME)
    except Exception:  # noqa: BLE001 - best-effort cleanup
        logger.debug("NeMo Relay guardrail cleanup failed")


def _new_managed_subscriber(nemo_relay: Any) -> Any:
    """Construct Relay without inheriting ambient OpenTelemetry configuration."""
    # Relay 0.4's native exporter reads OTEL_* independently of config.headers,
    # so an empty managed header map alone does not clear ambient credentials.
    ambient = {
        name: value
        for name, value in os.environ.items()
        if name.startswith(_AMBIENT_OTEL_PREFIX)
    }
    for name in ambient:
        os.environ.pop(name, None)
    try:
        config = nemo_relay.OpenInferenceConfig()
        config.transport = "http_binary"
        config.endpoint = _OTLP_ENDPOINT
        config.headers = {}
        config.service_name = _SERVICE_NAME
        config.timeout_millis = _EXPORT_TIMEOUT_MILLIS
        return nemo_relay.OpenInferenceSubscriber(config)
    finally:
        for name, value in ambient.items():
            if value is not None:
                os.environ[name] = value


def shutdown_observability() -> None:
    """Flush and tear down the local exporter without blocking agent shutdown."""
    with _lifecycle_lock:
        subscriber = _lifecycle.subscriber
        if subscriber is None:
            return
        _lifecycle.subscriber = None
        _lifecycle.active = False

    try:
        import nemo_relay

        nemo_relay.subscribers.flush()
    except Exception:  # noqa: BLE001 - shutdown remains fail-open
        logger.debug("NeMo Relay subscriber flush failed")
    try:
        subscriber.force_flush()
    except Exception:  # noqa: BLE001 - bounded exporter failure is non-fatal
        logger.debug("NeMo Relay OTLP force-flush failed")
    try:
        subscriber.deregister(_SUBSCRIBER_NAME)
    except Exception:  # noqa: BLE001 - best-effort cleanup
        logger.debug("NeMo Relay subscriber deregistration failed")
    try:
        subscriber.shutdown()
    except Exception:  # noqa: BLE001 - best-effort cleanup
        logger.debug("NeMo Relay subscriber shutdown failed")
    _deregister_guardrails()


def initialize_observability() -> bool:
    """Enable the fixed bounded-content Relay exporter when explicitly requested."""
    if not observability_requested():
        return False
    with _lifecycle_lock:
        if _lifecycle.initialization_attempted:
            return _lifecycle.active
        _lifecycle.initialization_attempted = True

        subscriber: Any = None
        try:
            import nemo_relay

            nemo_relay.guardrails.register_llm_sanitize_request(
                _GUARDRAIL_NAME, 0, _bounded_llm_request
            )
            nemo_relay.guardrails.register_llm_sanitize_response(
                _GUARDRAIL_NAME, 0, _bounded_llm_response
            )
            nemo_relay.guardrails.register_tool_sanitize_request(
                _GUARDRAIL_NAME, 0, _bounded_tool_request
            )
            nemo_relay.guardrails.register_tool_sanitize_response(
                _GUARDRAIL_NAME, 0, _bounded_tool_response
            )

            subscriber = _new_managed_subscriber(nemo_relay)
            subscriber.register(_SUBSCRIBER_NAME)
        except Exception:  # noqa: BLE001 - tracing setup must not stop the agent
            logger.warning(
                "Managed observability could not be initialized; continuing without tracing"
            )
            if subscriber is not None:
                try:
                    subscriber.shutdown()
                except Exception:  # noqa: BLE001 - best-effort rollback
                    logger.debug("NeMo Relay rollback failed")
            _deregister_guardrails()
            return False

        _lifecycle.subscriber = subscriber
        _lifecycle.active = True
        atexit.register(shutdown_observability)
        return True
