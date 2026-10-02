# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Host inference preflight for the accepted Kubernetes development fixture.

The explicit local test permits one model request under docs/design/scope.md.
This check uses the managed sample's fixed public route and never changes the
credential installed in a retained deployment.
"""

import contextlib
import json
import queue
import socket
import ssl
import threading
import urllib.error
import urllib.request

ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions"
MODEL = "nvidia/nemotron-3-ultra-550b-a55b"
TIMEOUT_SECONDS = 80
MAX_RESPONSE_BYTES = 64 * 1024


class InferenceCheckError(Exception):
    """A fixed diagnostic safe for console output; contains no upstream data."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A changed origin or path must never receive this credential.
        return None


def _request(key):
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Reply OK."}],
        "max_tokens": 16,
        "stream": False,
    }
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    opener = urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context())
    )
    with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise InferenceCheckError("Inference Hub response exceeded the size limit.")
    try:
        result = json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        raise InferenceCheckError("Inference Hub returned invalid JSON.") from None
    choices = result.get("choices") if isinstance(result, dict) else None
    if not isinstance(choices, list) or not choices:
        raise InferenceCheckError("Inference Hub returned no inference choices.")


def _diagnostic(error):
    if isinstance(error, InferenceCheckError):
        return str(error)
    if isinstance(error, urllib.error.HTTPError):
        # Do not read an upstream error body or include its headers or reason.
        with contextlib.suppress(Exception):
            error.close()
        if 300 <= error.code < 400:
            return "Inference Hub returned a redirect; forwarding credentials was refused."
        return {
            400: "Inference Hub rejected the model request (HTTP 400).",
            401: (
                "Inference Hub rejected authentication (HTTP 401); "
                "the key may be invalid, expired, or revoked."
            ),
            403: "Inference Hub refused access to the configured model (HTTP 403).",
            404: "Inference Hub did not find the configured route or model (HTTP 404).",
            408: "Inference Hub request timed out (HTTP 408).",
            429: "Inference Hub rate or quota limit reached (HTTP 429).",
            500: "Inference Hub returned a server error (HTTP 500).",
            502: "Inference Hub returned a gateway error (HTTP 502).",
            503: "Inference Hub is unavailable (HTTP 503).",
            504: "Inference Hub request timed out at its gateway (HTTP 504).",
        }.get(error.code, "Inference Hub returned an unexpected HTTP status.")
    cause = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(cause, TimeoutError):
        return "Inference Hub request timed out."
    if isinstance(cause, ssl.SSLError):
        return "Inference Hub TLS verification or handshake failed."
    if isinstance(cause, socket.gaierror):
        return "Inference Hub DNS lookup failed."
    if isinstance(cause, OSError) or isinstance(error, urllib.error.URLError):
        return "Inference Hub network request failed."
    return "Inference Hub request failed."


def check_inference(key: str) -> None:
    """Make one bounded request; print nothing and expose only fixed diagnostics."""
    if not key or any(char.isspace() for char in key):
        raise InferenceCheckError("Set NVIDIA_INFERENCE_API_KEY to your inference API key.")
    completed = queue.Queue(maxsize=1)

    def run():
        try:
            _request(key)
        except Exception as error:
            completed.put(_diagnostic(error))
        else:
            completed.put(None)

    # Socket timeouts do not bound DNS or a slowly arriving response. Bound the
    # caller as well. The caller must stop on failure; the worker cannot block
    # process exit, retry the request, print output, or continue deployment.
    threading.Thread(target=run, daemon=True).start()
    try:
        message = completed.get(timeout=TIMEOUT_SECONDS)
    except queue.Empty:
        raise InferenceCheckError("Inference Hub request timed out.") from None
    if message is not None:
        raise InferenceCheckError(message) from None
