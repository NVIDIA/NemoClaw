# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Isolated contract harness for managed Deep Agents Code observability."""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import os
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any

SECRET = "NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL"
_RELAY_OBSERVED_ERRORS: list[dict[str, Any]] = []


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


class _RelayWrappedError(RuntimeError):
    pass


def _raise_relay_wrapped(error: Exception) -> None:
    _RELAY_OBSERVED_ERRORS.append(
        {
            "type": type(error).__name__,
            "message": str(error),
            "context_is_none": error.__context__ is None,
            "cause_is_none": error.__cause__ is None,
        }
    )
    raise _RelayWrappedError("relay wrapped callback failure") from error


async def _tool_execute(*, args: Any, func: Any, **_kwargs: Any) -> Any:
    try:
        result = func(args)
        return await result if inspect.isawaitable(result) else result
    except Exception as error:
        _raise_relay_wrapped(error)


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
        del model_name, codec, response_codec
        try:
            return await func(request)
        except Exception as error:
            _raise_relay_wrapped(error)

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
) -> tuple[types.ModuleType, _Guardrails, _SubscriberCollection, _Scope]:
    _RELAY_OBSERVED_ERRORS.clear()
    guardrails = _Guardrails()
    subscribers = _SubscriberCollection(fail_flush=fail_flush)
    scope = _Scope()
    _OpenInferenceSubscriber.instances = []
    _OpenInferenceSubscriber.fail_force_flush = fail_force_flush
    _OpenInferenceSubscriber.fail_construct = fail_construct

    relay = types.ModuleType("nemo_relay")
    relay.LLMRequest = _LLMRequest
    relay.OpenInferenceConfig = _OpenInferenceConfig
    relay.OpenInferenceSubscriber = _OpenInferenceSubscriber
    relay.ScopeType = SimpleNamespace(Agent="agent")
    relay.guardrails = guardrails
    relay.subscribers = subscribers
    relay.scope = scope
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


class _ToolCallRequest:
    def __init__(self, tool_call: dict[str, Any]) -> None:
        self.tool_call = tool_call

    def override(self, *, tool_call: dict[str, Any]) -> _ToolCallRequest:
        return _ToolCallRequest(tool_call)


def _preserved_exception(error: Exception, caught: Exception) -> dict[str, Any]:
    return {
        "same_instance": caught is error,
        "type": type(caught).__name__,
        "message": str(caught),
    }


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
        "control_flow": control_flow,
        "relay_observed": list(_RELAY_OBSERVED_ERRORS),
        "secret_present_in_relay_errors": SECRET
        in json.dumps(_RELAY_OBSERVED_ERRORS, sort_keys=True),
    }


def _privacy_scenario(path: Path) -> dict[str, Any]:
    os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"https://attacker.invalid/{SECRET}"
    os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = f"authorization={SECRET}"
    os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = (
        f"https://traces.attacker.invalid/{SECRET}"
    )
    os.environ["OTEL_EXPORTER_OTLP_TRACES_HEADERS"] = f"x-api-key={SECRET}"
    _, guardrails, subscribers, scope = _install_stubs()
    module = _load_module(path)

    exact_opt_in = {
        value: module.observability_requested({"NEMOCLAW_OBSERVABILITY": value})
        for value in ("1", "true", "TRUE", " 1", "0")
    }
    os.environ["NEMOCLAW_OBSERVABILITY"] = "1"
    initialized = module.initialize_observability()
    initialized_again = module.initialize_observability()
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
                "tools": [{"description": SECRET}],
                "model_settings": {"secret": SECRET},
            },
        )
    )
    response = response_guardrail({"content": SECRET, "error": SECRET})
    tool_request = tool_request_guardrail("execute", {"command": SECRET})
    tool_response = tool_response_guardrail("execute", {"stdout": SECRET})

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
    error_boundary = _exercise_middleware_errors(module)
    emitted = {
        "request": {"headers": request.headers, "content": request.content},
        "response": response,
        "tool_request": tool_request,
        "tool_response": tool_response,
        "callback_records": scope.records,
    }
    module.shutdown_observability()
    module.shutdown_observability()

    return {
        "exact_opt_in": exact_opt_in,
        "initialized": initialized,
        "initialized_again": initialized_again,
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
        "error_boundary": error_boundary,
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


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: harness.py <privacy|outage|construction> <module>")
    scenario, raw_path = sys.argv[1:]
    path = Path(raw_path)
    if scenario == "privacy":
        result = _privacy_scenario(path)
    elif scenario == "outage":
        result = _outage_scenario(path)
    elif scenario == "construction":
        result = _outage_scenario(path, fail_construct=True)
    else:
        raise SystemExit(f"unknown scenario: {scenario}")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
