#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
HTTP proxy for OpenShell placeholder rewriting.

Python HTTP clients (httpx) URL-encode colons in URL paths, turning
openshell:resolve:env:TOKEN into openshell%3Aresolve%3Aenv%3ATOKEN.
OpenShell's L7 proxy doesn't recognize the encoded form.

This proxy sits between the Python process and the OpenShell proxy,
URL-decodes the CONNECT target and request paths so the placeholders
are restored before reaching the L7 proxy. It also translates Slack's
SDK-compatible xoxb-/xapp- placeholders in cleartext HTTP proxy requests
back to canonical openshell:resolve:env:SLACK_* placeholders before
OpenShell sees them. Hermes' Python preload handles Slack HTTPS requests
before TLS serialization.

This is intentionally not a WebSocket frame rewriter. After the initial
HTTP proxy request is forwarded, bytes are relayed unchanged; Discord
gateway IDENTIFY payloads are not inspected or modified here.

Usage: Launched by start.sh, listens on 127.0.0.1:3129.
       HTTPS_PROXY=http://127.0.0.1:3129 hermes gateway run
"""

import asyncio
import re
import sys
from urllib.parse import unquote


UPSTREAM_HOST = "10.200.0.1"
UPSTREAM_PORT = 3128
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 3129
SLACK_PLACEHOLDER = re.compile(
    r"\b(?:"
    r"xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"
    r"|"
    r"xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN"
    r")\b"
)
SLACK_FAST_PATH = b"OPENSHELL-RESOLVE-ENV-SLACK_"


def rewrite_slack_placeholders(text):
    """Translate Slack SDK-shaped placeholders to OpenShell canonical form."""

    def _replacement(match):
        placeholder = match.group(0)
        if placeholder.startswith("xoxb-"):
            return "openshell:resolve:env:SLACK_BOT_TOKEN"
        return "openshell:resolve:env:SLACK_APP_TOKEN"

    return SLACK_PLACEHOLDER.sub(_replacement, text)


def rewrite_slack_placeholders_bytes(data):
    """Rewrite UTF-8 header/body bytes when they contain Slack placeholders."""
    if SLACK_FAST_PATH not in data:
        return data
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return data
    rewritten = rewrite_slack_placeholders(text)
    if rewritten == text:
        return data
    return rewritten.encode("utf-8")


def _line_ending(line):
    return "\r\n" if line.endswith(b"\r\n") else "\n"


def _rewrite_request_line(first_line):
    ending = _line_ending(first_line)
    parts = first_line.decode("utf-8", errors="replace").rstrip("\r\n").split(" ", 2)
    if len(parts) == 3:
        parts[1] = rewrite_slack_placeholders(unquote(parts[1]))
    return (" ".join(parts) + ending).encode("utf-8")


def _content_length(header_lines):
    for line in header_lines:
        text = line.decode("iso-8859-1", errors="replace")
        if text.lower().startswith("content-length:"):
            try:
                return int(text.split(":", 1)[1].strip())
            except ValueError:
                return None
    return None


def _with_content_length(header_lines, content_length):
    rewritten = []
    replaced = False
    for line in header_lines:
        text = line.decode("iso-8859-1", errors="replace")
        if text.lower().startswith("content-length:"):
            name = text.split(":", 1)[0]
            ending = _line_ending(line)
            rewritten.append(f"{name}: {content_length}{ending}".encode("ascii"))
            replaced = True
        else:
            rewritten.append(line)
    return rewritten if replaced else header_lines


async def handle_client(reader, writer):
    """Proxy a single connection, rewriting placeholders before OpenShell."""
    up_writer = None
    try:
        first_line = await asyncio.wait_for(reader.readline(), timeout=10)
        if not first_line:
            writer.close()
            return

        # Decode only the request target (second token) so valid percent-encoding
        # like %2F or %3F in the method/version is preserved.
        decoded_line = _rewrite_request_line(first_line)

        # Read and rewrite remaining headers.
        header_lines = []
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            if line == b"\r\n" or line == b"\n" or not line:
                header_end = line or b"\r\n"
                break
            header_lines.append(rewrite_slack_placeholders_bytes(line))

        body = b""
        body_length = _content_length(header_lines)
        if body_length:
            body = await asyncio.wait_for(reader.readexactly(body_length), timeout=10)
            body = rewrite_slack_placeholders_bytes(body)
            header_lines = _with_content_length(header_lines, len(body))

        request = bytearray(decoded_line)
        for line in header_lines:
            request.extend(line)
        request.extend(header_end)
        if body:
            request.extend(body)

        # Connect to upstream proxy
        up_reader, up_writer = await asyncio.open_connection(
            UPSTREAM_HOST, UPSTREAM_PORT
        )
        up_writer.write(bytes(request))
        await up_writer.drain()

        # Bidirectional relay
        await asyncio.gather(
            _relay(reader, up_writer),
            _relay(up_reader, writer),
        )
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        for w in (up_writer, writer):
            if w is not None:
                try:
                    w.close()
                    await w.wait_closed()
                except (ConnectionError, OSError):
                    pass


async def _relay(src, dst):
    """Copy data from src to dst until EOF."""
    try:
        while True:
            data = await src.read(65536)
            if not data:
                break
            dst.write(data)
            await dst.drain()
    except (ConnectionError, OSError):
        pass


async def main():
    server = await asyncio.start_server(handle_client, LISTEN_HOST, LISTEN_PORT)
    print(
        f"[decode-proxy] Listening on {LISTEN_HOST}:{LISTEN_PORT} -> {UPSTREAM_HOST}:{UPSTREAM_PORT}",
        file=sys.stderr,
    )
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
