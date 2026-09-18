# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fabric adapter: Fabric owns one OpenClaw gateway and session.

Uses the pinned OpenClaw gateway RPC CLI, never the CLI's local-agent fallback.
No invocation retry or session recovery is attempted after an uncertain result.
"""

import asyncio
import fcntl
import json
import os
import re
import signal
import subprocess
import urllib.request
from pathlib import Path

from fabric import configured_agent, model_connection, openclaw_execution
from interfaces import dashboard, gateway_settings, token
from nemo_fabric_adapter_contract.models import AgentRunError, AgentRunResult, AgentRunStatus
from nemo_fabric_adapters.common import lifecycle
from openclaw_features import features_match, native_features, search_agents

ROOT = Path("/sandbox/.openclaw")
NODE = "/usr/local/bin/node"
CLI = "/app/openclaw.mjs"


def tool_disclosure(inference):
    agent = configured_agent("main", inference, match_name=False)
    tools = agent.get("tools")
    if tools == {"allow": ["read"]} or tools is None and "tools" not in agent:
        return "progressive"
    if (
        isinstance(tools, dict)
        and set(tools) == {"disclosure"}
        and tools["disclosure"] in ("progressive", "direct")
    ):
        return tools["disclosure"]
    raise ValueError("invalid agent tools")


def tool_search(inference):
    return (
        False
        if tool_disclosure(inference) == "direct"
        else {"mode": "tools", "searchDefaultLimit": 8, "maxSearchLimit": 20}
    )


def agent_entries(name, inference):
    agent = configured_agent(name, inference, match_name=False)
    if not (inference or {}).get("agents"):
        return {name: {}}
    tool_disclosure(inference)
    if (
        set(agent) - {"name", "tools", "inference"}
        or not isinstance(agent.get("name"), str)
        or not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", agent["name"])
    ):
        raise ValueError("invalid agent policy")
    entry = {
        "workspace": f"/sandbox/workspaces/{agent['name']}",
        **({"tools": {"allow": ["read"]}} if agent.get("tools") == {"allow": ["read"]} else {}),
    }
    if search_agents(inference) and "tools" not in entry:
        entry["tools"] = {"alsoAllow": ["web_search"]}
    return {agent["name"]: entry}


def native_provider(inference, execution):
    connection = model_connection(inference)
    settings = inference or {"api": "openai-completions", "tuning": {}}
    return {
        "baseUrl": connection["base_url"],
        "api": settings["api"],
        "timeoutSeconds": execution["timeoutSeconds"],
        "apiKey": (
            "${" + connection["api_key_env"] + "}" if connection["api_key_env"] else "unused"
        )
        if "connection" in settings
        else "openshell-placeholder",
        "models": [
            {
                "id": connection["model"],
                "name": connection["model"],
                "contextWindow": 32768,
                "maxTokens": 4096,
                "input": ["text"],
                "reasoning": False,
                **{
                    key: value
                    for key, value in settings["tuning"].items()
                    if key != "reasoningEffort"
                },
            }
        ],
    }


def native_configuration(name, inference=None):
    execution = openclaw_execution(inference)
    connection = model_connection(inference)
    config = {
        **native_features(inference),
        "gateway": gateway_settings(inference),
        "models": {
            "mode": "replace",
            "providers": {"openshell": native_provider(inference, execution)},
        },
        "agents": {
            "defaults": {
                "model": {"primary": "openshell/" + connection["model"]},
                "workspace": "/sandbox/workspace",
                "sandbox": {"mode": "off"},
                "timeoutSeconds": execution["timeoutSeconds"],
                **(
                    {"heartbeat": {"every": execution["heartbeatEvery"], "isolatedSession": True}}
                    if "heartbeatEvery" in execution
                    else {}
                ),
            },
            "entries": agent_entries(name, inference),
        },
        "memory": {"search": {"enabled": False}},
        "cron": {"enabled": False},
        "update": {"checkOnStart": False, "auto": {"enabled": False}},
        "tools": {
            "profile": "coding",
            "exec": {"host": "gateway", "mode": "full"},
            "toolSearch": tool_search(inference),
            **(
                {"web": {"search": {"enabled": True, "provider": "brave"}}}
                if search_agents(inference)
                else {}
            ),
        },
    }

    if inference is not None and "agents" in inference:
        # OpenClaw persists this marker for the declared agent at gateway startup.
        config["agents"]["ownership"] = "explicit"
    if inference is not None:
        effort = inference["tuning"].get("reasoningEffort", "default")
        if effort != "default":
            config["agents"]["defaults"]["thinkingDefault"] = effort
    agent = configured_agent(name, inference, match_name=False)
    if "inference" in agent:
        providers = {}
        selection = agent.get("inference")
        if (
            not isinstance(selection, dict)
            or set(selection) != {"default", "models"}
            or not isinstance(selection["models"], dict)
            or selection["default"] not in selection["models"]
        ):
            raise ValueError("invalid agent inference selection")
        entry = config["agents"]["entries"][agent["name"]]
        choices = {}
        for alias, settings in selection["models"].items():
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,39}", alias):
                raise ValueError("invalid model alias")
            key = f"nemoclaw_{agent['name']}_{alias}"
            provider = native_provider(settings, execution)
            providers[key] = provider
            ref = key + "/" + provider["models"][0]["id"]
            choices[ref] = {"alias": alias}
            if alias == selection["default"]:
                entry["model"] = {"primary": ref}
                effort = settings["tuning"].get("reasoningEffort", "default")
                if effort != "default":
                    entry["thinkingDefault"] = effort
        entry["models"] = choices
        entry["modelPolicy"] = {"allow": list(choices)}
        config["models"]["providers"] = providers
        defaults = config["agents"]["defaults"]
        defaults.pop("model", None)
        defaults.pop("thinkingDefault", None)
    return config


def contains(actual, required):
    if isinstance(required, dict):
        return isinstance(actual, dict) and all(
            k in actual and contains(actual[k], v) for k, v in required.items()
        )
    return actual == required


def owned_configuration(name, inference=None):
    config = {
        "tools": {"toolSearch": tool_search(inference)},
        "gateway": {"mode": "local", "bind": "loopback", "port": 18789},
        "models": {
            "providers": {
                "openshell": {
                    "baseUrl": "https://inference.local/v1",
                    "api": "openai-completions",
                    "timeoutSeconds": openclaw_execution(inference)["timeoutSeconds"],
                    "apiKey": "openshell-placeholder",
                }
            }
        },
        "agents": {
            "defaults": {
                "model": {"primary": "openshell/primary"},
                "workspace": "/sandbox/workspace",
            },
            "entries": {name: {}},
        },
    }

    if dashboard(inference) is not None:
        config["gateway"] = gateway_settings(inference)
    if inference is not None:
        native = native_configuration(name, inference)
        config["models"] = native["models"]
        if "agents" in inference:
            config["agents"] = native["agents"]
        else:
            config["agents"]["defaults"]["model"] = native["agents"]["defaults"]["model"]
        if "thinkingDefault" in native["agents"]["defaults"]:
            config["agents"]["defaults"]["thinkingDefault"] = native["agents"]["defaults"][
                "thinkingDefault"
            ]
    return config


def configuration_matches(name, inference=None):
    actual = json.loads((ROOT / "openclaw.json").read_text())
    if not features_match(actual, inference):
        return False
    expected = native_configuration(name, inference)["agents"]["defaults"]
    defaults = actual.get("agents", {}).get("defaults", {})
    if any(defaults.get(key) != expected.get(key) for key in ("timeoutSeconds", "heartbeat")):
        return False
    # Native settings outside deployment-owned gateway and agent settings remain native.
    if dashboard(inference) is not None and actual.get("gateway") != gateway_settings(inference):
        return False
    if inference is not None and "agents" in inference:
        native = native_configuration(name, inference)
        # Roster and tool settings are deployment-owned when explicitly declared.
        # Exact comparison rejects extra grants such as alsoAllow, not just missing fields.
        if actual.get("tools") != native["tools"] or actual.get("agents") != native["agents"]:
            return False
    return contains(actual, owned_configuration(name, inference))


def healthy(name, runtime_id, inference=None):
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", runtime_id):
        return False
    try:
        if not configuration_matches(name, inference):
            return False
        port = gateway_settings(inference)["port"]
        if dashboard(inference) is not None:
            env = dict(
                os.environ,
                NEMOCLAW_INTERFACE_TOKEN=token(ROOT),
                OPENCLAW_GATEWAY_TOKEN=token(ROOT),
                OPENCLAW_CONFIG_PATH=str(ROOT / "openclaw.json"),
                OPENCLAW_STATE_DIR=str(ROOT),
                OPENCLAW_HOME="/sandbox",
            )
            result = subprocess.run(
                [NODE, CLI, "gateway", "call", "health", "--json", "--timeout", "3000"],
                env=env,
                capture_output=True,
                timeout=8,
            )
            if result.returncode != 0:
                return False
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=3) as response:
            return response.status == 200
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        return False


def normalize_messages(messages):
    normalized = []
    for message in messages:
        role = message.get("role")
        content = message.get("content", [])
        blocks = content if isinstance(content, list) else []
        text = (
            content
            if isinstance(content, str)
            else "\n".join(
                b["text"]
                for b in blocks
                if b.get("type") == "text" and isinstance(b.get("text"), str)
            )
        )
        item = {"role": "tool" if role == "toolResult" else role, "content": text}
        if role == "assistant":
            item["tool_calls"] = [
                {
                    "id": b["id"],
                    "type": "function",
                    "function": {
                        "name": b["name"],
                        "arguments": json.dumps(b.get("arguments", {})),
                    },
                }
                for b in blocks
                if b.get("type") == "toolCall"
            ]
        if role == "toolResult":
            item["tool_call_id"] = message.get("toolCallId", "")
            item["is_error"] = message.get("isError", False)
        normalized.append(item)
    return normalized


class OpenClawRuntime:
    def __init__(self):
        self.inference = None
        self.process = None
        self.log = None
        self.runtime_id = None
        self.failed = False
        self.lock = asyncio.Lock()
        self.state_lock = None

    async def start(self, payload):
        config = payload["config"]
        self.runtime_id = payload["runtime_context"]["runtime_id"]
        self.name = config["harness"]["settings"]["agent_name"]
        self.inference = config["harness"]["settings"].get("inference")
        if not re.fullmatch(r"[a-z][a-z0-9-]*", self.name) or not re.fullmatch(
            r"[a-zA-Z0-9_-]+", self.runtime_id
        ):
            raise ValueError("invalid OpenClaw runtime identity")
        model = config["models"]["default"]
        if model != model_connection(self.inference):
            raise ValueError("OpenClaw model differs from its configured inference connection")
        self.home = ROOT
        self.home.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.state_lock = open(self.home / "adapter.lock", "a")
        try:
            fcntl.flock(self.state_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.state_lock.close()
            self.state_lock = None
            raise RuntimeError("retained channel state is already in use") from None
        self.initialize_configuration()
        self.env = dict(
            os.environ,
            OPENCLAW_HOME="/sandbox",
            OPENCLAW_STATE_DIR=str(self.home),
            OPENCLAW_CONFIG_PATH=str(self.home / "openclaw.json"),
        )
        if dashboard(self.inference) is not None:
            self.env["NEMOCLAW_INTERFACE_TOKEN"] = token(self.home)
            self.env["OPENCLAW_GATEWAY_TOKEN"] = self.env["NEMOCLAW_INTERFACE_TOKEN"]
        self.session_key = f"agent:{self.name}:fabric-{self.runtime_id}"
        await self.start_gateway()

    def initialize_configuration(self):
        path = self.home / "openclaw.json"
        if dashboard(self.inference) is not None:
            token(self.home, create=not path.exists())
        if path.exists():
            if not configuration_matches(self.name, self.inference):
                raise RuntimeError("native configuration conflicts with deployment-owned settings")
            return
        temporary = path.with_suffix(".tmp")
        with open(temporary, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
            json.dump(native_configuration(self.name, self.inference), output)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)

    async def start_gateway(self):
        self.log = (self.home / "gateway.log").open("ab")
        self.process = await asyncio.create_subprocess_exec(
            NODE,
            CLI,
            "gateway",
            env=self.env,
            cwd="/sandbox",
            stdout=self.log,
            stderr=self.log,
            start_new_session=True,
        )
        deadline = asyncio.get_running_loop().time() + 75
        while asyncio.get_running_loop().time() < deadline:
            if self.process.returncode is not None:
                await self.stop_gateway()
                raise RuntimeError("OpenClaw gateway exited during startup; inspect gateway.log")
            if await asyncio.to_thread(healthy, self.name, self.runtime_id, self.inference):
                return
            await asyncio.sleep(0.05)
        await self.stop_gateway()
        raise RuntimeError("OpenClaw gateway did not become healthy")

    async def rpc(self, method, params, timeout=280):
        process = await asyncio.create_subprocess_exec(
            NODE,
            CLI,
            "gateway",
            "call",
            method,
            "--params",
            json.dumps(params),
            "--expect-final",
            "--json",
            "--timeout",
            str(timeout * 1000),
            env=self.env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout + 5)
        except BaseException:
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
            raise
        if process.returncode:
            raise RuntimeError(
                f"OpenClaw RPC {method} failed: {stderr.decode(errors='replace')[-2000:]}"
            )
        return json.loads(stdout)

    async def invoke(self, request, context):
        async with self.lock:
            return await self._invoke(request, context)

    async def _invoke(self, request, context):
        if (
            self.failed
            or context.runtime_id != self.runtime_id
            or self.process.returncode is not None
        ):
            raise lifecycle.LifecycleError(
                "openclaw_runtime_unavailable", "OpenClaw runtime is unavailable; no replay"
            )
        entries = agent_entries(self.name, self.inference)
        name = next(iter(entries))
        message = request.input
        if isinstance(message, dict) and set(message) == {"agent", "message"}:
            name, message = message["agent"], message["message"]
        if not isinstance(message, str) or not isinstance(name, str) or name not in entries:
            raise ValueError("expected text or a declared agent and text message")
        if not configuration_matches(self.name, self.inference):
            raise lifecycle.LifecycleError(
                "openclaw_configuration_drift", "deployment-owned configuration drifted"
            )
        session_key = f"agent:{name}:fabric-{self.runtime_id}"
        try:
            seconds = openclaw_execution(self.inference)["timeoutSeconds"]
            result = await self.rpc(
                "agent",
                {
                    "agentId": name,
                    "sessionKey": session_key,
                    "message": message,
                    "idempotencyKey": context.invocation_id,
                    "deliver": False,
                    "timeout": seconds,
                },
                timeout=seconds + 20,
            )
            if result.get("status") != "ok":
                raise RuntimeError("OpenClaw returned a non-successful terminal result")
            native = result.get("result", {})
            if (
                native.get("meta", {}).get("aborted")
                or native.get("meta", {}).get("error")
                or any(p.get("isError") for p in native.get("payloads", []))
            ):
                raise RuntimeError("OpenClaw agent turn aborted or failed")
            response = "\n".join(
                p["text"] for p in native.get("payloads", []) if isinstance(p.get("text"), str)
            )
            history = await self.rpc(
                "chat.history", {"sessionKey": session_key, "limit": 200}, timeout=15
            )
            return AgentRunResult(
                status=AgentRunStatus.SUCCEEDED,
                output={
                    "harness": "openclaw",
                    "response": response,
                    "session_key": session_key,
                    "gateway_pid": self.process.pid,
                    "messages": normalize_messages(history.get("messages", [])),
                    "native_result": result,
                },
            )
        except BaseException as error:
            # An RPC failure can leave the gateway still working on the turn.
            # Quarantine and stop it, rather than accepting overlapping requests.
            self.failed = True
            await self.stop()
            if not isinstance(error, Exception):
                raise
            return AgentRunResult(
                status=AgentRunStatus.FAILED,
                output={"harness": "openclaw", "session_key": session_key},
                error=AgentRunError(code="openclaw_invocation_failed", message=str(error)),
            )

    async def stop(self):
        await self.stop_gateway()
        if self.state_lock is not None:
            self.state_lock.close()
            self.state_lock = None

    async def stop_gateway(self):
        if self.process is not None and self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                await asyncio.wait_for(self.process.wait(), 10)
            except TimeoutError:
                os.killpg(self.process.pid, signal.SIGKILL)
                await self.process.wait()
            except ProcessLookupError:
                await self.process.wait()
        if self.log is not None:
            self.log.close()


if __name__ == "__main__":
    lifecycle.serve(OpenClawRuntime)
