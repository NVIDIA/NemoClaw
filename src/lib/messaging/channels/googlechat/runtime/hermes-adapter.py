# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Google Chat connect-time shim for Hermes inside a NemoClaw sandbox.

Channel-owned runtime asset (`src/lib/messaging/AGENTS.md`), beside OpenClaw's
`googlechat-*.ts` preloads. The sandbox forces two deltas on the bundled
adapter, and everything else runs unchanged through a subclass:

* Inbound — the OpenShell L7 protocol set has no gRPC, so StreamingPull cannot
  be inspected; pull the same subscription over the Pub/Sub REST API.
* Outbound — the service-account key stays gateway-side, so requests carry the
  placeholder OpenShell injected as `GOOGLE_CHAT_ACCESS_TOKEN`, verbatim, over
  aiohttp. See `_gc_outbound_bearer`.

It attaches through published seams: `platform_registry.get()` forces the
deferred loader, `dataclasses.replace` keeps every `PlatformEntry` field, and
`register()` documents last-writer-wins. `_validate_config`,
`_load_sa_credentials` and `_new_authed_http` are Hermes internals only because
`PlatformEntry` carries no credential or transport field;
`image-build-probes.py googlechat-override-seams` pins them so drift fails the
image build instead of silently restoring the stock gRPC adapter.
"""

import asyncio
import dataclasses
import importlib.util
import logging

# Credential key carrying the outbound bearer. Its value is a resolver
# placeholder, not a credential: the L7 proxy swaps it at egress.
_GC_TOKEN_ENV = "GOOGLE_CHAT_ACCESS_TOKEN"  # noqa: S105
_GC_BEARER_CACHE: dict[str, str] = {}
_GC_PULL_TIMEOUT = 95.0  # aiohttp cap > the Pub/Sub server long-poll hold (~90s)
_GC_LOG = logging.getLogger("gateway.platforms.google_chat")


class _RestPubsubMessage:
    """REST ``receivedMessage`` shaped as what ``_on_pubsub_message`` touches."""

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
        # Omit the ackId -> Pub/Sub redelivers, matching message.nack().
        pass


def _gc_placeholder_credentials():
    """Credentials carrying the placeholder the L7 proxy swaps; nothing is signed here."""
    from google.auth import credentials as ga_credentials

    class _PlaceholderCredentials(ga_credentials.Credentials):
        def __init__(self):
            super().__init__()
            self.token = _gc_outbound_bearer()

        def refresh(self, request):  # signed gateway-side; nothing to do here
            self.token = _gc_outbound_bearer()

    return _PlaceholderCredentials()


def _gc_gateway_environs():
    """Yield the environment of each candidate Hermes gateway process.

    - ``os.environ`` is unreliable at reply time: the gateway clears variables
      during a turn, and replies run in a worker thread that never carried them.
    - ``/proc/<pid>/environ`` keeps what the process started with.
    - Yields instead of returning the first match, so a candidate missing the
      wanted key does not end the search.
    """
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
        yield env


def _gc_gateway_proxy_url():
    """Return the egress proxy URL, or ``""`` for direct egress."""
    for env in _gc_gateway_environs():
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


def _gc_outbound_bearer():
    """Return the resolver placeholder OpenShell injected for the Chat bearer.

    Forwarded verbatim:

    - 0.0.106 binds this credential to its endpoints, then refuses any
      placeholder without a revision. The canonical form this module used to
      hardcode is denied as ``credential_unavailable``.
    - The injected value is the revision-scoped form issued to this workload,
      which the proxy accepts.
    - It survives gateway token refreshes: a refreshed generation adds its
      revision to the credential's identity epoch rather than replacing it, so
      the boot revision stays resolvable and falls back to the current secret.
      Only replacing the provider resets that, and that needs a rebuild.
    - Older OpenShell issues the canonical form as revision zero, so reading the
      environment is correct there too. No version branch needed.
    - Resolved once and cached: the value is stable for the sandbox's lifetime,
      and reply-time lookups cannot rely on ``os.environ``.
    """
    import os

    cached = _GC_BEARER_CACHE.get(_GC_TOKEN_ENV)
    if cached:
        return cached
    value = (os.environ.get(_GC_TOKEN_ENV) or "").strip()
    if not value:
        for env in _gc_gateway_environs():
            value = (env.get(_GC_TOKEN_ENV) or "").strip()
            if value:
                break
    if not value:
        raise RuntimeError(
            f"nemoclaw googlechat: {_GC_TOKEN_ENV} is not set; the gateway-minted "
            "outbound bearer is unavailable. Check that the Google Chat bridge "
            "provider is attached to this sandbox."
        )
    _GC_BEARER_CACHE[_GC_TOKEN_ENV] = value
    return value


class _GcAiohttpTransport:
    """``httplib2.Http``-shaped transport (``.request()`` only) built on aiohttp.

    googleapiclient only calls ``.request()`` and reads ``resp.status`` plus
    content, so an ``httplib2.Response`` satisfies it. httplib2 itself cannot be
    used: without PySocks it connects direct, which the proxy-only netns cannot
    resolve, and with PySocks ``PROXY_TYPE_HTTP`` refuses the CONNECT tunnel.
    """

    def request(self, uri, method="GET", body=None, headers=None, **kwargs):
        import aiohttp

        import plugins.platforms.google_chat.adapter as _gc

        proxy = _gc_gateway_proxy_url() or None
        data = body.encode("utf-8") if isinstance(body, str) else body

        async def _run():
            # Mirror the inbound :pull: ClientSession(trust_env=True) with no ssl
            # override, whose default trust already accepts the proxy's MITM chain
            # (a hand-built CA context was rejected). The proxy is passed explicitly
            # because os.environ may be cleared by reply time.
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

        # Chat calls run under ``asyncio.to_thread``, so a fresh loop is safe here.
        return asyncio.run(_run())


def _gc_spec_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def _nemoclaw_gc_check() -> bool:
    """Passive probe: aiohttp for the pull, google SDKs for the inherited paths."""
    return all(
        _gc_spec_available(module_name)
        for module_name in ("aiohttp", "google.auth", "google.cloud.pubsub_v1")
    )


def _sandbox_adapter_class():
    """Build the subclass lazily: the bundled module only imports inside the sandbox."""
    import plugins.platforms.google_chat.adapter as _gc

    class SandboxGoogleChatAdapter(_gc.GoogleChatAdapter):
        """Bundled adapter with the sandbox transport and credential delta."""

        _sandbox_subscription = None

        def _validate_config(self):
            """Report no subscription so the bundled ``connect()`` skips its gRPC
            precheck and supervisor; upstream validation still runs, and the real
            subscription is kept for ``_rest_pull``.
            """
            project_id, subscription_path = super()._validate_config()
            self._sandbox_subscription = subscription_path
            return project_id, None

        def _load_sa_credentials(self):
            """Return the placeholder the L7 proxy swaps; nothing is signed here."""
            return _gc_placeholder_credentials()

        def _new_authed_http(self):
            """Route every Chat REST call (reply, patch, typing card, bot-id lookup)
            through aiohttp instead of httplib2, still on the placeholder token.
            """
            import plugins.platforms.google_chat.adapter as _gc

            return _gc.AuthorizedHttp(self._credentials, http=_GcAiohttpTransport())

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            """Run the bundled connect(), then start the REST pull it skipped."""
            connected = await super().connect(is_reconnect=is_reconnect)
            # Hermes v2026.8.27 builds a fresh adapter for every reconnect, so this
            # never runs twice on one instance; a release that reuses the instance
            # would need the running pull replaced here.
            if connected and self._sandbox_subscription:
                self._supervisor_task = asyncio.create_task(self._rest_pull())
                _GC_LOG.info(
                    "[GoogleChat][NemoClaw] keyless REST pull active (no gRPC subscriber)"
                )
            return connected

        async def _rest_pull(self):
            """Pull the subscription over the Pub/Sub REST unary API, in place of the
            bundled gRPC supervisor. Messages reach the unchanged
            ``_on_pubsub_message`` in a worker thread, keeping its contract.
            """
            import aiohttp

            sub = self._sandbox_subscription
            pull_url = f"https://pubsub.googleapis.com/v1/{sub}:pull"
            ack_url = f"https://pubsub.googleapis.com/v1/{sub}:acknowledge"
            headers = {
                "Authorization": f"Bearer {_gc_outbound_bearer()}",
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
                            # Read and materialise the envelope here, so a body that is
                            # not an object and a receivedMessages that is not iterable
                            # are both failed pulls rather than escaping exceptions.
                            received = list(payload.get("receivedMessages") or [])
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:  # noqa: BLE001 - transient pull errors are retried
                        _GC_LOG.warning("[GoogleChat][NemoClaw] :pull error: %s", exc)
                        await asyncio.sleep(3)
                        continue

                    if not received:
                        await asyncio.sleep(0.2)  # guard against fast-empty long-poll returns
                        continue

                    acks: list = []
                    for received_message in received:
                        ack_id = None
                        try:
                            ack_id = received_message.get("ackId")
                            shim = _RestPubsubMessage(
                                received_message.get("message") or {}, acks, ack_id
                            )
                        except Exception:  # noqa: BLE001 - a corrupt delivery ends nothing
                            # Redelivery cannot repair the same undecodable bytes, so
                            # retire it the way the bundled handler retires an
                            # unparseable envelope. Otherwise it may be redelivered
                            # repeatedly, and GOOGLE_CHAT_MAX_MESSAGES defaults to 1,
                            # so each redelivery costs a whole pull response.
                            _GC_LOG.exception(
                                "[GoogleChat][NemoClaw] retiring an unreadable delivery"
                            )
                            if ack_id:
                                acks.append(ack_id)
                            continue
                        try:
                            await asyncio.to_thread(self._on_pubsub_message, shim)
                        except Exception:  # noqa: BLE001 - one bad message must not kill the loop
                            # Nothing is added to acks here: the handler acknowledges
                            # for itself, and unlike an unreadable payload its failure
                            # can be transient, so redelivery stays the default.
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


    return SandboxGoogleChatAdapter


def install(ctx) -> None:
    """Replace the registered google_chat entry with the sandbox delta."""
    del ctx
    try:
        from gateway.platform_registry import platform_registry
    except Exception:  # noqa: BLE001 - keep plugin load resilient
        _GC_LOG.exception("[GoogleChat][NemoClaw] platform_registry import failed")
        return

    entry = platform_registry.get("google_chat")
    if entry is None:
        _GC_LOG.error(
            "[GoogleChat][NemoClaw] no google_chat platform entry; leaving Hermes untouched"
        )
        return

    try:
        adapter_class = _sandbox_adapter_class()
    except Exception:  # noqa: BLE001 - a failed import must not break other platforms
        _GC_LOG.exception("[GoogleChat][NemoClaw] building the sandbox adapter failed")
        return

    platform_registry.register(
        dataclasses.replace(
            entry,
            adapter_factory=adapter_class,
            check_fn=_nemoclaw_gc_check,
            required_env=["GOOGLE_CHAT_SUBSCRIPTION_NAME"],
        )
    )
    _GC_LOG.info(
        "[GoogleChat][NemoClaw] google_chat adapter replaced with the sandbox delta "
        "(bundled entry metadata preserved)"
    )
