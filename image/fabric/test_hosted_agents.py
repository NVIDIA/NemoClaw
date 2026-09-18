# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import copy
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fabric import client, configuration, hosted_runtime


class HostedAgents(unittest.IsolatedAsyncioTestCase):
    def test_every_harness_rejects_multiple_declared_agents(self):
        inference = {"api": "openai-completions", "agents": [{"name": "alice"}, {"name": "bob"}]}
        for harness in (
            "deepagents",
            "openclaw",
            "pi",
            "hermes",
            "claude",
            "codex",
            "mini-swe-agent",
            "nooa",
            "nooa-bench",
            "remote-agent",
        ):
            with (
                self.subTest(harness=harness),
                self.assertRaisesRegex(ValueError, "exactly one agent"),
            ):
                configuration("alice", harness, model={"model": "primary"}, inference=inference)

    def test_openclaw_preserves_sandbox_runtime_and_native_agent_identities(self):
        inference = {"api": "openai-completions", "agents": [{"name": "alice"}]}
        config = configuration("sandbox-name", "openclaw", inference=inference)
        self.assertEqual(config["metadata"]["name"], "sandbox-name")
        settings = config["harness"]["settings"]
        self.assertEqual(settings["agent_name"], "sandbox-name")
        self.assertEqual(settings["inference"]["agents"], [{"name": "alice"}])

    def test_omitted_or_empty_wire_agents_use_the_implicit_agent(self):
        for agents in ({}, {"agents": []}):
            config = configuration("alice", inference={"api": "openai-completions", **agents})
            self.assertEqual(config["metadata"]["name"], "alice")

    def test_agent_selects_its_model_workspace_and_tools(self):
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

        inference = {"api": "openai-completions", "agents": [agent("alice", "smart")]}
        inference["agents"][0]["tools"] = {"allow": ["read"]}
        config = configuration("alice", "deepagents", inference=inference)
        self.assertEqual(config["models"]["default"]["model"], "smart")
        self.assertEqual(config["metadata"]["name"], "alice")
        self.assertEqual(config["environment"]["workspace"], "/sandbox/workspace")
        self.assertEqual(config["runtime"]["artifacts"], "/sandbox/artifacts")
        self.assertEqual(config["tools"], {"enabled": ["read_file"]})
        with self.assertRaisesRegex(ValueError, "declared agent"):
            configuration("sandbox-name", "deepagents", inference=inference)

    async def test_shutdown_stops_the_only_runtime_after_server_failure(self):
        runtime = SimpleNamespace(stop=AsyncMock())
        start = AsyncMock(return_value=runtime)
        with self.assertRaisesRegex(RuntimeError, "server failed"):
            async with hosted_runtime({"metadata": {"name": "alice"}}, start) as hosted:
                self.assertIs(hosted, runtime)
                raise RuntimeError("server failed")
        start.assert_awaited_once()
        runtime.stop.assert_awaited_once()

    async def test_readiness_rejects_drift_in_the_agent(self):
        inference = {"api": "openai-completions", "agents": [{"name": "alice"}]}
        config = configuration("alice", "deepagents", inference=inference)
        result = {
            "config": config,
            "runtime_id": "owned",
            "ready": True,
            "inference": inference,
        }
        writer = SimpleNamespace(
            write=Mock(), drain=AsyncMock(), close=Mock(), wait_closed=AsyncMock()
        )
        for drift in (False, True):
            observed = copy.deepcopy(result)
            if drift:
                observed["config"]["environment"]["workspace"] = "/wrong"
            reader = SimpleNamespace(readline=AsyncMock(return_value=json.dumps(observed).encode()))
            with patch(
                "fabric.asyncio.open_unix_connection", AsyncMock(return_value=(reader, writer))
            ):
                self.assertEqual(
                    await client("check", "alice", inference=inference), 2 if drift else 0
                )
