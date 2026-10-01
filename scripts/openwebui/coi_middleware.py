# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Cross-origin isolation for the in-browser CheerpX/WebVM terminal.
#
# CheerpX moves SharedArrayBuffer buffers into its worker. That transfer is only
# permitted when the document is cross-origin isolated, which in turn requires
# BOTH of:
#
#   Cross-Origin-Opener-Policy:   same-origin
#   Cross-Origin-Embedder-Policy: require-corp
#
# Without them the browser refuses the transfer and the pod dies with
# "SharedArrayBuffer transfer requires self.crossOriginIsolated" — the VM
# never boots and the terminal silently falls back to a mock pod.
#
# require-corp additionally demands that every subresource opt in, so
# Cross-Origin-Resource-Policy is sent too. It is deliberately permissive: this
# app only loads its own vendor bundle, and a blanket header is far less
# brittle than path-matching every asset the terminal may pull in.
#
# The headers are set (not appended) so a response that already carries them
# from a downstream handler does not end up with duplicate header values, which
# browsers reject.


class COIMiddleware:
    """Pure-ASGI. Adds COOP/COEP/CORP so `self.crossOriginIsolated` is true."""

    # Set once at import; these are constant byte strings.
    _HEADERS = (
        (b"cross-origin-opener-policy", b"same-origin"),
        (b"cross-origin-embedder-policy", b"require-corp"),
        (b"cross-origin-resource-policy", b"cross-origin"),
    )

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name not in {n for n, _ in self._HEADERS}
                ]
                headers.extend(self._HEADERS)
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)
