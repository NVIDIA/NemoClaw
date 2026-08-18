# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Google Chat connect-time shim for Hermes inside a NemoClaw sandbox.

Channel-owned runtime asset (`src/lib/messaging/AGENTS.md`). OpenClaw's
equivalents are the sibling `googlechat-*.ts` preloads.

What a sandbox forces:

* Inbound — the OpenShell L7 protocol set has no gRPC, so the bundled
  StreamingPull cannot be inspected and raw relay would defeat the credential
  swap. Pull the same subscription over the Pub/Sub REST API instead.
* Outbound — the service-account key stays gateway-side, so the sandbox sends
  only the `openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN` placeholder. The
  bundled `httplib2` client cannot proxy HTTPS here; aiohttp replaces it.

How it attaches, through seams Hermes publishes rather than patches:

* `platform_registry.get()` resolves the bundled entry and forces the deferred
  loader, so registration order does not matter.
* `PlatformEntry` is a dataclass, so `dataclasses.replace` keeps every field and
  changes only `adapter_factory`, `check_fn` and `required_env`.
* `register()` documents last-writer-wins for exactly this case.

The delta is a subclass; everything else runs the bundled implementation.

Upstream coupling: `_validate_config`, `_load_sa_credentials` and
`_new_authed_http` are Hermes internals, because `PlatformEntry` carries no
credential or transport field. `image-build-probes.py googlechat-override-seams`
pins them, so drift fails the image build instead of silently falling back to
the stock gRPC and service-account adapter.
"""

import asyncio
import dataclasses
import importlib.util
import logging

_GC_REST_PLACEHOLDER_TOKEN = "openshell:resolve:env:GOOGLE_CHAT_ACCESS_TOKEN"
_GC_PULL_TIMEOUT = 95.0  # aiohttp cap > the Pub/Sub server long-poll hold (~90s)
_GC_LOG = logging.getLogger("gateway.platforms.google_chat")


class _RestPubsubMessage:
    """Present a REST ``receivedMessage`` as the four members
    ``_on_pubsub_message`` touches: ``.data``, ``.attributes``, ``.ack()``, ``.nack()``."""

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


def _gc_placeholder_credentials():
    """Credentials whose token is the placeholder the L7 proxy swaps.

    ``refresh()`` is a no-op: nothing is signed inside the sandbox.
    """
    from google.auth import credentials as ga_credentials

    class _PlaceholderCredentials(ga_credentials.Credentials):
        def __init__(self):
            super().__init__()
            self.token = _GC_REST_PLACEHOLDER_TOKEN

        def refresh(self, request):  # signed gateway-side; nothing to do here
            self.token = _GC_REST_PLACEHOLDER_TOKEN

    return _PlaceholderCredentials()


def _gc_gateway_proxy_url():
    """Return the egress proxy URL, or ``""`` for direct egress.

    Read from the gateway process's immutable ``/proc/<pid>/environ``, not
    ``os.environ``:

    * the gateway clears the proxy vars during an agent turn;
    * ``/proc/self`` is not the gateway — replies run in an ``asyncio.to_thread``
      worker whose environ never carried the launcher-set proxy.
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
    """``httplib2.Http``-shaped transport (``.request()`` only) built on aiohttp.

    googleapiclient calls only ``.request(uri, method, body, headers)`` and reads
    ``resp.status`` plus content, so an ``httplib2.Response`` satisfies it.

    Why httplib2 cannot be used here:

    * without PySocks, ``ProxyInfo.isgood()`` is falsy and it connects direct,
      which the proxy-only sandbox netns cannot resolve;
    * with PySocks, ``PROXY_TYPE_HTTP`` refuses the CONNECT tunnel.

    aiohttp CONNECT-tunnels exactly as the inbound pull does, from the one process
    the proxy authorizes and injects the minted token for.
    """

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
            """Report no subscription so the bundled ``connect()`` skips two steps:

            * its gRPC subscriber precheck, fatal under a REST-only egress policy;
            * its own supervisor, replaced here by ``_rest_pull``.

            Validation still runs upstream; the real subscription is kept for the pull.
            """
            project_id, subscription_path = super()._validate_config()
            self._sandbox_subscription = subscription_path
            return project_id, None

        def _load_sa_credentials(self):
            """Return the placeholder the L7 proxy swaps; nothing is signed here."""
            return _gc_placeholder_credentials()

        def _new_authed_http(self):
            """Route every Chat REST call through aiohttp instead of httplib2.

            Covers reply create, message patch, typing card and bot-id lookup.
            Credentials stay the placeholder the L7 proxy swaps.
            """
            import plugins.platforms.google_chat.adapter as _gc

            return _gc.AuthorizedHttp(self._credentials, http=_GcAiohttpTransport())

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            """Run the bundled connect(), then start the REST pull it skipped."""
            connected = await super().connect(is_reconnect=is_reconnect)
            if connected and self._sandbox_subscription:
                self._supervisor_task = asyncio.create_task(self._rest_pull())
                _GC_LOG.info(
                    "[GoogleChat][NemoClaw] keyless REST pull active (no gRPC subscriber)"
                )
            return connected

        async def _rest_pull(self):
            """Pull the subscription over the Pub/Sub REST unary API.

            Started by ``connect()`` in place of the bundled gRPC supervisor.
            Messages reach the unchanged ``_on_pubsub_message`` in a worker thread,
            keeping its off-the-event-loop contract.
            """
            import aiohttp

            sub = self._sandbox_subscription
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


    return SandboxGoogleChatAdapter


def install(ctx) -> None:
    """Replace the registered google_chat entry with the sandbox delta.

    ``ctx`` is unused: the platform registry is the single attachment point.
    """
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
