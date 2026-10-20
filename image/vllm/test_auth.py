# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Offline native vLLM authentication checks; no model or GPU is started."""
import asyncio
import os
import secrets
import unittest

from vllm import envs
from vllm.entrypoints.serve.utils.server_utils import AuthenticationMiddleware


class NativeAuthenticationTest(unittest.TestCase):
    def test_environment_key_guards_inference_paths(self):
        key = secrets.token_hex(32)
        previous = os.environ.get("VLLM_API_KEY")
        os.environ["VLLM_API_KEY"] = key
        try:
            self.assertEqual(envs.VLLM_API_KEY, key)

            async def application(scope, receive, send):
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b""})

            middleware = AuthenticationMiddleware(application, [envs.VLLM_API_KEY])

            async def request(path, token):
                statuses = []

                async def send(message):
                    if message["type"] == "http.response.start":
                        statuses.append(message["status"])

                async def receive():
                    return {"type": "http.request", "body": b"", "more_body": False}

                headers = [] if token is None else [(b"authorization", f"Bearer {token}".encode())]
                await middleware({"type": "http", "method": "POST", "path": path, "headers": headers}, receive, send)
                return statuses

            for path in ["/v1/models", "/v1/chat/completions", "/v1/completions"]:
                self.assertEqual(asyncio.run(request(path, None)), [401])
                self.assertEqual(asyncio.run(request(path, "wrong")), [401])
                self.assertEqual(asyncio.run(request(path, key)), [200])
            # Native /health does not establish that a bearer key is accepted.
            self.assertEqual(asyncio.run(request("/health", None)), [200])
        finally:
            if previous is None:
                os.environ.pop("VLLM_API_KEY", None)
            else:
                os.environ["VLLM_API_KEY"] = previous


if __name__ == "__main__":
    unittest.main()
