# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Isolated contract harness for managed Deep Agents Code observability."""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import io
import json
import logging
import os
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any

SECRET = "NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL"
DROPPED_MODEL_SETTINGS = "NEMOCLAW-DROPPED-MODEL-SETTINGS"
DROPPED_RESPONSE_FORMAT = "NEMOCLAW-DROPPED-RESPONSE-FORMAT"
DROPPED_TOOL_SCHEMA = "NEMOCLAW-DROPPED-TOOL-SCHEMA"
UNSAFE_RELAY_FALLBACK = "NEMOCLAW-UNSAFE-RELAY-FALLBACK"
LOG_HEADER_SECRET = "NEMOCLAW-OTEL-HEADER-CANARY"
LOG_CERTIFICATE_SECRET = "NEMOCLAW-OTEL-CERTIFICATE-CANARY"
LOG_CLIENT_KEY_SECRET = "NEMOCLAW-OTEL-CLIENT-KEY-CANARY"
_RELAY_OBSERVED_ERRORS: list[dict[str, Any]] = []
_RELAY_OBSERVED_MODEL_NAMES: list[str] = []
_RELAY_OBSERVED_TOOL_NAMES: list[str] = []
_RELAY_LLM_FAILURE_MODE: list[str | None] = [None]
_RELAY_TOOL_FAILURE_MODE: list[str | None] = [None]


def _validate_relay_json(value: Any) -> None:
    """Match the native JSON value domain in the pinned nemo-relay 0.4.0."""
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        if -(1 << 63) <= value <= (1 << 64) - 1:
            return
        raise ValueError("Relay JSON integer is out of range")
    if type(value) is float:
        return
    if type(value) is str:
        value.encode("utf-8", errors="strict")
        return
    if type(value) is list:
        for item in value:
            _validate_relay_json(item)
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("Relay JSON object key is not a string")
            key.encode("utf-8", errors="strict")
            _validate_relay_json(item)
        return
    raise ValueError("Relay JSON value has an unsupported type")


class _Guardrails:
    def __init__(self) -> None:
        self.registered: dict[str, Any] = {}
        self.deregistered: list[str] = []

    def _register(self, kind: str, name: str, priority: int, callback: Any) -> None:
        self.registered[kind] = {
            "name": name,
            "priority": priority,
            "callback": callback,
        }

    def register_llm_sanitize_request(
        self, name: str, priority: int, callback: Any
    ) -> None:
        self._register("llm_request", name, priority, callback)

    def register_llm_sanitize_response(
        self, name: str, priority: int, callback: Any
    ) -> None:
        self._register("llm_response", name, priority, callback)

    def register_tool_sanitize_request(
        self, name: str, priority: int, callback: Any
    ) -> None:
        self._register("tool_request", name, priority, callback)

    def register_tool_sanitize_response(
        self, name: str, priority: int, callback: Any
    ) -> None:
        self._register("tool_response", name, priority, callback)

    def _deregister(self, kind: str, name: str) -> bool:
        self.deregistered.append(f"{kind}:{name}")
        return True

    def deregister_llm_sanitize_request(self, name: str) -> bool:
        return self._deregister("llm_request", name)

    def deregister_llm_sanitize_response(self, name: str) -> bool:
        return self._deregister("llm_response", name)

    def deregister_tool_sanitize_request(self, name: str) -> bool:
        return self._deregister("tool_request", name)

    def deregister_tool_sanitize_response(self, name: str) -> bool:
        return self._deregister("tool_response", name)


class _SubscriberCollection:
    def __init__(self, *, fail_flush: bool) -> None:
        self.fail_flush = fail_flush
        self.flush_calls = 0

    def flush(self) -> None:
        self.flush_calls += 1
        if self.fail_flush:
            raise RuntimeError("collector flush unavailable")


class _OpenInferenceConfig:
    def __init__(self) -> None:
        self.transport = None
        self.endpoint = os.environ.get(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
        ) or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        self.headers = {
            "ambient": os.environ.get("OTEL_EXPORTER_OTLP_TRACES_HEADERS")
            or os.environ.get("OTEL_EXPORTER_OTLP_HEADERS", "")
        }
        self.service_name = None
        self.timeout_millis = None


class _OpenInferenceSubscriber:
    instances: list[_OpenInferenceSubscriber] = []
    fail_force_flush = False
    fail_construct = False
    fail_register = False

    def __init__(self, config: _OpenInferenceConfig) -> None:
        if self.fail_construct:
            raise RuntimeError("collector construction unavailable")
        self.config = config
        self.registered: list[str] = []
        self.force_flush_calls = 0
        self.deregistered: list[str] = []
        self.shutdown_calls = 0
        self.instances.append(self)

    def register(self, name: str) -> None:
        if self.fail_register:
            raise RuntimeError(
                "subscriber registration failed: "
                f"{os.environ.get('OTEL_EXPORTER_OTLP_HEADERS', '')}|"
                f"{os.environ.get('OTEL_EXPORTER_OTLP_CERTIFICATE', '')}|"
                f"{os.environ.get('OTEL_EXPORTER_OTLP_CLIENT_KEY', '')}"
            )
        self.registered.append(name)

    def force_flush(self) -> None:
        self.force_flush_calls += 1
        if self.fail_force_flush:
            raise RuntimeError("collector unavailable")

    def deregister(self, name: str) -> None:
        self.deregistered.append(name)

    def shutdown(self) -> None:
        self.shutdown_calls += 1


class _LLMRequest:
    def __init__(self, headers: dict[str, str], content: dict[str, Any]) -> None:
        self.headers = headers
        self.content = content


class _Scope:
    def __init__(self) -> None:
        self.records: list[dict[str, Any]] = []

    def push(self, name: str, category: str, **kwargs: Any) -> str:
        self.records.append(
            {"operation": "push", "name": name, "category": category, **kwargs}
        )
        return f"handle-{len(self.records)}"

    def pop(self, handle: str, **kwargs: Any) -> None:
        self.records.append({"operation": "pop", "handle": handle, **kwargs})

    def event(self, name: str, **kwargs: Any) -> None:
        self.records.append({"operation": "event", "name": name, **kwargs})


class _GraphCallbackHandler:
    def __init__(self) -> None:
        self.base_initialized = True


class _CallbackManager:
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
        self.handlers = list(handlers)
        self.inheritable_handlers = list(inheritable_handlers or ())
        self.parent_run_id = parent_run_id
        self.tags = list(tags or ())
        self.inheritable_tags = list(inheritable_tags or ())
        self.metadata = dict(metadata or {})
        self.inheritable_metadata = dict(inheritable_metadata or {})

    def copy(self) -> _CallbackManager:
        return self.__class__(
            handlers=self.handlers.copy(),
            inheritable_handlers=self.inheritable_handlers.copy(),
            parent_run_id=self.parent_run_id,
            tags=self.tags.copy(),
            inheritable_tags=self.inheritable_tags.copy(),
            metadata=self.metadata.copy(),
            inheritable_metadata=self.inheritable_metadata.copy(),
        )

    def add_handler(self, handler: Any, inherit: bool = True) -> None:
        if handler not in self.handlers:
            self.handlers.append(handler)
        if inherit and handler not in self.inheritable_handlers:
            self.inheritable_handlers.append(handler)


class _RelayWrappedError(RuntimeError):
    pass


def _relay_wrapped_error(error: Exception) -> _RelayWrappedError:
    _RELAY_OBSERVED_ERRORS.append(
        {
            "type": type(error).__name__,
            "message": str(error),
            "context_is_none": error.__context__ is None,
            "cause_is_none": error.__cause__ is None,
        }
    )
    return _RelayWrappedError("relay wrapped callback failure")


async def _tool_execute(*, name: str, args: Any, func: Any, **_kwargs: Any) -> Any:
    _RELAY_OBSERVED_TOOL_NAMES.append(name)
    _validate_relay_json(args)
    if _RELAY_TOOL_FAILURE_MODE[0] == "before":
        raise RuntimeError("injected Relay tool failure before callback")
    try:
        result = func(args)
        result = await result if inspect.isawaitable(result) else result
    except Exception as error:
        raise _relay_wrapped_error(error) from error
    _validate_relay_json(result)
    if _RELAY_TOOL_FAILURE_MODE[0] == "after":
        raise RuntimeError("injected Relay tool failure after callback")
    return result


def _run_sync(awaitable: Any) -> Any:
    return asyncio.run(awaitable)


class _NemoRelayMiddleware:
    def __init__(self, *, name: str) -> None:
        self.name = name

    async def _llm_execute(
        self,
        model_name: str,
        request: Any,
        codec: Any,
        response_codec: Any,
        func: Any,
        **_kwargs: Any,
    ) -> Any:
        _RELAY_OBSERVED_MODEL_NAMES.append(model_name)
        del codec, response_codec
        validate_payload = type(request) is _LLMRequest
        if validate_payload:
            _validate_relay_json(request.headers)
            _validate_relay_json(request.content)
        if _RELAY_LLM_FAILURE_MODE[0] == "before":
            raise RuntimeError("injected Relay model failure before callback")
        try:
            result = await func(request)
        except Exception as error:
            raise _relay_wrapped_error(error) from error
        if validate_payload:
            _validate_relay_json(result)
        if _RELAY_LLM_FAILURE_MODE[0] == "after":
            raise RuntimeError("injected Relay model failure after callback")
        return result

    def wrap_model_call(self, request: Any, handler: Any) -> Any:
        async def call(inner_request: Any) -> Any:
            return handler(inner_request)

        return _run_sync(self._llm_execute("model", request, None, None, call))

    async def awrap_model_call(self, request: Any, handler: Any) -> Any:
        async def call(inner_request: Any) -> Any:
            return await handler(inner_request)

        return await self._llm_execute("model", request, None, None, call)

    def _prepare_tool_call(self, request: Any) -> tuple[Any, Any, str, Any]:
        return None, object(), request.tool_call["name"], request.tool_call.get("args") or {}


class _AIMessage:
    def __init__(self, *, content: str) -> None:
        self.content = content


def _messages_to_dict(messages: list[_AIMessage]) -> list[dict[str, Any]]:
    return [
        {
            "type": "ai",
            "data": {
                "content": message.content,
                "additional_kwargs": {},
                "response_metadata": {},
                "tool_calls": [],
                "invalid_tool_calls": [],
            },
        }
        for message in messages
    ]


def _install_stubs(
    *,
    fail_flush: bool = False,
    fail_force_flush: bool = False,
    fail_construct: bool = False,
    fail_register: bool = False,
) -> tuple[types.ModuleType, _Guardrails, _SubscriberCollection, _Scope]:
    _RELAY_OBSERVED_ERRORS.clear()
    _RELAY_OBSERVED_MODEL_NAMES.clear()
    _RELAY_OBSERVED_TOOL_NAMES.clear()
    _RELAY_LLM_FAILURE_MODE[0] = None
    _RELAY_TOOL_FAILURE_MODE[0] = None
    guardrails = _Guardrails()
    subscribers = _SubscriberCollection(fail_flush=fail_flush)
    scope = _Scope()
    _OpenInferenceSubscriber.instances = []
    _OpenInferenceSubscriber.fail_force_flush = fail_force_flush
    _OpenInferenceSubscriber.fail_construct = fail_construct
    _OpenInferenceSubscriber.fail_register = fail_register

    relay = types.ModuleType("nemo_relay")
    relay.LLMRequest = _LLMRequest
    relay.OpenInferenceConfig = _OpenInferenceConfig
    relay.OpenInferenceSubscriber = _OpenInferenceSubscriber
    relay.ScopeType = SimpleNamespace(Agent="agent")
    relay.guardrails = guardrails
    relay.subscribers = subscribers
    relay.scope = scope
    relay.tools = SimpleNamespace(execute=_tool_execute)
    relay.typed = SimpleNamespace(tool_execute=_tool_execute)

    integrations = types.ModuleType("nemo_relay.integrations")
    langchain_integration = types.ModuleType("nemo_relay.integrations.langchain")
    langchain_integration.NemoRelayMiddleware = _NemoRelayMiddleware
    relay_utils = types.ModuleType("nemo_relay.utils")
    relay_utils.run_sync = _run_sync
    relay.integrations = integrations

    langgraph = types.ModuleType("langgraph")
    langgraph_callbacks = types.ModuleType("langgraph.callbacks")
    langgraph_callbacks.GraphCallbackHandler = _GraphCallbackHandler

    langchain_core = types.ModuleType("langchain_core")
    langchain_callbacks = types.ModuleType("langchain_core.callbacks")
    langchain_callbacks.CallbackManager = _CallbackManager
    langchain_messages = types.ModuleType("langchain_core.messages")
    langchain_messages.AIMessage = _AIMessage
    langchain_messages.messages_to_dict = _messages_to_dict

    sys.modules.update(
        {
            "nemo_relay": relay,
            "nemo_relay.integrations": integrations,
            "nemo_relay.integrations.langchain": langchain_integration,
            "nemo_relay.utils": relay_utils,
            "langgraph": langgraph,
            "langgraph.callbacks": langgraph_callbacks,
            "langchain_core": langchain_core,
            "langchain_core.callbacks": langchain_callbacks,
            "langchain_core.messages": langchain_messages,
        }
    )
    return relay, guardrails, subscribers, scope


def _load_module(path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("nemoclaw_observability_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _SensitiveOperationError(RuntimeError):
    pass


_HOSTILE_TYPE_NAME_READS = [0]
_HOSTILE_EXCEPTION_DISPATCHES = [0]


class _HostileCaptureMeta(type):
    def __getattribute__(cls, name: str) -> Any:
        if name == "__name__":
            _HOSTILE_TYPE_NAME_READS[0] += 1
            raise AttributeError("hostile type name is intentionally unavailable")
        return super().__getattribute__(name)


class _HostileCaptureObject(metaclass=_HostileCaptureMeta):
    def __repr__(self) -> str:
        raise AssertionError("observability evaluated an opaque repr")

    def __str__(self) -> str:
        raise AssertionError("observability evaluated an opaque string")


class _HostileIdentifier(str):
    def __str__(self) -> str:
        raise AssertionError("observability coerced a hostile identifier")


class _HostileDispatchError(_SensitiveOperationError):
    @property
    def __traceback__(self) -> Any:
        _HOSTILE_EXCEPTION_DISPATCHES[0] += 1
        raise _SensitiveOperationError(f"hostile-traceback:{SECRET}")

    def with_traceback(self, _traceback: Any) -> Any:
        _HOSTILE_EXCEPTION_DISPATCHES[0] += 1
        raise _SensitiveOperationError(f"hostile-restore:{SECRET}")


class _ToolCallRequest:
    def __init__(self, tool_call: dict[str, Any]) -> None:
        self.tool_call = tool_call

    def override(self, *, tool_call: dict[str, Any]) -> _ToolCallRequest:
        return _ToolCallRequest(tool_call)


class _FailingToolCallRequest:
    @property
    def tool_call(self) -> Any:
        raise RuntimeError("injected tool request-build failure")


def _preserved_exception(error: Exception, caught: Exception) -> dict[str, Any]:
    return {
        "same_instance": caught is error,
        "type": type(caught).__name__,
        "message": str(caught),
    }


def _exercise_hostile_exception(module: types.ModuleType, middleware: Any) -> dict[str, Any]:
    explicit_cause = ValueError(f"explicit-cause:{SECRET}")
    hostile_error = _HostileDispatchError(f"hostile-original:{SECRET}")
    hostile_error.__cause__ = explicit_cause

    def handler(_request: Any) -> Any:
        raise hostile_error

    try:
        middleware.wrap_model_call(object(), handler)
    except Exception as caught:
        return {
            **_preserved_exception(hostile_error, caught),
            "cause_preserved": BaseException.__getattribute__(
                caught, "__cause__"
            )
            is explicit_cause,
            "subclass_dispatches": _HOSTILE_EXCEPTION_DISPATCHES[0],
        }
    raise AssertionError("hostile application exception did not escape")


def _exercise_middleware_errors(module: types.ModuleType) -> dict[str, Any]:
    middleware = module.new_relay_middleware()
    preserved: dict[str, Any] = {}

    sync_model_error = _SensitiveOperationError(f"sync-model:{SECRET}")

    def sync_model_handler(_request: Any) -> Any:
        raise sync_model_error

    try:
        middleware.wrap_model_call(object(), sync_model_handler)
    except Exception as caught:
        preserved["sync_model"] = _preserved_exception(sync_model_error, caught)

    sync_tool_error = _SensitiveOperationError(f"sync-tool:{SECRET}")

    def sync_tool_handler(_request: Any) -> Any:
        raise sync_tool_error

    tool_request = _ToolCallRequest(
        {"name": "execute", "args": {"command": SECRET}}
    )
    try:
        middleware.wrap_tool_call(tool_request, sync_tool_handler)
    except Exception as caught:
        preserved["sync_tool"] = _preserved_exception(sync_tool_error, caught)

    async def exercise_async() -> None:
        async_model_error = _SensitiveOperationError(f"async-model:{SECRET}")

        async def async_model_handler(_request: Any) -> Any:
            raise async_model_error

        try:
            await middleware.awrap_model_call(object(), async_model_handler)
        except Exception as caught:
            preserved["async_model"] = _preserved_exception(
                async_model_error, caught
            )

        async_tool_error = _SensitiveOperationError(f"async-tool:{SECRET}")

        async def async_tool_handler(_request: Any) -> Any:
            raise async_tool_error

        try:
            await middleware.awrap_tool_call(tool_request, async_tool_handler)
        except Exception as caught:
            preserved["async_tool"] = _preserved_exception(async_tool_error, caught)

    asyncio.run(exercise_async())

    relay_errors_before_control_flow = len(_RELAY_OBSERVED_ERRORS)
    keyboard_interrupt = KeyboardInterrupt("operator interrupt")

    def interrupted_model_handler(_request: Any) -> Any:
        raise keyboard_interrupt

    try:
        middleware.wrap_model_call(object(), interrupted_model_handler)
    except KeyboardInterrupt as caught:
        control_flow = {
            "same_instance": caught is keyboard_interrupt,
            "relay_observed": len(_RELAY_OBSERVED_ERRORS)
            != relay_errors_before_control_flow,
        }
    else:
        raise AssertionError("KeyboardInterrupt did not escape the observability boundary")

    return {
        "preserved": preserved,
        "hostile": _exercise_hostile_exception(module, middleware),
        "control_flow": control_flow,
        "relay_observed": list(_RELAY_OBSERVED_ERRORS),
        "secret_present_in_relay_errors": SECRET
        in json.dumps(_RELAY_OBSERVED_ERRORS, sort_keys=True),
    }


def _exercise_relay_fail_open(module: types.ModuleType) -> dict[str, Any]:
    middleware = module.new_relay_middleware()
    cases: dict[str, Any] = {}

    def sync_model_case(mode: str) -> dict[str, Any]:
        calls = 0
        expected = object()

        def handler(_request: Any) -> Any:
            nonlocal calls
            calls += 1
            return expected

        _RELAY_LLM_FAILURE_MODE[0] = mode
        try:
            result = middleware.wrap_model_call(object(), handler)
        finally:
            _RELAY_LLM_FAILURE_MODE[0] = None
        return {"calls": calls, "same_result": result is expected}

    def sync_tool_case(mode: str) -> dict[str, Any]:
        calls = 0
        expected = object()
        request = _ToolCallRequest({"name": "execute", "args": {"mode": mode}})

        def handler(_request: Any) -> Any:
            nonlocal calls
            calls += 1
            return expected

        _RELAY_TOOL_FAILURE_MODE[0] = mode
        try:
            result = middleware.wrap_tool_call(request, handler)
        finally:
            _RELAY_TOOL_FAILURE_MODE[0] = None
        return {"calls": calls, "same_result": result is expected}

    cases["sync_model_before"] = sync_model_case("before")
    cases["sync_model_after"] = sync_model_case("after")
    cases["sync_tool_before"] = sync_tool_case("before")
    cases["sync_tool_after"] = sync_tool_case("after")

    async def exercise_async() -> None:
        async def model_case(mode: str) -> dict[str, Any]:
            calls = 0
            expected = object()

            async def handler(_request: Any) -> Any:
                nonlocal calls
                calls += 1
                return expected

            _RELAY_LLM_FAILURE_MODE[0] = mode
            try:
                result = await middleware.awrap_model_call(object(), handler)
            finally:
                _RELAY_LLM_FAILURE_MODE[0] = None
            return {"calls": calls, "same_result": result is expected}

        async def tool_case(mode: str) -> dict[str, Any]:
            calls = 0
            expected = object()
            request = _ToolCallRequest(
                {"name": "execute", "args": {"mode": mode}}
            )

            async def handler(_request: Any) -> Any:
                nonlocal calls
                calls += 1
                return expected

            _RELAY_TOOL_FAILURE_MODE[0] = mode
            try:
                result = await middleware.awrap_tool_call(request, handler)
            finally:
                _RELAY_TOOL_FAILURE_MODE[0] = None
            return {"calls": calls, "same_result": result is expected}

        cases["async_model_before"] = await model_case("before")
        cases["async_model_after"] = await model_case("after")
        cases["async_tool_before"] = await tool_case("before")
        cases["async_tool_after"] = await tool_case("after")

    asyncio.run(exercise_async())

    original_args = {
        "huge_negative": -(10**1000),
        "huge_positive": 10**1000,
        "lone_surrogate": "before\ud800after",
    }
    original_result = {
        "huge_result": 10**1000,
        "lone_surrogate_result": "before\udfffafter",
    }
    value_calls = 0
    value_request = _ToolCallRequest({"name": "execute", "args": original_args})

    def value_handler(request: _ToolCallRequest) -> Any:
        nonlocal value_calls
        value_calls += 1
        if request.tool_call["args"] is not original_args:
            raise AssertionError("observability mutated application tool arguments")
        return original_result

    value_result = middleware.wrap_tool_call(value_request, value_handler)
    normalized = module._bounded_capture({**original_args, **original_result})
    _validate_relay_json(normalized)

    return {
        "failure_cases": cases,
        "unsafe_python_values": {
            "calls": value_calls,
            "same_result": value_result is original_result,
            "normalized": normalized,
        },
    }


def _new_contextual_error(
    error_type: type[BaseException], label: str
) -> tuple[BaseException, BaseException, BaseException]:
    cause = ValueError(f"{label}-cause")
    context = LookupError(f"{label}-context")
    error = error_type(f"{label}-application-error")
    error.__cause__ = cause
    error.__context__ = context
    return error, cause, context


def _fallback_error_result(
    *,
    calls: int,
    caught: BaseException,
    expected: BaseException,
    cause: BaseException,
    context: BaseException,
) -> dict[str, Any]:
    return {
        "calls": calls,
        "same_instance": caught is expected,
        "cause_preserved": BaseException.__cause__.__get__(caught, BaseException)
        is cause,
        "context_preserved": BaseException.__context__.__get__(
            caught, BaseException
        )
        is context,
        "type": type(caught).__name__,
    }


def _exercise_fallback_exception_transparency(
    module: types.ModuleType,
) -> dict[str, Any]:
    middleware = module.new_relay_middleware()
    results: dict[str, Any] = {}

    def sync_case(
        name: str,
        error_type: type[BaseException],
        invoke: Any,
    ) -> None:
        calls = 0
        error, cause, context = _new_contextual_error(error_type, name)

        def handler(_request: Any) -> Any:
            nonlocal calls
            calls += 1
            raise error

        try:
            invoke(handler)
        except BaseException as caught:
            results[name] = _fallback_error_result(
                calls=calls,
                caught=caught,
                expected=error,
                cause=cause,
                context=context,
            )
        else:
            raise AssertionError(f"{name} application error did not escape")

    original_model_builder = module._bounded_model_call_request

    def failing_model_builder(_request: Any) -> Any:
        raise RuntimeError("injected model request-build failure")

    module._bounded_model_call_request = failing_model_builder
    try:
        sync_case(
            "sync_model_build",
            RuntimeError,
            lambda handler: middleware.wrap_model_call(object(), handler),
        )
    finally:
        module._bounded_model_call_request = original_model_builder

    _RELAY_LLM_FAILURE_MODE[0] = "before"
    try:
        sync_case(
            "sync_model_relay",
            KeyboardInterrupt,
            lambda handler: middleware.wrap_model_call(object(), handler),
        )
    finally:
        _RELAY_LLM_FAILURE_MODE[0] = None

    sync_case(
        "sync_tool_build",
        SystemExit,
        lambda handler: middleware.wrap_tool_call(_FailingToolCallRequest(), handler),
    )

    _RELAY_TOOL_FAILURE_MODE[0] = "before"
    try:
        sync_case(
            "sync_tool_relay",
            RuntimeError,
            lambda handler: middleware.wrap_tool_call(
                _ToolCallRequest({"name": "execute", "args": {}}), handler
            ),
        )
    finally:
        _RELAY_TOOL_FAILURE_MODE[0] = None

    async def exercise_async() -> None:
        async def async_case(
            name: str,
            error_type: type[BaseException],
            invoke: Any,
        ) -> None:
            calls = 0
            error, cause, context = _new_contextual_error(error_type, name)

            async def handler(_request: Any) -> Any:
                nonlocal calls
                calls += 1
                raise error

            try:
                await invoke(handler)
            except BaseException as caught:
                results[name] = _fallback_error_result(
                    calls=calls,
                    caught=caught,
                    expected=error,
                    cause=cause,
                    context=context,
                )
            else:
                raise AssertionError(f"{name} application error did not escape")

        module._bounded_model_call_request = failing_model_builder
        try:
            await async_case(
                "async_model_build",
                asyncio.CancelledError,
                lambda handler: middleware.awrap_model_call(object(), handler),
            )
        finally:
            module._bounded_model_call_request = original_model_builder

        _RELAY_LLM_FAILURE_MODE[0] = "before"
        try:
            await async_case(
                "async_model_relay",
                RuntimeError,
                lambda handler: middleware.awrap_model_call(object(), handler),
            )
        finally:
            _RELAY_LLM_FAILURE_MODE[0] = None

        await async_case(
            "async_tool_build",
            RuntimeError,
            lambda handler: middleware.awrap_tool_call(
                _FailingToolCallRequest(), handler
            ),
        )

        _RELAY_TOOL_FAILURE_MODE[0] = "before"
        try:
            await async_case(
                "async_tool_relay",
                asyncio.CancelledError,
                lambda handler: middleware.awrap_tool_call(
                    _ToolCallRequest({"name": "execute", "args": {}}), handler
                ),
            )
        finally:
            _RELAY_TOOL_FAILURE_MODE[0] = None

    asyncio.run(exercise_async())
    return results


def _exercise_control_flow_suppression(module: types.ModuleType) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for name, control_flow in (
        ("KeyboardInterrupt", KeyboardInterrupt("operator interrupt")),
        ("SystemExit", SystemExit("process exit")),
        ("CancelledError", asyncio.CancelledError("task cancellation")),
    ):
        boundary = module._RelayExceptionBoundary()
        boundary.capture(RuntimeError("captured application error"))
        try:
            with boundary.suppress_relay_exception():
                raise control_flow
        except BaseException as caught:
            results[name] = caught is control_flow
    return results


def _exercise_identifier_boundaries(
    module: types.ModuleType, scope: _Scope
) -> dict[str, Any]:
    controls = "\r\n\t\x00\u202e"
    overlong = "x" * 200
    truncation_sentinel = "-MUST-NOT-REACH-RELAY"
    middleware = module.new_relay_middleware()

    async def model_call(request: Any) -> Any:
        return request

    asyncio.run(
        middleware._llm_execute(
            f"model{controls}{overlong}{truncation_sentinel}",
            object(),
            None,
            None,
            model_call,
        )
    )

    sync_tool_request = _ToolCallRequest(
        {
            "name": f"tool{controls}{overlong}{truncation_sentinel}",
            "args": {},
        }
    )
    middleware.wrap_tool_call(sync_tool_request, lambda _request: None)

    async_tool_request = _ToolCallRequest(
        {
            "name": f"async-tool{controls}{overlong}{truncation_sentinel}",
            "args": {},
        }
    )

    async def async_tool_handler(_request: Any) -> None:
        return None

    asyncio.run(middleware.awrap_tool_call(async_tool_request, async_tool_handler))

    callback = module.new_metadata_only_callback_handler()
    scope_record_offset = len(scope.records)
    callback.on_chain_start(
        None,
        {},
        run_id="hostile-name-run",
        name=f"graph{controls}{overlong}{truncation_sentinel}",
    )
    callback.on_chain_end({}, run_id="hostile-name-run")
    graph_records = scope.records[scope_record_offset:]
    graph_name = next(
        record["name"]
        for record in graph_records
        if record["operation"] == "push"
    )

    return {
        "model": _RELAY_OBSERVED_MODEL_NAMES[-1],
        "sync_tool": _RELAY_OBSERVED_TOOL_NAMES[-2],
        "async_tool": _RELAY_OBSERVED_TOOL_NAMES[-1],
        "graph": graph_name,
    }


def _exercise_callback_manager_boundary(module: types.ModuleType) -> dict[str, Any]:
    class _HostileCallback:
        pass

    hostile = _HostileCallback()
    manager = module.new_metadata_only_callback_manager()
    managed_handler = manager.handlers[0]
    manager.add_handler(hostile)
    copied = manager.copy()
    manager.set_handler(hostile)
    manager.set_handlers([hostile])
    manager.remove_handler(managed_handler)

    hostile_manager = _CallbackManager(
        handlers=[hostile],
        inheritable_handlers=[hostile],
        tags=["invocation-tag"],
        inheritable_tags=["invocation-inheritable-tag"],
        metadata={"invocation": "preserved"},
        inheritable_metadata={"inheritable": "preserved"},
    )
    merged = manager.merge(hostile_manager)
    merged.add_handler(hostile)

    return {
        "bound_handlers": len(manager.handlers),
        "bound_metadata_only": manager.handlers == [managed_handler],
        "copy_handlers": len(copied.handlers),
        "copy_metadata_only": copied.handlers == [managed_handler],
        "merged_handlers": len(merged.handlers),
        "merged_metadata_only": merged.handlers == [managed_handler],
        "merged_tags": merged.tags,
        "merged_inheritable_tags": merged.inheritable_tags,
        "merged_metadata": merged.metadata,
        "merged_inheritable_metadata": merged.inheritable_metadata,
    }


def _privacy_scenario(path: Path) -> dict[str, Any]:
    ambient_otel = {
        "OTEL_EXPORTER_OTLP_ENDPOINT": f"https://attacker.invalid/{SECRET}",
        "OTEL_EXPORTER_OTLP_HEADERS": f"authorization={SECRET}",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": (
            f"https://traces.attacker.invalid/{SECRET}"
        ),
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS": f"x-api-key={SECRET}",
        "OTEL_RESOURCE_ATTRIBUTES": f"service.name={SECRET}",
        "OTEL_EXPORTER_OTLP_CERTIFICATE": f"/nonexistent/{SECRET}/ca.pem",
    }
    os.environ.update(ambient_otel)
    _, guardrails, subscribers, scope = _install_stubs()
    module = _load_module(path)

    exact_opt_in = {
        value: module.observability_requested({"NEMOCLAW_OBSERVABILITY": value})
        for value in ("1", "true", "TRUE", " 1", "0")
    }
    os.environ["NEMOCLAW_OBSERVABILITY"] = "1"
    initialized = module.initialize_observability()
    initialized_again = module.initialize_observability()
    ambient_environment_restored = all(
        os.environ.get(name) == value for name, value in ambient_otel.items()
    )
    subscriber = _OpenInferenceSubscriber.instances[0]

    request_guardrail = guardrails.registered["llm_request"]["callback"]
    response_guardrail = guardrails.registered["llm_response"]["callback"]
    tool_request_guardrail = guardrails.registered["tool_request"]["callback"]
    tool_response_guardrail = guardrails.registered["tool_response"]["callback"]

    request = request_guardrail(
        _LLMRequest(
            {"authorization": SECRET},
            {
                "model": "managed-model",
                "messages": [{"content": SECRET}],
                "tools": [{"description": DROPPED_TOOL_SCHEMA}],
                "model_settings": {"api_key": DROPPED_MODEL_SETTINGS},
                "response_format": {"schema": DROPPED_RESPONSE_FORMAT},
            },
        )
    )
    response = response_guardrail({"content": SECRET, "error": SECRET})
    tool_request = tool_request_guardrail("execute", {"command": SECRET})
    tool_response = tool_response_guardrail("execute", {"stdout": SECRET})
    bounded_redaction = tool_request_guardrail(
        "execute",
        {
            "APIKey": SECRET,
            "APIToken": SECRET,
            "AWS_SECRET_ACCESS_KEY": SECRET,
            "AWSSecretAccessKey": SECRET,
            "accessToken": SECRET,
            "api_key": SECRET,
            "apiKey": SECRET,
            "auth": SECRET,
            "authentication": SECRET,
            "bearer": SECRET,
            "clientSecret": SECRET,
            "credential": SECRET,
            "customPasswd": SECRET,
            "DBPass": SECRET,
            "header": SECRET,
            "nested": {"checkpoint_id": SECRET, "command": "allowed"},
            "opaque": _HostileCaptureObject(),
            "oversized": "x" * 9000,
            "pass": SECRET,
            "passwd": SECRET,
            "passCount": 4,
            "passRate": 0.9,
            "passThrough": "allowed",
            "privateKey": SECRET,
            "correlationMarker": "reply-correlation-marker-123",
            "replyToken": "opaqueCredentialPayloadZ1234567890",
            "ReplyToken": SECRET,
            "reply_token": SECRET,
            "token": SECRET,
        },
    )
    if _HOSTILE_TYPE_NAME_READS[0] != 0:
        raise AssertionError("observability evaluated a hostile type name")
    oversized_capture = tool_request_guardrail(
        "execute", {f"item_{index}": "y" * 8000 for index in range(10)}
    )
    unsafe_relay_serialization = {
        "pickle": tool_request_guardrail(
            "execute",
            {"__nv_pickle__": "opaque.Artifact", "data": UNSAFE_RELAY_FALLBACK},
        ),
        "fallback_string": tool_request_guardrail(
            "execute",
            {
                "__nv_fallback_str__": "opaque.Artifact",
                "data": UNSAFE_RELAY_FALLBACK,
            },
        ),
    }
    cyclic_capture_input: list[Any] = []
    cyclic_capture_input.append(cyclic_capture_input)
    cyclic_capture = tool_request_guardrail("execute", cyclic_capture_input)
    shared_capture_input: list[Any] = ["leaf"]
    for _ in range(module._MAX_CAPTURE_DEPTH + 1):
        shared_capture_input = [shared_capture_input] * module._MAX_CAPTURE_ITEMS
    shared_capture = tool_request_guardrail("execute", shared_capture_input)
    hostile_identifier = module._safe_identifier(_HostileIdentifier(SECRET), "fallback")

    callback = module.new_metadata_only_callback_handler()
    callback.on_chain_start(
        {"serialized": SECRET},
        {"messages": [SECRET]},
        run_id="run-1",
        name="model",
        metadata={"arbitrary": SECRET},
        tags=[SECRET],
    )
    callback.on_chain_error(
        RuntimeError(SECRET),
        run_id="run-1",
        metadata={"arbitrary": SECRET},
    )
    callback.on_interrupt(
        SimpleNamespace(
            status=SECRET,
            checkpoint_id=SECRET,
            interrupts=[{"value": SECRET}],
        )
    )
    callback.on_resume(SimpleNamespace(status=SECRET, checkpoint_id=SECRET))

    first_middleware = module.new_relay_middleware()
    second_middleware = module.new_relay_middleware()
    callback_manager_boundary = _exercise_callback_manager_boundary(module)
    error_boundary = _exercise_middleware_errors(module)
    relay_fail_open = _exercise_relay_fail_open(module)
    fallback_exception_transparency = _exercise_fallback_exception_transparency(module)
    control_flow_suppression = _exercise_control_flow_suppression(module)
    emitted = {
        "request": {"headers": request.headers, "content": request.content},
        "response": response,
        "tool_request": tool_request,
        "tool_response": tool_response,
        "bounded_redaction": bounded_redaction,
        "oversized_capture": oversized_capture,
        "unsafe_relay_serialization": unsafe_relay_serialization,
        "cyclic_capture": cyclic_capture,
        "shared_capture": shared_capture,
        "hostile_identifier": hostile_identifier,
        "callback_records": list(scope.records),
    }
    identifier_boundaries = _exercise_identifier_boundaries(module, scope)
    module.shutdown_observability()
    module.shutdown_observability()

    return {
        "exact_opt_in": exact_opt_in,
        "initialized": initialized,
        "initialized_again": initialized_again,
        "ambient_environment_restored": ambient_environment_restored,
        "subscriber_count": len(_OpenInferenceSubscriber.instances),
        "config": {
            "transport": subscriber.config.transport,
            "endpoint": subscriber.config.endpoint,
            "headers": subscriber.config.headers,
            "service_name": subscriber.config.service_name,
            "timeout_millis": subscriber.config.timeout_millis,
        },
        "guardrail_priorities": {
            name: registration["priority"]
            for name, registration in guardrails.registered.items()
        },
        "emitted": emitted,
        "secret_present": SECRET in json.dumps(emitted, sort_keys=True),
        "middleware_distinct": first_middleware is not second_middleware,
        "middleware_name": first_middleware.name,
        "callback_manager_boundary": callback_manager_boundary,
        "error_boundary": error_boundary,
        "relay_fail_open": relay_fail_open,
        "fallback_exception_transparency": fallback_exception_transparency,
        "control_flow_suppression": control_flow_suppression,
        "identifier_boundaries": identifier_boundaries,
        "flush_calls": subscribers.flush_calls,
        "force_flush_calls": subscriber.force_flush_calls,
        "deregistered": subscriber.deregistered,
        "shutdown_calls": subscriber.shutdown_calls,
        "guardrails_deregistered": len(guardrails.deregistered),
    }


def _outage_scenario(path: Path, *, fail_construct: bool = False) -> dict[str, Any]:
    _, guardrails, subscribers, _ = _install_stubs(
        fail_flush=True,
        fail_force_flush=True,
        fail_construct=fail_construct,
    )
    module = _load_module(path)
    os.environ["NEMOCLAW_OBSERVABILITY"] = "1"
    initialized = module.initialize_observability()
    module.shutdown_observability()

    subscriber = (
        _OpenInferenceSubscriber.instances[0]
        if _OpenInferenceSubscriber.instances
        else None
    )
    return {
        "initialized": initialized,
        "flush_calls": subscribers.flush_calls,
        "force_flush_calls": subscriber.force_flush_calls if subscriber else 0,
        "deregistered": subscriber.deregistered if subscriber else [],
        "shutdown_calls": subscriber.shutdown_calls if subscriber else 0,
        "guardrails_deregistered": len(guardrails.deregistered),
    }


def _logging_failure_scenario(path: Path) -> dict[str, Any]:
    ambient_otel = {
        "OTEL_EXPORTER_OTLP_HEADERS": f"authorization={LOG_HEADER_SECRET}",
        "OTEL_EXPORTER_OTLP_CERTIFICATE": f"/nonexistent/{LOG_CERTIFICATE_SECRET}/ca.pem",
        "OTEL_EXPORTER_OTLP_CLIENT_KEY": f"/nonexistent/{LOG_CLIENT_KEY_SECRET}/client.key",
    }
    os.environ.update(ambient_otel)
    _, guardrails, _, _ = _install_stubs(fail_register=True)
    module = _load_module(path)
    os.environ["NEMOCLAW_OBSERVABILITY"] = "1"
    log_output = io.StringIO()
    handler = logging.StreamHandler(log_output)
    handler.setFormatter(logging.Formatter("%(levelname)s:%(message)s"))
    module.logger.setLevel(logging.DEBUG)
    module.logger.addHandler(handler)
    module.logger.propagate = False
    try:
        initialized = module.initialize_observability()
    finally:
        module.logger.removeHandler(handler)
        handler.close()

    subscriber = _OpenInferenceSubscriber.instances[0]
    return {
        "initialized": initialized,
        "logs": log_output.getvalue(),
        "ambient_environment_restored": all(
            os.environ.get(name) == value for name, value in ambient_otel.items()
        ),
        "shutdown_calls": subscriber.shutdown_calls,
        "guardrails_deregistered": len(guardrails.deregistered),
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: harness.py <privacy|outage|construction|logging> <module>"
        )
    scenario, raw_path = sys.argv[1:]
    path = Path(raw_path)
    if scenario == "privacy":
        result = _privacy_scenario(path)
    elif scenario == "outage":
        result = _outage_scenario(path)
    elif scenario == "construction":
        result = _outage_scenario(path, fail_construct=True)
    elif scenario == "logging":
        result = _logging_failure_scenario(path)
    else:
        raise SystemExit(f"unknown scenario: {scenario}")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
