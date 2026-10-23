# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Offline checks against the HTTP libraries installed in the Hermes image."""

import asyncio
import gzip
import importlib.metadata
import ssl
import zlib

import brotlicffi
import httpcore2
import httpx2
from httpcore2._backends.mock import (
    AsyncMockBackend,
    AsyncMockStream,
    MockBackend,
    MockStream,
)
from mcp.client import streamable_http


class Body(httpx2.AsyncByteStream):
    def __init__(self, data):
        self.data = data
        self.closed = False

    async def __aiter__(self):
        yield self.data

    async def aclose(self):
        self.closed = True


async def check_decoding():
    payload = b"x" * (8 * 1024 * 1024)
    for encoding, compressed in (
        ("gzip", gzip.compress(payload)),
        ("deflate", zlib.compress(payload)),
        ("br", brotlicffi.compress(payload)),
    ):
        body = Body(compressed)
        response = httpx2.Response(200, headers={"content-encoding": encoding}, stream=body)
        total = 0
        async for chunk in response.aiter_bytes():
            assert len(chunk) <= 1024 * 1024, (encoding, len(chunk))
            assert chunk == b"x" * len(chunk)
            total += len(chunk)
        assert total == len(payload)
        assert body.closed
    body = Body(b"not a gzip stream")
    response = httpx2.Response(200, headers={"content-encoding": "gzip"}, stream=body)
    try:
        await response.aread()
    except httpx2.DecodingError:
        pass
    else:
        raise AssertionError("invalid compressed response was accepted")
    assert body.closed, "decoding failure leaked the response stream"


class TLSReached(Exception):
    pass


def verify_tls(context, hostname):
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname
    assert hostname == "example.test"
    raise TLSReached


class TLSStream(MockStream):
    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        verify_tls(ssl_context, server_hostname)


class AsyncTLSStream(AsyncMockStream):
    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        verify_tls(ssl_context, server_hostname)


SOCKS_REPLIES = [b"\x05\x00", b"\x05\x00\x00\x01\x7f\x00\x00\x01\x01\xbb"]


class Backend(MockBackend):
    def connect_tcp(self, *args, **kwargs):
        return TLSStream(list(SOCKS_REPLIES))


class AsyncBackend(AsyncMockBackend):
    async def connect_tcp(self, *args, **kwargs):
        return AsyncTLSStream(list(SOCKS_REPLIES))


async def check_socks_tls():
    for scheme in ("https", "wss"):
        with httpcore2.SOCKSProxy("socks5://proxy.test:1080", network_backend=Backend([])) as pool:
            try:
                pool.request("GET", f"{scheme}://example.test:443/")
            except TLSReached:
                pass
            else:
                raise AssertionError(f"{scheme} omitted TLS")
        async with httpcore2.AsyncSOCKSProxy(
            "socks5://proxy.test:1080", network_backend=AsyncBackend([])
        ) as pool:
            try:
                await pool.request("GET", f"{scheme}://example.test:443/")
            except TLSReached:
                pass
            else:
                raise AssertionError(f"async {scheme} omitted TLS")


async def main():
    for name in ("httpx2", "httpcore2"):
        assert importlib.metadata.version(name) == "2.12.0", name
    assert streamable_http.httpx2 is httpx2, "MCP loaded a different HTTP stack"
    await check_decoding()
    await check_socks_tls()
    print("Hermes HTTP security probes passed")


if __name__ == "__main__":
    asyncio.run(main())
