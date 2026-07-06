# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Backend-neutral, metadata-only observability for managed Deep Agents Code."""

from __future__ import annotations

import atexit
import logging
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
_GUARDRAIL_NAME = "nemoclaw-dcode-metadata-only"
_EXPORT_TIMEOUT_MILLIS = 1_000
_LANGCHAIN_MODEL_RESPONSE_KEY = "__nemo_relay_integrations_langchain_model_response"
_REDACTED_EXCEPTION_MESSAGE = (
    "NEMOCLAW_DCODE_OPERATION_FAILED: managed operation failed (details redacted)"
)
_SCOPE_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9_.:/-]+")
_MAX_SCOPE_NAME_CHARS = 128
_AMBIENT_OTEL_PREFIX = "OTEL_"

logger = logging.getLogger(__name__)

_lifecycle_lock = threading.RLock()
_initialization_attempted = False
_active = False
_subscriber: Any = None


def observability_requested(env: dict[str, str] | None = None) -> bool:
    """Return whether the host requested the fixed managed observability path."""
    source = os.environ if env is None else env
    return source.get(_OBSERVABILITY_ENV) == "1"


def _safe_identifier(value: Any, fallback: str) -> str:
    """Sanitize and cap identifiers at 128 characters before Relay receives them."""
    if not isinstance(value, str):
        return fallback
    normalized = _SCOPE_NAME_UNSAFE.sub("_", value[:_MAX_SCOPE_NAME_CHARS]).strip("_")
    return normalized or fallback


def _metadata_only_llm_request(request: Any) -> Any:
    """Keep model identity while removing prompts, tools, headers, and settings."""
    import nemo_relay

    content = (
        request.content if isinstance(getattr(request, "content", None), dict) else {}
    )
    model = _safe_identifier(content.get("model"), "unknown")
    return nemo_relay.LLMRequest({}, {"messages": [], "model": model})


def _metadata_only_llm_response(_response: Any) -> dict[str, Any]:
    """Return a valid empty LangChain response for event annotation only."""
    from langchain_core.messages import AIMessage, messages_to_dict

    return {
        _LANGCHAIN_MODEL_RESPONSE_KEY: {
            "messages": messages_to_dict([AIMessage(content="")])
        }
    }


def _metadata_only_tool_request(_tool_name: str, _args: Any) -> dict[str, Any]:
    """Remove tool arguments from the emitted event without changing execution."""
    return {}


def _metadata_only_tool_response(_tool_name: str, _result: Any) -> None:
    """Remove tool results from the emitted event without changing execution."""
    return None


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
                metadata={"integration": "langgraph"},
            )
        except Exception:  # noqa: BLE001 - observability must not fail agent work
            logger.debug("NeMo Relay scope start failed", exc_info=True)
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
            nemo_relay.scope.pop(handle, metadata={"otel.status_code": status})
        except Exception:  # noqa: BLE001 - observability must not fail agent work
            logger.debug("NeMo Relay scope end failed", exc_info=True)

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
            logger.debug("NeMo Relay graph mark failed", exc_info=True)


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
            del inherit

        def remove_handler(self, _handler: Any) -> None:
            """Keep the managed handler installed for the graph lifetime."""

        def set_handler(self, _handler: Any, inherit: bool = True) -> None:
            """Reject attempts to replace the managed handler."""
            del inherit

        def set_handlers(self, _handlers: list[Any], inherit: bool = True) -> None:
            """Reject attempts to replace the managed handler set."""
            del inherit

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
        return error is not None and self._boundary.has_original


class _RelayExceptionBoundary:
    """Hide callback exceptions from Relay, then restore them for the agent."""

    def __init__(self) -> None:
        self._original: tuple[BaseException, TracebackType | None] | None = None

    @property
    def has_original(self) -> bool:
        return self._original is not None

    def capture(self, error: BaseException) -> None:
        if self._original is None:
            self._original = (error, error.__traceback__)

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
        raise error.with_traceback(traceback) from None


def new_relay_middleware() -> Any:
    """Create Relay middleware that never exposes agent exception text."""
    import nemo_relay
    from nemo_relay.integrations.langchain import NemoRelayMiddleware
    from nemo_relay.utils import run_sync

    class MetadataOnlyNemoRelayMiddleware(NemoRelayMiddleware):
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
            parent, codec, tool_name, tool_args = self._prepare_tool_call(request)
            boundary = _RelayExceptionBoundary()

            def redacted_call(args: Any) -> Any:
                callback_result: Any = None
                with boundary.capture_callback_exception():
                    callback_result = handler(
                        request.override(tool_call={**request.tool_call, "args": args})
                    )
                if boundary.has_original:
                    boundary.raise_redacted()
                return callback_result

            result: Any = None
            with boundary.suppress_relay_exception():
                result = run_sync(
                    nemo_relay.typed.tool_execute(
                        name=_safe_identifier(tool_name, "unknown"),
                        args=tool_args,
                        func=redacted_call,
                        args_codec=codec,
                        result_codec=codec,
                        handle=parent,
                    )
                )
            if boundary.has_original:
                boundary.restore_original()
            return result

        async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
            parent, codec, tool_name, tool_args = self._prepare_tool_call(request)
            boundary = _RelayExceptionBoundary()

            async def redacted_call(args: Any) -> Any:
                callback_result: Any = None
                with boundary.capture_callback_exception():
                    callback_result = await handler(
                        request.override(tool_call={**request.tool_call, "args": args})
                    )
                if boundary.has_original:
                    boundary.raise_redacted()
                return callback_result

            result: Any = None
            with boundary.suppress_relay_exception():
                result = await nemo_relay.typed.tool_execute(
                    name=_safe_identifier(tool_name, "unknown"),
                    args=tool_args,
                    func=redacted_call,
                    args_codec=codec,
                    result_codec=codec,
                    handle=parent,
                )
            if boundary.has_original:
                boundary.restore_original()
            return result

    return MetadataOnlyNemoRelayMiddleware(name="NemoClawObservabilityMiddleware")


def _deregister_guardrails() -> None:
    try:
        import nemo_relay

        nemo_relay.guardrails.deregister_llm_sanitize_request(_GUARDRAIL_NAME)
        nemo_relay.guardrails.deregister_llm_sanitize_response(_GUARDRAIL_NAME)
        nemo_relay.guardrails.deregister_tool_sanitize_request(_GUARDRAIL_NAME)
        nemo_relay.guardrails.deregister_tool_sanitize_response(_GUARDRAIL_NAME)
    except Exception:  # noqa: BLE001 - best-effort cleanup
        logger.debug("NeMo Relay guardrail cleanup failed", exc_info=True)


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
    global _active, _subscriber  # noqa: PLW0603

    with _lifecycle_lock:
        subscriber = _subscriber
        if subscriber is None:
            return
        _subscriber = None
        _active = False

    try:
        import nemo_relay

        nemo_relay.subscribers.flush()
    except Exception:  # noqa: BLE001 - shutdown remains fail-open
        logger.debug("NeMo Relay subscriber flush failed", exc_info=True)
    try:
        subscriber.force_flush()
    except Exception:  # noqa: BLE001 - bounded exporter failure is non-fatal
        logger.debug("NeMo Relay OTLP force-flush failed", exc_info=True)
    try:
        subscriber.deregister(_SUBSCRIBER_NAME)
    except Exception:  # noqa: BLE001 - best-effort cleanup
        logger.debug("NeMo Relay subscriber deregistration failed", exc_info=True)
    try:
        subscriber.shutdown()
    except Exception:  # noqa: BLE001 - best-effort cleanup
        logger.debug("NeMo Relay subscriber shutdown failed", exc_info=True)
    _deregister_guardrails()


def initialize_observability() -> bool:
    """Enable the fixed metadata-only Relay exporter when explicitly requested."""
    global _active, _initialization_attempted, _subscriber  # noqa: PLW0603

    if not observability_requested():
        return False
    with _lifecycle_lock:
        if _initialization_attempted:
            return _active
        _initialization_attempted = True

        subscriber: Any = None
        try:
            import nemo_relay

            nemo_relay.guardrails.register_llm_sanitize_request(
                _GUARDRAIL_NAME, 0, _metadata_only_llm_request
            )
            nemo_relay.guardrails.register_llm_sanitize_response(
                _GUARDRAIL_NAME, 0, _metadata_only_llm_response
            )
            nemo_relay.guardrails.register_tool_sanitize_request(
                _GUARDRAIL_NAME, 0, _metadata_only_tool_request
            )
            nemo_relay.guardrails.register_tool_sanitize_response(
                _GUARDRAIL_NAME, 0, _metadata_only_tool_response
            )

            subscriber = _new_managed_subscriber(nemo_relay)
            subscriber.register(_SUBSCRIBER_NAME)
        except Exception:  # noqa: BLE001 - tracing setup must not stop the agent
            logger.warning(
                "Managed observability could not be initialized; continuing without tracing",
                exc_info=True,
            )
            if subscriber is not None:
                try:
                    subscriber.shutdown()
                except Exception:  # noqa: BLE001 - best-effort rollback
                    logger.debug("NeMo Relay rollback failed", exc_info=True)
            _deregister_guardrails()
            return False

        _subscriber = subscriber
        _active = True
        atexit.register(shutdown_observability)
        return True
