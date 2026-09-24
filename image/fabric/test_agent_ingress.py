# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import asyncio
import hashlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from agent_ingress import AgentIngress, GrantError, load_grant

TOKEN = "a" * 64


class Runtime:
    def __init__(self):
        self.name = "assistant"
        self.runtime_id = "runtime-generation"
        self.inference = {"agents": [{"name": "assistant"}]}
        self.process = SimpleNamespace(returncode=None)
        self.lock = asyncio.Lock()
        self.calls = []

    async def rpc(self, method, params, timeout=280):
        self.calls.append((method, params, timeout))
        return {
            "status": "ok",
            "result": {"payloads": [{"text": "hello from the agent"}]},
        }


def grant(*, client="127.0.0.1", expires=None):
    return {
        "version": 1,
        "deployment": "00000000-0000-4000-8000-000000000001",
        "generation": "b" * 32,
        "integration": "voice",
        "sandbox": "assistant",
        "agent": "assistant",
        "clientAddress": client,
        "credentialSha256": hashlib.sha256(TOKEN.encode()).hexdigest(),
        "expiresAt": expires or int(time.time()) + 300,
    }


class GrantTests(unittest.TestCase):
    def test_grant_is_owner_only_exact_and_generation_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "access.json"
            path.write_text(json.dumps(grant()))
            path.chmod(0o600)
            loaded = load_grant(path, "assistant", "127.0.0.1")
            self.assertEqual(loaded["generation"], "b" * 32)

            for mutate in (
                lambda value: value.update(agent="other"),
                lambda value: value.update(expiresAt=1),
                lambda value: value.update(clientAddress="127.0.0.2"),
                lambda value: value.update(extra="not-allowed"),
            ):
                value = grant()
                mutate(value)
                path.write_text(json.dumps(value))
                with self.assertRaises(GrantError):
                    load_grant(path, "assistant", "127.0.0.1")

            path.write_text(json.dumps(grant()))
            path.chmod(0o640)
            with self.assertRaises(GrantError):
                load_grant(path, "assistant", "127.0.0.1")

    def test_sandbox_identity_is_validated_without_conflating_it_with_the_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "access.json"
            path.write_text(json.dumps(grant()))
            path.chmod(0o600)

            loaded = load_grant(path, "assistant", "127.0.0.1")

            self.assertEqual(loaded["sandbox"], "assistant")
            value = grant()
            value["sandbox"] = "invalid sandbox"
            path.write_text(json.dumps(value))
            with self.assertRaises(GrantError):
                load_grant(path, "assistant", "127.0.0.1")

    def test_grant_open_does_not_require_access_to_the_filesystem_root(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "access.json"
            path.write_text(json.dumps(grant()))
            path.chmod(0o600)

            with mock.patch("agent_ingress.os.open", wraps=os.open) as opened:
                load_grant(path, "assistant", "127.0.0.1")

            self.assertNotEqual(opened.call_args_list[0].args[0], "/")


class IngressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name).resolve() / "access.json"
        self.path.write_text(json.dumps(grant()))
        self.path.chmod(0o600)
        self.runtime = Runtime()
        self.ingress = AgentIngress(self.runtime, grant_path=self.path, host="127.0.0.1", port=0)
        await self.ingress.start()
        self.addAsyncCleanup(self.ingress.stop)

    async def request(self, method, path, token, body=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.ingress.port)
        payload = b"" if body is None else json.dumps(body).encode()
        headers = [
            f"{method} {path} HTTP/1.1",
            "Host: 127.0.0.1",
            f"X-NemoClaw-Authorization: Bearer {token}",
            "Connection: close",
        ]
        if body is not None:
            headers.extend(["Content-Type: application/json", f"Content-Length: {len(payload)}"])
        writer.write(("\r\n".join(headers) + "\r\n\r\n").encode() + payload)
        await writer.drain()
        response = await reader.read()
        writer.close()
        await writer.wait_closed()
        head, _, data = response.partition(b"\r\n\r\n")
        status = int(head.split(b" ", 2)[1])
        return status, data

    async def test_health_reloads_grant_and_denies_wrong_expired_or_replaced_access(self):
        self.assertEqual((await self.request("GET", "/healthz", TOKEN))[0], 204)
        self.assertEqual((await self.request("GET", "/healthz", "wrong" * 16))[0], 401)

        self.path.write_text(json.dumps(grant(expires=1)))
        self.assertEqual((await self.request("GET", "/healthz", TOKEN))[0], 401)

        self.path.write_text(json.dumps(grant()))
        replaced = "c" * 64
        value = grant()
        value["credentialSha256"] = hashlib.sha256(replaced.encode()).hexdigest()
        self.path.write_text(json.dumps(value))
        self.assertEqual((await self.request("GET", "/healthz", TOKEN))[0], 401)
        self.assertEqual((await self.request("GET", "/healthz", replaced))[0], 204)

    async def test_one_session_dispatches_only_to_the_bound_agent(self):
        status, body = await self.request(
            "POST",
            "/v1/voice/sessions",
            TOKEN,
            {"runtimeConversationId": "conversation-one"},
        )
        self.assertEqual(status, 201)
        created = json.loads(body)
        session = created["voiceSessionId"]
        session_grant = created["grant"]

        status, body = await self.request(
            "POST",
            f"/v1/voice/sessions/{session}/turns",
            session_grant,
            {"commitId": "commit-one", "text": "hello"},
        )
        self.assertEqual(status, 200)
        events = [json.loads(line) for line in body.splitlines()]
        self.assertEqual(
            [event["type"] for event in events],
            ["response.started", "response.text.delta", "response.completed"],
        )
        self.assertEqual(events[1]["text"], "hello from the agent")
        self.assertEqual(len(self.runtime.calls), 1)
        method, params, _ = self.runtime.calls[0]
        self.assertEqual(method, "agent")
        self.assertEqual(params["agentId"], "assistant")
        self.assertNotIn("assistant", json.dumps(events))

        self.assertEqual(
            (
                await self.request(
                    "POST",
                    f"/v1/voice/sessions/{session}/turns",
                    session_grant,
                    {"commitId": "commit-two", "text": "again"},
                )
            )[0],
            409,
        )
        self.assertEqual(len(self.runtime.calls), 1)


if __name__ == "__main__":
    unittest.main()
