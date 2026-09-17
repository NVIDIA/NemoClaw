# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fabric import client, configuration, configurations, hosted_runtimes


class HostedAgents(unittest.IsolatedAsyncioTestCase):
    def test_agents_select_their_own_model_workspace_and_tools(self):
        def agent(name, model):
            return {
                "name": name,
                "inference": {
                    "default": "primary",
                    "models": {
                        "primary": {
                            "connection": {
                                "provider": "openai",
                                "model": model,
                                "base_url": "http://127.0.0.1:8000/v1",
                                "api_key_env": "NEMOCLAW_ANONYMOUS_API_KEY",
                            },
                            "api": "openai-completions",
                            "tuning": {},
                        }
                    },
                },
            }

        inference = {
            "api": "openai-completions",
            "agents": [agent("alice", "smart"), agent("bob", "fast")],
        }
        inference["agents"][1]["tools"] = {"allow": ["read"]}
        alice = configuration("alice", "deepagents", inference=inference)
        bob = configuration("bob", "deepagents", inference=inference)
        self.assertEqual(alice["models"]["default"]["model"], "smart")
        self.assertEqual(bob["models"]["default"]["model"], "fast")
        self.assertNotEqual(alice["environment"]["workspace"], bob["environment"]["workspace"])
        self.assertNotEqual(alice["runtime"]["artifacts"], bob["runtime"]["artifacts"])
        self.assertNotIn("tools", alice)
        self.assertEqual(bob["tools"], {"enabled": ["read_file"]})

    async def test_failed_start_stops_previously_started_runtimes(self):
        first = SimpleNamespace(stop=AsyncMock())
        start = AsyncMock(side_effect=[first, RuntimeError("second failed")])
        with self.assertRaisesRegex(RuntimeError, "second failed"):
            async with hosted_runtimes({"alice": {}, "bob": {}}, start):
                self.fail("partial startup must not serve readiness")
        first.stop.assert_awaited_once()

    async def test_shutdown_attempts_every_runtime_even_after_a_stop_failure(self):
        first = SimpleNamespace(stop=AsyncMock())
        second = SimpleNamespace(stop=AsyncMock(side_effect=RuntimeError("stop failed")))
        with self.assertRaisesRegex(RuntimeError, "stop failed"):
            async with hosted_runtimes(
                {"alice": {}, "bob": {}}, AsyncMock(side_effect=[first, second])
            ) as runtimes:
                self.assertEqual(set(runtimes), {"alice", "bob"})
        first.stop.assert_awaited_once()
        second.stop.assert_awaited_once()

    async def test_readiness_rejects_drift_in_a_secondary_agent(self):
        inference = {"api": "openai-completions", "agents": [{"name": "alice"}, {"name": "bob"}]}
        configs = configurations("alice", "deepagents", inference)
        result = {
            "config": configs["alice"],
            "runtime_id": "owned",
            "ready": True,
            "agents": configs,
            "inference": inference,
        }
        writer = SimpleNamespace(
            write=Mock(), drain=AsyncMock(), close=Mock(), wait_closed=AsyncMock()
        )
        for drift in (False, True):
            observed = copy.deepcopy(result)
            if drift:
                observed["agents"]["bob"]["environment"]["workspace"] = "/wrong"
            reader = SimpleNamespace(readline=AsyncMock(return_value=json.dumps(observed).encode()))
            with patch(
                "fabric.asyncio.open_unix_connection", AsyncMock(return_value=(reader, writer))
            ):
                self.assertEqual(
                    await client("check", "alice", inference=inference), 2 if drift else 0
                )
