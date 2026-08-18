# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Google Chat adapter for Hermes running inside a NemoClaw sandbox.

Rebinds the bundled Hermes Google Chat adapter to the transports and
credentials a sandbox allows: events arrive over the Pub/Sub REST API instead
of gRPC, and replies leave through the OpenShell L7 proxy carrying a
gateway-minted placeholder instead of a locally signed token.

Loaded by the NemoClaw plugin's ``register()`` only when the sandbox is
configured for the Google Chat channel, so a Hermes sandbox without that
channel never wraps the platform registry. Companion NemoClaw config lives in
``src/lib/messaging/channels/googlechat/`` (manifest, policy preset, provider
profile); the OpenClaw equivalent of this file is that channel's
``runtime/googlechat-outbound-auth.ts`` boot preload.

Why the bundled transports are replaced
---------------------------------------
Standalone Hermes receives Chat events over a gRPC Pub/Sub StreamingPull and
signs its bot token in-process from a service-account key. Neither survives
inside a NemoClaw sandbox:

* **Inbound.** All sandbox egress traverses the OpenShell L7 proxy, whose
  protocol set is ``rest, websocket, graphql, sql, json-rpc, mcp`` — there is no
  gRPC variant, so ``protocol: grpc`` fails policy validation. Raw relay
  (``tls: skip``) would carry the bytes but disables the inspection that the
  credential swap depends on, and the policy engine rejects pairing an
  inspecting middleware with a skipped endpoint. So this module PULLS the same
  subscription over the Pub/Sub REST unary API (``:pull`` / ``:acknowledge``),
  which the proxy can read.
* **Outbound.** The service-account key must stay out of the sandbox: the
  gateway mints the token and the L7 proxy swaps the
  ``openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN`` placeholder on the way out.
  The bundled adapter has no seam for a pre-minted token and hardcodes
  ``httplib2.Http()``, which cannot proxy HTTPS here, so this module supplies
  placeholder credentials plus an aiohttp transport.

This is not a stopgap awaiting gRPC support: L7 inspection and gRPC are in
tension by design, so keyless Google Chat would not get simpler if OpenShell
added a gRPC protocol variant. Hermes does also support an inbound HTTP-events
webhook, which would remove the inbound half of this override but not the
outbound half, at the cost of a public inbound URL; NemoClaw keeps pull.

Override mechanism
------------------
This is a registered-adapter wrap via the sanctioned ``platform_registry``
seam, NOT a runtime monkeypatch of the bundled module. ``register`` is wrapped
so the bundled ``google_chat`` entry is kept as-is except for its
``adapter_factory`` (bound to the keyless methods per instance),
``check_fn`` and ``required_env``. Everything else the bundled entry carries —
``env_enablement_fn``, ``validate_config``, ``is_connected``,
``allowed_users_env``, ``standalone_sender_fn``, ``platform_hint`` — is
preserved, and binding onto the instance keeps the override immune to the
synthetic module identity of the lazily loaded bundled plugin.

B300 live-validation points (managed image, not reproducible on a standalone
Hermes host):

* the registry wrap supersedes the bundled deferred loader in the managed-image
  plugin-load order (same runtime HERMES_HOME scope);
* ``from plugins.platforms.google_chat.adapter import GoogleChatAdapter``
  resolves under /opt/hermes in the managed image;
* the base ``connect()``'s ``SubscriberClient(credentials=placeholder)``
  constructs without egress (it is never ``.subscribe()``'d);
* ``AuthorizedHttp(placeholder_creds)`` on the reply path emits the placeholder
  bearer for the L7 swap.
"""

import asyncio
import importlib.util
import logging
import types

_GC_REST_PLACEHOLDER_TOKEN = "openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN"
_GC_PULL_TIMEOUT = 95.0  # aiohttp cap > the Pub/Sub server long-poll hold (~90s)
_GC_LOG = logging.getLogger("gateway.platforms.google_chat")


class _RestPubsubMessage:
    """Adapt a Pub/Sub REST receivedMessage to the four members the inherited
    _on_pubsub_message touches: .data (bytes), .attributes (dict), .ack(), .nack()."""

    def __init__(self, pmsg, ack_sink, ack_id):
        import base64

        self._ack_sink = ack_sink
        self._ack_id = ack_id
        raw = pmsg.get("data") or ""
        self.data = base64.b64decode(raw) if raw else b""
        self.attributes = pmsg.get("attributes") or {}

    def ack(self):
        if self._ack_id:
            self._ack_sink.append(self._ack_id)

    def nack(self):
        # Omit the ackId from the batch -> Pub/Sub redelivers, matching the
        # streaming client's message.nack() semantics.
        pass


async def _gc_rest_pull_supervisor(self):
    """Drop-in replacement for GoogleChatAdapter._run_supervisor that pulls via the
    Pub/Sub REST unary API instead of gRPC StreamingPull, then feeds each message
    into the UNCHANGED self._on_pubsub_message (run in a worker thread to preserve
    the 'callback off the event loop' contract). Keyless: the bearer is the
    placeholder the L7 proxy rewrites, so nothing is signed in-process and this path
    needs no google.auth."""
    import aiohttp

    sub = self._subscription_path
    pull_url = f"https://pubsub.googleapis.com/v1/{sub}:pull"
    ack_url = f"https://pubsub.googleapis.com/v1/{sub}:acknowledge"
    headers = {
        "Authorization": f"Bearer {_GC_REST_PLACEHOLDER_TOKEN}",
        "Content-Type": "application/json",
    }
    _GC_LOG.info(
        "[GoogleChat][NemoClaw] keyless Pub/Sub REST :pull transport active (sub=%s)",
        sub,
    )
    async with aiohttp.ClientSession(trust_env=True) as session:
        while not self._shutting_down:
            try:
                async with session.post(
                    pull_url,
                    json={"maxMessages": self._max_messages or 1},
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=_GC_PULL_TIMEOUT),
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        _GC_LOG.warning(
                            "[GoogleChat][NemoClaw] :pull HTTP %s: %s",
                            resp.status,
                            body[:200],
                        )
                        await asyncio.sleep(3)
                        continue
                    payload = await resp.json()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - transient pull errors are retried
                _GC_LOG.warning("[GoogleChat][NemoClaw] :pull error: %s", exc)
                await asyncio.sleep(3)
                continue

            received = payload.get("receivedMessages") or []
            if not received:
                await asyncio.sleep(0.2)  # guard against fast-empty long-poll returns
                continue

            acks: list = []
            for received_message in received:
                shim = _RestPubsubMessage(
                    received_message.get("message") or {},
                    acks,
                    received_message.get("ackId"),
                )
                try:
                    await asyncio.to_thread(self._on_pubsub_message, shim)
                except Exception:  # noqa: BLE001 - one bad message must not kill the loop
                    _GC_LOG.exception("[GoogleChat][NemoClaw] message handler raised")

            if acks:
                try:
                    async with session.post(
                        ack_url,
                        json={"ackIds": acks},
                        headers=headers,
                        timeout=aiohttp.ClientTimeout(total=30),
                    ) as ack_resp:
                        if ack_resp.status != 200:
                            _GC_LOG.warning(
                                "[GoogleChat][NemoClaw] :acknowledge HTTP %s",
                                ack_resp.status,
                            )
                except Exception as exc:  # noqa: BLE001 - a failed ack just redelivers
                    _GC_LOG.warning("[GoogleChat][NemoClaw] :acknowledge error: %s", exc)


def _gc_placeholder_credentials():
    """A google.auth Credentials whose token is the OpenShell placeholder the L7
    proxy rewrites to the gateway-minted bearer. refresh() is a no-op so nothing is
    signed in-process. Feeds both the idle SubscriberClient built by the inherited
    connect() and the reply path's AuthorizedSession, so both carry the placeholder."""
    from google.auth import credentials as ga_credentials

    class _PlaceholderCredentials(ga_credentials.Credentials):
        def __init__(self):
            super().__init__()
            self.token = _GC_REST_PLACEHOLDER_TOKEN

        def refresh(self, request):  # signed gateway-side; nothing to do here
            self.token = _GC_REST_PLACEHOLDER_TOKEN

    return _PlaceholderCredentials()


async def _gc_rest_pull_connect(self, *, is_reconnect: bool = False) -> bool:
    """Keyless REST-pull ``connect()``: the bundled ``connect()`` MINUS the gRPC
    Pub/Sub ``SubscriberClient`` + ``get_subscription()`` sanity check, which hangs
    for 30 s under the REST-only OpenShell egress policy (gRPC is blocked), and
    MINUS the legacy single-user OAuth probe (``__init__`` already defaults those to
    ``None``; attachments degrade to text). The REST ``:pull`` supervisor surfaces a
    bad subscription at first pull instead of a gRPC precheck. Everything else
    mirrors the bundled ``connect()``: lazy google-module load, config validate,
    placeholder creds, Chat REST client, thread-count store, bot-id resolution, then
    start the REST-pull supervisor."""
    import asyncio as _asyncio

    import plugins.platforms.google_chat.adapter as _gc

    if not _gc._load_google_modules():
        self._set_fatal_error(
            code="missing_deps",
            message="google-cloud-pubsub / google-api-python-client not installed",
            retryable=False,
        )
        return False

    self._loop = _asyncio.get_running_loop()
    try:
        project_id, subscription_path = self._validate_config()
        credentials = self._load_sa_credentials()
    except (ValueError, FileNotFoundError) as exc:
        msg = _gc._redact_sensitive(str(exc))
        _gc.logger.error("[GoogleChat] Config validation failed: %s", msg)
        self._set_fatal_error(code="config_invalid", message=msg, retryable=False)
        return False

    self._project_id = project_id
    self._subscription_path = subscription_path
    self._credentials = credentials

    try:
        self._chat_api = await _asyncio.to_thread(
            lambda: _gc.build_service(
                "chat", "v1", credentials=credentials, cache_discovery=False
            )
        )
    except Exception as exc:  # noqa: BLE001
        msg = _gc._redact_sensitive(str(exc))
        _gc.logger.error("[GoogleChat] Failed to build Chat API client: %s", msg)
        self._set_fatal_error(code="chat_api_init", message=msg, retryable=False)
        return False

    try:
        await _asyncio.to_thread(self._thread_count_store.load)
    except Exception:  # noqa: BLE001
        _gc.logger.warning(
            "[GoogleChat] thread-count store load failed (treating all threads as fresh)",
            exc_info=True,
        )

    # SKIP bundled gRPC block (pubsub_v1.SubscriberClient + get_subscription()):
    # gRPC is denied by the REST-only egress policy and hangs; the keyless REST
    # :pull loop never touches self._subscriber (stays None; disconnect() guards it).

    self._bot_user_id = self._load_cached_bot_id()
    if not self._bot_user_id:
        self._bot_user_id = await self._resolve_bot_user_id()
        if self._bot_user_id:
            self._save_cached_bot_id(self._bot_user_id)
        else:
            _gc.logger.info(
                "[GoogleChat] bot_user_id not yet resolved; will resolve on first "
                "addedToSpace or member lookup"
            )

    if subscription_path is not None:
        self._supervisor_task = _asyncio.create_task(self._run_supervisor())
    else:
        self._supervisor_task = None

    self._mark_connected()
    _gc.logger.info(
        "[GoogleChat][NemoClaw] Connected keyless (REST :pull, no gRPC subscriber); "
        "project=%s, subscription=%s, bot_user_id=%s",
        project_id or "<unset>",
        "<redacted>" if subscription_path else "<none>",
        self._bot_user_id or "<unresolved>",
    )
    return True


def _gc_gateway_proxy_url():
    """The OpenShell egress proxy URL, read from the ``hermes.real gateway``
    process's IMMUTABLE ``/proc/<pid>/environ``. os.environ is unreliable (the gateway
    clears the proxy vars during an agent turn), and ``/proc/self`` is NOT the gateway
    in the reply's execution context — the Chat reply runs under ``asyncio.to_thread``
    whose ``/proc/self/environ`` does not carry the launcher-set proxy. So locate the
    gateway process by cmdline and read its startup env, which keeps the proxy for the
    life of the process. Returns ``""`` when no proxy is found (direct egress)."""
    import glob

    for cmd_path in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            with open(cmd_path, "rb") as cmdline_handle:
                cmdline = cmdline_handle.read()
        except OSError:
            continue
        if b"hermes.real" not in cmdline or b"gateway" not in cmdline or b"dashboard" in cmdline:
            continue
        try:
            with open(cmd_path.rsplit("/", 1)[0] + "/environ", "rb") as handle:
                env = {}
                for pair in handle.read().split(b"\0"):
                    key, sep, value = pair.partition(b"=")
                    if sep:
                        env[key.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
        except OSError:
            continue
        url = (
            env.get("https_proxy")
            or env.get("HTTPS_PROXY")
            or env.get("http_proxy")
            or env.get("HTTP_PROXY")
            or ""
        )
        if url:
            return url
    return ""


class _GcAiohttpTransport:
    """An ``httplib2.Http``-compatible transport (``.request()`` only) that routes
    Chat REST calls through the OpenShell L7 proxy via aiohttp — the ONLY transport
    that works from the gateway process in this sandbox.

    The bundled Chat client is google-api-python-client over httplib2, whose HTTPS
    proxy support is unusable here: without PySocks ``ProxyInfo.isgood()`` is falsy, so
    httplib2 silently connects DIRECT — which the proxy-only sandbox netns cannot
    resolve (name-resolution failure); WITH PySocks its ``PROXY_TYPE_HTTP`` rejects the
    CONNECT tunnel. aiohttp CONNECT-tunnels through the proxy exactly as the inbound
    ``:pull`` does, and the gateway process is the one the proxy authorizes and injects
    the minted bot token for (ad-hoc processes are refused at CONNECT). The proxy is
    read from the gateway's ``/proc/<pid>/environ`` (os.environ is unreliable), and TLS
    trusts the system CA bundle, which carries the proxy's MITM root. googleapiclient
    only calls ``.request(uri, method, body, headers)`` and reads ``resp.status`` +
    content, which this provides via an ``httplib2.Response``."""

    def request(self, uri, method="GET", body=None, headers=None, **kwargs):
        import aiohttp

        import plugins.platforms.google_chat.adapter as _gc

        proxy = _gc_gateway_proxy_url() or None
        data = body.encode("utf-8") if isinstance(body, str) else body

        async def _run():
            # Mirror the inbound :pull exactly: ClientSession(trust_env=True) with no
            # ssl override. That is the transport the L7 proxy authorizes for this
            # gateway process, and its default TLS trust already accepts the proxy's
            # MITM chain (pinning a hand-built CA context rejected it). The proxy is
            # still passed explicitly because os.environ may be cleared by reply time.
            async with aiohttp.ClientSession(trust_env=True) as session:
                async with session.request(
                    method,
                    uri,
                    data=data,
                    headers=dict(headers or {}),
                    proxy=proxy,
                    timeout=aiohttp.ClientTimeout(total=60),
                ) as resp:
                    content = await resp.read()
                    info = {"status": resp.status}
                    for key, value in resp.headers.items():
                        info[key.lower()] = value
                    return _gc.httplib2.Response(info), content

        # The Chat calls run under ``asyncio.to_thread`` (a worker thread with no
        # running event loop), so a fresh loop here via asyncio.run is safe.
        return asyncio.run(_run())


def _gc_rest_reply_http(self):
    """``_new_authed_http()`` override for the keyless Chat reply path.

    Returns ``AuthorizedHttp(placeholder_creds, http=_GcAiohttpTransport())``. The
    bundled ``httplib2.Http`` cannot proxy HTTPS in this sandbox (see
    ``_GcAiohttpTransport``), so every Chat call that flows through
    ``_new_authed_http`` — reply create, message patch, typing card, bot-id lookup —
    is routed via aiohttp instead. Credentials stay the placeholder creds bound in
    connect(); ``AuthorizedHttp`` adds the placeholder bearer header that the L7 proxy
    swaps for the minted bot token, exactly as on the ``:pull`` path."""
    import plugins.platforms.google_chat.adapter as _gc

    return _gc.AuthorizedHttp(self._credentials, http=_GcAiohttpTransport())


def _gc_bind_overrides(adapter):
    """Bind the keyless REST-pull behavior onto a bundled GoogleChatAdapter
    instance: a connect() that skips the gRPC subscriber precheck, the REST `:pull`
    supervisor (inbound), placeholder credentials, and a reply transport routed
    through the L7 proxy with the system CA (outbound Chat REST). Binding onto the
    instance with types.MethodType — rather than subclassing + re-registering — keeps
    every other bundled method AND the bundled registry metadata (env_enablement_fn
    seeds project_id/subscription into PlatformConfig.extra, validate_config, …)
    intact, and is immune to the synthetic module identity of the lazily loaded
    bundled plugin."""
    adapter.connect = types.MethodType(_gc_rest_pull_connect, adapter)
    adapter._run_supervisor = types.MethodType(_gc_rest_pull_supervisor, adapter)
    adapter._load_sa_credentials = types.MethodType(
        lambda self: _gc_placeholder_credentials(), adapter
    )
    adapter._new_authed_http = types.MethodType(_gc_rest_reply_http, adapter)
    return adapter


def _gc_spec_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def _nemoclaw_gc_check() -> bool:
    """Passive dependency probe (side-effect free — no heavy import): the keyless
    REST-pull path needs aiohttp; the inherited connect()/reply path needs the
    google-auth + pubsub SDKs shipped in the managed image."""
    return all(
        _gc_spec_available(module_name)
        for module_name in ("aiohttp", "google.auth", "google.cloud.pubsub_v1")
    )


def install(ctx) -> None:
    """Make the bundled Google Chat adapter run keyless REST-pull WITHOUT dropping
    the bundled registry entry's config-seeding metadata.

    A fresh ``register_platform`` (last-writer-wins) loses the bundled entry's
    ``env_enablement_fn`` — the hook that seeds ``PlatformConfig.extra.project_id``
    / ``subscription_name`` from ``GOOGLE_CHAT_*`` env — so connect() fails with
    "GOOGLE_CHAT_PROJECT_ID is not set". Instead wrap ``platform_registry.register``
    so when the bundled ``google_chat`` entry registers (its deferred loader runs at
    gateway start) it is KEPT as-is except: (a) ``adapter_factory`` is wrapped to
    bind the REST-pull supervisor + placeholder credentials onto each instance, and
    (b) ``check_fn`` / ``required_env`` are swapped to the keyless contract (no SA
    JSON in the sandbox). Every other field — env_enablement_fn, validate_config,
    is_connected, allowed_users_env, standalone_sender_fn, platform_hint, … — is
    preserved. ``ctx`` is unused; the registry is the single override point."""
    del ctx
    try:
        from gateway.platform_registry import platform_registry as _preg
    except Exception:  # noqa: BLE001 - keep plugin load resilient
        _GC_LOG.exception("[GoogleChat][NemoClaw] platform_registry import failed")
        return
    if getattr(_preg, "_nemoclaw_gc_wrapped", False):
        return
    _orig_register = _preg.register

    def _wrapped_register(entry, *args, **kwargs):
        try:
            if getattr(entry, "name", None) == "google_chat":
                _orig_factory = entry.adapter_factory

                def _factory(cfg, _f=_orig_factory):
                    try:
                        return _gc_bind_overrides(_f(cfg))
                    except Exception:  # noqa: BLE001 - fall back to the stock adapter
                        _GC_LOG.exception("[GoogleChat][NemoClaw] instance override failed")
                        return _f(cfg)

                entry.adapter_factory = _factory
                entry.check_fn = _nemoclaw_gc_check
                entry.required_env = ["GOOGLE_CHAT_SUBSCRIPTION_NAME"]
                _GC_LOG.info(
                    "[GoogleChat][NemoClaw] wrapped bundled google_chat adapter "
                    "(keyless REST-pull; bundled metadata preserved)"
                )
        except Exception:  # noqa: BLE001 - never let the wrap abort a registration
            _GC_LOG.exception("[GoogleChat][NemoClaw] register wrap failed")
        return _orig_register(entry, *args, **kwargs)

    _preg.register = _wrapped_register
    _preg._nemoclaw_gc_wrapped = True
