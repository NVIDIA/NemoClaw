# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Default Model Router policy at the existing LiteLLM deployment boundary."""

import contextvars
import json
import sys
from contextlib import asynccontextmanager

LIGHTNING = "nvidia/nemotron-3.5-lightning-30b-a3b"
SUPER_VL = "nvidia/nemotron-3.5-super-vl-120b-a12b"
POLICY = "rules-v1"
_selection = contextvars.ContextVar("nemoclaw_selection", default=None)


def select_model(request):
    """Validate the entire conversation before selecting a configured model."""
    messages = request.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("Model Router requires a nonempty messages array.")
    image = False
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError("Model Router requires message objects.")
        content = message.get("content")
        if content is None and (message.get("tool_calls") or message.get("function_call")):
            continue
        if isinstance(content, str):
            continue
        if not isinstance(content, list) or not content:
            raise ValueError("Model Router supports text and image content only.")
        for part in content:
            if not isinstance(part, dict):
                raise ValueError("Model Router requires content objects.")
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                continue
            if part.get("type") == "image_url":
                url = part.get("image_url")
                if isinstance(url, dict) and isinstance(url.get("url"), str) and url["url"]:
                    image = True
                    continue
            raise ValueError("Model Router supports text and image content only.")
    if any(key in request for key in ("user_config", "api_base", "api_key", "fallbacks", "mock_response", "specific_deployment")):
        raise ValueError("Model Router does not accept deployment overrides.")
    metadata = request.get("metadata", {})
    if metadata is None:
        metadata = {}
    if not isinstance(metadata, dict):
        raise ValueError("Model Router metadata must be an object.")
    if "models" in metadata:
        raise ValueError("The rules policy does not accept a models ranking override.")
    pin = metadata.get("pin_model")
    model = request.get("model", "nvidia-routed")
    if pin is None and model != "nvidia-routed":
        pin = model
    if pin is not None:
        if pin not in (LIGHTNING, SUPER_VL):
            raise ValueError("Unknown Model Router selection. Use a configured pool model.")
        if image and pin == LIGHTNING:
            raise ValueError("Lightning does not support images. Select SuperVL.")
        return pin, "explicit"
    return (SUPER_VL, "image") if image else (LIGHTNING, "text")


class RulesStrategy:
    """Select one existing deployment without scores or a default fallback."""

    def __init__(self, router):
        self.router = router

    def get_available_deployment(self, model, messages=None, input=None,
                                 specific_deployment=False, request_kwargs=None):
        selection = _selection.get()
        if selection is None:
            selection = select_model({**(request_kwargs or {}), "model": model, "messages": messages})
        selected = selection[0]
        for deployment in self.router.model_list:
            if deployment.get("model_name") == selected:
                return deployment
        raise ValueError("Selected Model Router deployment is unavailable.")

    async def async_get_available_deployment(self, *args, **kwargs):
        return self.get_available_deployment(*args, **kwargs)


class RulesMiddleware:
    """Validate before dispatch and attach evidence to this request's response."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        selection = None
        if scope["path"] in ("/chat/completions", "/v1/chat/completions"):
            body = bytearray()
            while True:
                event = await receive()
                if event["type"] == "http.disconnect":
                    return
                body.extend(event.get("body", b""))
                if not event.get("more_body", False):
                    break
            try:
                request = json.loads(body)
                if not isinstance(request, dict):
                    raise ValueError("Model Router requires a request object.")
                selection = select_model(request)
                del request
            except (json.JSONDecodeError, UnicodeDecodeError):
                return await self.reject(send, "Model Router requires valid JSON.", 400)
            except ValueError as error:
                # Validation messages contain no caller-controlled values.
                return await self.reject(send, str(error), 400)
            original_receive = receive
            delivered = False

            async def replay():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await original_receive()

            receive = replay
        token = _selection.set(selection)

        async def evidence(event):
            if event["type"] == "http.response.start":
                headers = list(event.get("headers", []))
                headers.append((b"x-nemoclaw-router-policy", POLICY.encode()))
                if selection:
                    headers.extend([(b"x-model-router-selected", selection[0].encode()),
                                    (b"x-model-router-rule", selection[1].encode())])
                    print("Model Router selected=%s rule=%s" % selection, file=sys.stderr, flush=True)
                event = {**event, "headers": headers}
            await send(event)

        try:
            await self.app(scope, receive, evidence)
        finally:
            _selection.reset(token)

    @staticmethod
    async def reject(send, message, status):
        body = json.dumps({"error": {"message": message, "type": "invalid_request_error"}}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": body})


def start_proxy(litellm_config, router_config, host, port):
    # Reuse the pinned toolkit's config and LiteLLM service; do not build its prefill router.
    import os
    from model_router_toolkit.config import load_config
    config = load_config(router_config)
    if config.routing.method != "rules" or len(config.models) != 2 or set(config.model_names) != {LIGHTNING, SUPER_VL}:
        raise ValueError("Rules routing requires the supported Lightning and SuperVL pool.")
    os.environ["CONFIG_FILE_PATH"] = litellm_config
    import litellm.proxy.proxy_server as proxy
    import uvicorn

    lifespan = proxy.app.router.lifespan_context

    @asynccontextmanager
    async def register(app):
        # LiteLLM owns an explicit lifespan; FastAPI does not run on_event hooks with it.
        async with lifespan(app) as state:
            if proxy.llm_router is None:
                raise RuntimeError("LiteLLM did not initialize the Model Router pool.")
            proxy.llm_router.set_custom_routing_strategy(RulesStrategy(proxy.llm_router))
            print("Model Router rules policy registered", file=sys.stderr, flush=True)
            yield state

    proxy.app.router.lifespan_context = register
    proxy.app.add_middleware(RulesMiddleware)
    uvicorn.run(proxy.app, host=host, port=port)
