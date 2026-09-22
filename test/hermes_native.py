# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Offline contract against pinned Hermes, run inside the owned fixture image."""

import asyncio
import json
import secrets
import socket
import urllib.error
import urllib.request

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter


def request(port, key=None):
    headers = {"Authorization": "Bearer " + key} if key else {}
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/models", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


async def main():
    key = secrets.token_hex(32)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    adapter = APIServerAdapter(
        PlatformConfig(
            enabled=True,
            extra={
                "host": "127.0.0.1",
                "port": port,
                "key": key,
                "model_name": "primary",
            },
        )
    )
    try:
        assert await adapter.connect(), "native API server did not start"
        assert (await asyncio.to_thread(request, port))[0] == 401
        assert (await asyncio.to_thread(request, port, secrets.token_hex(32)))[0] == 401
        status, models = await asyncio.to_thread(request, port, key)
        assert status == 200 and models["data"][0]["id"] == "primary"
    finally:
        await adapter.disconnect()
    try:
        await asyncio.to_thread(request, port, key)
    except urllib.error.URLError:
        pass
    else:
        raise AssertionError("native API listener survived disconnect")
    print("native Hermes: authenticated models and owned shutdown passed; no inference")


if __name__ == "__main__":
    asyncio.run(main())
