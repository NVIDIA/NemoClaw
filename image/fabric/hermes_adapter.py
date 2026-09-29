# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fabric owns a native Hermes API process; dashboard sessions remain separate."""

import asyncio
import fcntl
import json
import os
import re
import signal
import sys
import urllib.request
from pathlib import Path

from fabric import (
    hermes_model_connection,
    hermes_relay_enabled,
    hermes_switchyard_enabled,
    model_connection,
    model_credential,
)
from interfaces import token

ROOT = Path("/sandbox/.hermes")
PORT = 8642
MODES = {
    "openai-completions": "chat_completions",
    "openai-responses": "codex_responses",
    "anthropic-messages": "anthropic_messages",
}
SWITCHYARD_MANIFEST = Path("/opt/nemoclaw/switchyard-plugin/relay-plugin.toml")
SWITCHYARD_TIMEOUT_MS = 300_000


def switchyard_plugin_configuration(deployment_path):
    return {
        "version": 1,
        "plugins": {
            "policy": {
                "overrides": {
                    "nvidia.switchyard": {
                        "startup": "required",
                        "attestation": "integrity_only",
                    }
                }
            },
            "dynamic": [
                {
                    "manifest": str(SWITCHYARD_MANIFEST),
                    "config": {
                        "priority": 0,
                        "switchyard_config_path": str(deployment_path),
                    },
                }
            ],
        },
    }


def switchyard_deployment(inference):
    if not hermes_switchyard_enabled(inference):
        raise ValueError("Hermes Switchyard routing is not configured")
    agents = inference.get("agents")
    if not isinstance(agents, list) or len(agents) != 1:
        raise ValueError("Switchyard routing requires one Hermes agent")
    selection = agents[0].get("inference")
    if not isinstance(selection, dict) or set(selection) != {"default", "models"}:
        raise ValueError("Switchyard routing requires named model choices")
    models = selection["models"]
    routing = inference["routing"]
    algorithm = routing["algorithm"]
    kind = algorithm.get("kind")
    if kind == "llm-classifier" and set(algorithm) == {
        "kind",
        "classifierRoute",
        "weakRoute",
        "strongRoute",
        "baseThreshold",
        "thresholdStep",
    }:
        route_names = [
            algorithm["classifierRoute"],
            algorithm["weakRoute"],
            algorithm["strongRoute"],
        ]
        route = {
            "id": f"switchyard/{routing['routeId']}",
            "type": "llm_classifier",
            "mode": "capability",
            "classifier_target": route_names[0],
            "weak_target": route_names[1],
            "strong_target": route_names[2],
            "base_threshold": algorithm["baseThreshold"],
            "threshold_step": algorithm["thresholdStep"],
        }
    elif kind == "weighted-random" and set(algorithm) == {"kind", "seed", "targets"}:
        targets = algorithm["targets"]
        if not isinstance(targets, list) or any(not isinstance(target, dict) for target in targets):
            raise ValueError("invalid Switchyard weighted targets")
        route_names = [target.get("routeRef") for target in targets]
        route = {
            "id": f"switchyard/{routing['routeId']}",
            "type": "random",
            "targets": route_names,
            "weights": [target.get("weight") for target in targets],
            "seed": algorithm["seed"],
        }
    else:
        raise ValueError("unsupported Switchyard routing algorithm")
    if (
        len(route_names) != len(set(route_names))
        or not route_names
        or any(name not in models for name in route_names)
    ):
        raise ValueError("invalid Switchyard route references")
    clients = {}
    targets = {}
    providers = set()
    for name in route_names:
        model = models[name]
        connection = model_connection(model)
        provider = model.get("provider")
        if not isinstance(provider, str) or not provider or provider in providers:
            raise ValueError("Switchyard roles require distinct OpenShell providers")
        providers.add(provider)
        api_key_env = connection["api_key_env"]
        if not api_key_env or api_key_env == "NEMOCLAW_ANONYMOUS_API_KEY":
            raise ValueError("Switchyard providers require attached credentials")
        try:
            wire_format = {
                "openai-completions": "openai_chat",
                "openai-responses": "openai_responses",
                "anthropic-messages": "anthropic_messages",
            }[model["api"]]
        except (KeyError, TypeError) as error:
            raise ValueError("unsupported Switchyard provider API") from error
        clients[name] = {
            "format": wire_format,
            "base_url": connection["base_url"],
            "api_key_env": api_key_env,
            "max_retries": 0,
            "timeout_ms": SWITCHYARD_TIMEOUT_MS,
        }
        targets[name] = {"id": connection["model"], "llm_client": name}
    return {
        "schema_version": 1,
        "llm_clients": clients,
        "targets": targets,
        "routes": {routing["routeId"]: route},
    }


def _write_owned_toml(path, value):
    import tomllib

    import tomli_w

    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.exists():
        with path.open("rb") as source:
            if tomllib.load(source) != value:
                raise RuntimeError(
                    "Switchyard runtime configuration conflicts with deployment intent"
                )
        return
    with open(path, "xb", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        tomli_w.dump(value, output)
        output.flush()
        os.fsync(output.fileno())


def write_switchyard_plugin_config(inference, relay_plugins_path, home=None):
    import tomllib

    home = home or ROOT
    directory = home / "nemoclaw-switchyard"
    deployment_path = directory / "switchyard.toml"
    plugins_path = directory / "plugins.toml"
    with Path(relay_plugins_path).open("rb") as source:
        plugins = tomllib.load(source)
    if "plugins" in plugins:
        raise RuntimeError("Relay plugin configuration already declares dynamic plugins")
    _write_owned_toml(deployment_path, switchyard_deployment(inference))
    plugins.update(switchyard_plugin_configuration(deployment_path))
    _write_owned_toml(plugins_path, plugins)
    return plugins_path


def require_switchyard_relay(required):
    if not required:
        return
    from agent.relay_runtime import get_runtime

    runtime = get_runtime()
    if runtime is None or not runtime.managed_execution_enabled():
        raise RuntimeError("required Switchyard Relay plugin is not active")


def interface_settings(inference):
    interfaces = (inference or {}).get("interfaces", {})
    dashboard = interfaces.get("dashboard", {"enabled": True})
    return {
        "apiPort": interfaces.get("api", {}).get("port", 8642),
        "dashboard": {
            "enabled": dashboard["enabled"],
            "port": dashboard.get("port", 18789),
            "internalPort": dashboard.get("internalPort", 19119),
            "tui": dashboard.get("tui", {"enabled": True}),
        },
    }


def native_configuration(inference):
    api = (inference or {}).get("api", "openai-completions")
    connection = hermes_model_connection(inference)
    return {
        "model": {
            "default": connection["model"],
            "provider": "custom:openshell",
            "base_url": connection["base_url"],
            "api_mode": MODES[api],
        },
        "custom_providers": [
            {
                "name": "openshell",
                "base_url": connection["base_url"],
                "api_mode": MODES[api],
                "api_key": (
                    "openshell-placeholder"
                    if hermes_switchyard_enabled(inference)
                    else model_credential(inference)
                ),
            }
        ],
        "agent": {"max_turns": 8},
        "terminal": {"backend": "local", "cwd": "/sandbox/workspace"},
        "approvals": {"mode": "manual"},
        "nemoclaw_interfaces": interface_settings(inference),
    }


def configuration_matches(inference, home=None):
    import yaml

    actual = yaml.safe_load(((home or ROOT) / "config.yaml").read_text())
    return isinstance(actual, dict) and all(
        actual.get(k) == v for k, v in native_configuration(inference).items()
    )


def initialize(inference, home=None):
    home = home or ROOT
    home.mkdir(parents=True, mode=0o700, exist_ok=True)
    path = home / "config.yaml"
    token(home, create=not path.exists())
    if path.exists():
        if not configuration_matches(inference, home):
            raise RuntimeError(
                "native Hermes configuration conflicts with deployment-owned settings"
            )
        return
    with open(path, "x", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        json.dump(native_configuration(inference), output)
        output.flush()
        os.fsync(output.fileno())


def api_request(path, body=None, timeout=3, port=PORT):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token(ROOT), "Content-Type": "application/json"},
    )
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
        request, timeout=timeout
    ) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise RuntimeError("Hermes response exceeds limit")
        return json.loads(raw)


def healthy(inference=None):
    try:
        settings = interface_settings(inference)
        if (
            not configuration_matches(inference)
            or api_request("/v1/models", port=settings["apiPort"])["data"][0]["id"] != "primary"
        ):
            return False
        dashboard = settings["dashboard"]
        if dashboard["enabled"]:
            home = ROOT / "profiles/dashboard-home"
            if not configuration_matches(inference, home):
                return False
            request = urllib.request.Request(
                f"http://127.0.0.1:{dashboard['port']}/api/sessions?limit=1",
                headers={"X-Hermes-Session-Token": token(home)},
            )
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                request, timeout=3
            ) as response:
                return response.status == 200
        return True
    except (OSError, ValueError, KeyError, IndexError, RuntimeError):
        return False


async def native_server():
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter

    settings = json.loads(os.environ["NEMOCLAW_HERMES_INTERFACES"])
    dashboard = settings["dashboard"]
    adapter = APIServerAdapter(
        PlatformConfig(
            enabled=True,
            extra={
                "host": "127.0.0.1",
                "port": settings["apiPort"],
                "key": token(ROOT),
                "model_name": "primary",
            },
        )
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    child = None
    forwarder = None
    clients = set()

    async def relay(reader, writer):
        task = asyncio.current_task()
        clients.add(task)
        target_writer = None

        async def copy(source, destination):
            while data := await source.read(65536):
                destination.write(data)
                await destination.drain()

        try:
            if len(clients) > 128:
                return
            target_reader, target_writer = await asyncio.open_connection(
                "127.0.0.1", dashboard["internalPort"]
            )
            a = asyncio.create_task(copy(reader, target_writer))
            b = asyncio.create_task(copy(target_reader, writer))
            try:
                await asyncio.wait([a, b], return_when=asyncio.FIRST_COMPLETED)
            finally:
                a.cancel()
                b.cancel()
                await asyncio.gather(a, b, return_exceptions=True)
        except OSError:
            pass
        finally:
            writer.close()
            if target_writer:
                target_writer.close()
            clients.discard(task)

    try:
        if not await adapter.connect():
            raise RuntimeError("Hermes native API startup failed")
        require_switchyard_relay(os.environ.get("NEMOCLAW_HERMES_SWITCHYARD_REQUIRED") == "1")
        if dashboard["enabled"]:
            home = ROOT / "profiles/dashboard-home"
            env = dict(
                os.environ, HERMES_HOME=str(home), HERMES_DASHBOARD_SESSION_TOKEN=token(home)
            )
            child = await asyncio.create_subprocess_exec(
                sys.executable, __file__, "dashboard", env=env
            )
            forwarder = await asyncio.start_server(relay, "127.0.0.1", dashboard["port"])
        while not stop.is_set():
            if child is not None and child.returncode is not None:
                raise RuntimeError("Hermes dashboard exited")
            try:
                await asyncio.wait_for(stop.wait(), 0.2)
            except TimeoutError:
                pass
    finally:
        if forwarder:
            forwarder.close()
            await forwarder.wait_closed()
        pending = list(clients)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if child is not None and child.returncode is None:
            child.terminate()
            try:
                await asyncio.wait_for(child.wait(), 5)
            except TimeoutError:
                child.kill()
                await child.wait()
        await adapter.disconnect()


def native_dashboard():
    from hermes_cli import web_server

    settings = json.loads(os.environ["NEMOCLAW_HERMES_INTERFACES"])["dashboard"]
    # Pinned Hermes exposes this shared gate for browser chat and WebSocket endpoints.
    web_server._DASHBOARD_EMBEDDED_CHAT_ENABLED = settings["tui"]["enabled"]
    web_server.start_server(host="127.0.0.1", port=settings["internalPort"], open_browser=False)


class HermesRuntime:
    def __init__(self):
        self.process = None
        self.log = None
        self.state_lock = None
        self.failed = False
        self.lock = asyncio.Lock()
        self.previous_response = None

    async def start(self, payload):
        config = payload["config"]
        settings = config["harness"]["settings"]
        self.inference = settings.get("inference")
        self.runtime_id = payload["runtime_context"]["runtime_id"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", self.runtime_id):
            raise ValueError("invalid runtime identity")
        model = config["models"]["default"]
        if (
            model["model"] != hermes_model_connection(self.inference)["model"]
            or model.get("base_url") != hermes_model_connection(self.inference)["base_url"]
        ):
            raise ValueError("Hermes model differs from its configured inference connection")
        ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.state_lock = (ROOT / "adapter.lock").open("a")
        try:
            fcntl.flock(self.state_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            initialize(self.inference)
            if interface_settings(self.inference)["dashboard"]["enabled"]:
                initialize(self.inference, ROOT / "profiles/dashboard-home")
            self.log = (ROOT / "api.log").open("ab")
            env = dict(
                os.environ,
                HERMES_HOME=str(ROOT),
                OPENAI_API_KEY=(
                    "openshell-placeholder"
                    if hermes_switchyard_enabled(self.inference)
                    else model_credential(self.inference)
                ),
                OPENAI_BASE_URL=hermes_model_connection(self.inference)["base_url"],
                HERMES_DISABLE_LAZY_INSTALLS="1",
                NEMOCLAW_HERMES_INTERFACES=json.dumps(interface_settings(self.inference)),
                NEMOCLAW_HERMES_SWITCHYARD_REQUIRED=(
                    "1" if hermes_switchyard_enabled(self.inference) else "0"
                ),
            )
            if hermes_relay_enabled(self.inference) or hermes_switchyard_enabled(self.inference):
                from nemo_fabric_adapters.hermes.telemetry import (
                    HERMES_RELAY_ENV_NAMES,
                    write_hermes_relay_plugin_config,
                )

                path, _ = write_hermes_relay_plugin_config(payload)
                if hermes_switchyard_enabled(self.inference):
                    path = write_switchyard_plugin_config(self.inference, path)
                for name in HERMES_RELAY_ENV_NAMES:
                    env.pop(name, None)
                env["HERMES_NEMO_RELAY_PLUGINS_TOML"] = str(path)
            self.process = await asyncio.create_subprocess_exec(
                sys.executable,
                __file__,
                "server",
                env=env,
                cwd="/sandbox/workspace",
                stdout=self.log,
                stderr=self.log,
                start_new_session=True,
            )
            deadline = asyncio.get_running_loop().time() + 75
            while asyncio.get_running_loop().time() < deadline:
                if self.process.returncode is not None:
                    raise RuntimeError("Hermes API exited during startup; inspect api.log")
                if await asyncio.to_thread(healthy, self.inference):
                    return
                await asyncio.sleep(0.1)
            raise RuntimeError("Hermes API readiness timed out")
        except BaseException:
            await self.stop()
            raise

    async def invoke(self, request, context):
        from nemo_fabric_adapter_contract.models import (
            AgentRunError,
            AgentRunResult,
            AgentRunStatus,
        )

        async with self.lock:
            if (
                self.failed
                or context.runtime_id != self.runtime_id
                or self.process.returncode is not None
            ):
                raise RuntimeError("Hermes runtime unavailable; no replay")
            probe = request.input == {"probe": True}
            if not probe and not isinstance(request.input, str):
                raise ValueError("Hermes requires a text prompt")
            if not configuration_matches(self.inference):
                raise RuntimeError("Hermes configuration drifted")
            body = {
                "model": "primary",
                "input": "Reply with the word FOUR." if probe else request.input,
                "store": not probe,
            }
            if self.previous_response and not probe:
                body["previous_response_id"] = self.previous_response
            try:
                result = await asyncio.to_thread(
                    api_request,
                    "/v1/responses",
                    body,
                    280,
                    interface_settings(self.inference)["apiPort"],
                )
                if result.get("status") != "completed" or not result.get("id"):
                    raise RuntimeError("Hermes returned an unsuccessful response")
                if not probe:
                    self.previous_response = result["id"]
                text = "\n".join(
                    c["text"]
                    for item in result.get("output", [])
                    for c in item.get("content", [])
                    if c.get("type") == "output_text"
                )
                return AgentRunResult(
                    status=AgentRunStatus.SUCCEEDED,
                    output={"harness": "hermes", "response": text, "response_id": result["id"]},
                )
            except BaseException as error:
                self.failed = True
                await self.stop()
                if not isinstance(error, Exception):
                    raise
                return AgentRunResult(
                    status=AgentRunStatus.FAILED,
                    output={"harness": "hermes"},
                    error=AgentRunError(
                        code="hermes_invocation_failed",
                        message="Hermes invocation failed; no replay; inspect api.log",
                    ),
                )

    async def stop(self):
        if self.process is not None and self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                await asyncio.wait_for(self.process.wait(), 10)
            except TimeoutError:
                os.killpg(self.process.pid, signal.SIGKILL)
                await self.process.wait()
            except ProcessLookupError:
                await self.process.wait()
        if self.log:
            self.log.close()
        if self.state_lock:
            self.state_lock.close()
            self.state_lock = None


if __name__ == "__main__":
    if sys.argv[1:] == ["server"]:
        asyncio.run(native_server())
    elif sys.argv[1:] == ["dashboard"]:
        native_dashboard()
    else:
        from nemo_fabric_adapters.common import lifecycle

        lifecycle.serve(HermesRuntime)
