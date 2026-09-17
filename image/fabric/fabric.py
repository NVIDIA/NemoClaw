# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Start one sandbox-owned Fabric runtime and expose a private readiness probe."""

import asyncio
import json
import os
import re
import signal
import sys
from pathlib import Path

SOCKET = "/sandbox/fabric.sock"
REQUEST_LIMIT = 512 * 1024  # accommodates JSON escaping of a 64 KiB prompt
RESULT_LIMIT = 4 * 1024 * 1024


def openclaw_execution(inference=None):
    execution = (inference or {}).get("execution", {})
    if (
        not isinstance(execution, dict)
        or set(execution) - {"timeoutSeconds", "heartbeatEvery"}
        or (inference is not None and "execution" in inference and not execution)
    ):
        raise ValueError("invalid OpenClaw execution settings")
    seconds = execution.get("timeoutSeconds", 600)
    heartbeat = execution.get("heartbeatEvery")
    if (
        type(seconds) is not int
        or not 1 <= seconds <= 1000000000
        or (
            "heartbeatEvery" in execution
            and (
                not isinstance(heartbeat, str)
                or len(heartbeat) > 256
                or not re.fullmatch(r"[0-9]+[smh]", heartbeat)
            )
        )
    ):
        raise ValueError("invalid OpenClaw execution settings")
    return {
        "timeoutSeconds": seconds,
        **({"heartbeatEvery": heartbeat} if heartbeat is not None else {}),
    }


def hermes_relay_enabled(inference=None):
    observability = (inference or {}).get("observability")
    if not isinstance(observability, dict) or "relay" not in observability:
        return False
    if (
        observability != {"relay": {"enabled": True}}
        or (inference or {}).get("interfaces") is not None
    ):
        raise ValueError(
            "Hermes Relay tracing requires the exact enabled setting and no native interfaces"
        )
    return True


def relay_configuration(name):
    output = "/sandbox/artifacts/relay"
    return {
        "telemetry": {"providers": {"relay": {}}},
        "relay": {
            "project": name,
            "output_dir": output,
            "observability": {
                "version": 3,
                "atof": {
                    "enabled": True,
                    "sinks": [
                        {
                            "type": "file",
                            "output_directory": output,
                            "filename": "events.atof.jsonl",
                            "mode": "overwrite",
                        }
                    ],
                },
                "atif": {
                    "enabled": True,
                    "agent_name": name,
                    "agent_version": "nemoclaw-v1alpha1",
                    "model_name": "primary",
                    "output_directory": output,
                    "filename_template": "trajectory-{session_id}.atif.json",
                },
                "enable_full_payloads": False,
            },
            "components": [],
        },
    }


def model_connection(inference=None, model=None):
    connection = (inference or {}).get("connection")
    if connection is None:
        return {
            "provider": "openai",
            "model": "primary",
            "base_url": "https://inference.local/v1",
            "api_key_env": "OPENAI_API_KEY",
        }
    if model is not None and isinstance(connection, dict):
        connection = {**connection, "model": model}
    if (
        not isinstance(connection, dict)
        or set(connection) != {"provider", "model", "base_url", "api_key_env"}
        or connection["provider"] not in ("openai", "anthropic")
        or not isinstance(connection["model"], str)
        or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}", connection["model"])
        or not isinstance(connection["base_url"], str)
        or not connection["base_url"].startswith(("http://", "https://"))
        or not isinstance(connection["api_key_env"], str)
        or (
            connection["api_key_env"]
            and connection["api_key_env"] != "NEMOCLAW_ANONYMOUS_API_KEY"
            and not re.fullmatch(r"NEMOCLAW_INFERENCE_[A-Z0-9_]+_KEY", connection["api_key_env"])
        )
    ):
        raise ValueError("invalid native inference connection")
    return dict(connection)


def model_credential(inference=None):
    if "connection" not in (inference or {}):
        return "openshell-placeholder"
    key = model_connection(inference)["api_key_env"]
    if not key:
        return "unused"
    value = os.environ.get(key)
    if not value:
        raise ValueError("attached inference credential is unavailable")
    return value


def configuration(name, harness="deepagents", model=None, inference=None):
    if inference is None and os.environ.get("NEMOCLAW_INFERENCE_CONFIG"):
        inference = json.loads(os.environ["NEMOCLAW_INFERENCE_CONFIG"])
    if harness == "pi":
        if model is None:
            from pi_host import MODEL_PATH

            if not MODEL_PATH.exists():
                raise ValueError("Pi requires the configured route model")
            model = json.loads(MODEL_PATH.read_text())
        if (
            not isinstance(model, dict)
            or set(model) - {"model", "piModel"}
            or not isinstance(model.get("model"), str)
            or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}", model["model"])
        ):
            raise ValueError("Pi requires a valid configured route model")
    relay = harness == "hermes" and hermes_relay_enabled(inference)
    adapter = {
        "deepagents": "nvidia.fabric.langchain.deepagents",
        "hermes": "nemoclaw.local.hermes",
        "openclaw": "nemoclaw.local.openclaw",
        "claude": "nvidia.fabric.claude",
        "codex": "nvidia.fabric.codex",
        "mini-swe-agent": "nvidia.fabric.mini-swe-agent",
        "nooa": "nvidia.fabric.nooa",
        "nooa-bench": "nvidia.fabric.nooa.bench-agent",
        "remote-agent": "nvidia.fabric.remote-agent",
        "pi": "nvidia.fabric.pi",
    }[harness]
    if relay:
        adapter = "nvidia.fabric.hermes"
    config = {
        **(
            {"discovery": {"local_paths": ["/opt/nemoclaw/openclaw.fabric-adapter.json"]}}
            if harness == "openclaw"
            else {}
        ),
        **(
            {"discovery": {"local_paths": ["/opt/nemoclaw/hermes.fabric-adapter.json"]}}
            if harness == "hermes" and not relay
            else {}
        ),
        **(
            {
                "discovery": {
                    "local_paths": [
                        "/opt/fabric-source/adapters/typescript/pi/pi.fabric-adapter.json"
                    ]
                }
            }
            if harness == "pi"
            else {}
        ),
        "metadata": {"name": name},
        **({"workflow": {"target_id": "nvidia.nooa.coding-agent"}} if harness == "nooa" else {}),
        "harness": {
            "adapter_id": adapter,
            **(
                {
                    "settings": {
                        "base_url": "https://inference.local/v1",
                        "api_type": "openai-completions",
                    }
                }
                if harness == "remote-agent"
                else {}
            ),
            **(
                {"settings": {"agent_name": name}}
                if harness == "openclaw" or harness == "hermes" and not relay
                else {}
            ),
        },
        "models": {
            "default": {
                "provider": "openai",
                "model": model["model"] if harness == "pi" else "primary",
                **(
                    {"settings": {"model_metadata": model["piModel"]}}
                    if harness == "pi" and "piModel" in model
                    else {}
                ),
                **({"base_url": "https://inference.local/v1"} if harness != "remote-agent" else {}),
                **(
                    {"settings": {"client_type": "completion"}}
                    if harness in ("nooa", "nooa-bench")
                    else {}
                ),
                "api_key_env": "OPENAI_API_KEY",
            }
        },
        "environment": {"workspace": "/sandbox/workspace"},
        "runtime": {
            **(
                {"max_turns": 8}
                if harness in ("deepagents", "claude", "mini-swe-agent") or relay
                else {}
            ),
            "timeout_seconds": openclaw_execution(inference)["timeoutSeconds"] + 60
            if harness == "openclaw"
            else 300,
            "artifacts": "/sandbox/artifacts",
        },
        **(relay_configuration(name) if relay else {}),
    }

    if inference is not None:
        api = inference["api"]
        if harness == "openclaw":
            config["harness"]["settings"]["inference"] = inference
        elif harness == "hermes":
            settings = config["harness"].setdefault("settings", {})
            settings.update(
                {
                    **({} if relay else {"inference": inference}),
                    "api_mode": {
                        "openai-completions": "chat_completions",
                        "openai-responses": "codex_responses",
                        "anthropic-messages": "anthropic_messages",
                    }[api],
                }
            )
            config["models"]["default"]["provider"] = (
                "anthropic" if api == "anthropic-messages" else "openai"
            )
    if "connection" in (inference or {}):
        config["models"]["default"].update(
            model_connection(inference, model["model"] if harness == "pi" else None)
        )
        if harness == "remote-agent":
            config["harness"]["settings"]["base_url"] = model_connection(inference)["base_url"]
    return config


async def serve():
    if os.environ.get("NEMOCLAW_FABRIC_HARNESS") == "pi":
        from pi_host import serve as serve_pi

        return await serve_pi(configuration)
    from nemo_fabric import Fabric, FabricConfig, RuntimeStatus

    os.umask(0o077)
    for directory in ("/sandbox/tmp", "/sandbox/workspace", "/sandbox/artifacts"):
        Path(directory).mkdir(parents=True, exist_ok=True)
    inference = (
        json.loads(os.environ["NEMOCLAW_INFERENCE_CONFIG"])
        if "NEMOCLAW_INFERENCE_CONFIG" in os.environ
        else None
    )
    config = configuration(
        os.environ["NEMOCLAW_AGENT_NAME"],
        os.environ.get("NEMOCLAW_FABRIC_HARNESS", "deepagents"),
        inference=inference,
    )
    runtime = await Fabric().start_runtime(FabricConfig.model_validate(config), base_dir="/sandbox")

    async def handle(reader, writer):
        try:
            raw = await asyncio.wait_for(reader.readline(), 10)
            request = json.loads(raw)
            if request == {"operation": "health"}:
                from health import runtime_health

                response = await runtime_health(runtime)
            elif request == {"operation": "check"}:
                response = {
                    "config": config,
                    "runtime_id": runtime.runtime_id,
                    "ready": runtime.status == RuntimeStatus.ACTIVE,
                    "inference": inference,
                }
            elif request == {"operation": "probe"} and config["harness"]["adapter_id"] in (
                "nemoclaw.local.hermes",
                "nvidia.fabric.hermes",
            ):
                probe = (
                    {"probe": True}
                    if config["harness"]["adapter_id"] == "nemoclaw.local.hermes"
                    else "Reply with the word FOUR."
                )
                response = (await asyncio.wait_for(runtime.invoke(input=probe), 300)).to_mapping()
            else:
                raise ValueError("invalid request")
            encoded = json.dumps(response).encode() + b"\n"
            if len(encoded) > RESULT_LIMIT:
                raise ValueError("result exceeded limit; invocation may have had effects")
        except Exception as error:
            encoded = json.dumps({"error": str(error)}).encode() + b"\n"
        try:
            writer.write(encoded)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    # A stale socket can remain after process death. No retry/replay of invocations.
    Path(SOCKET).unlink(missing_ok=True)
    try:
        async with await asyncio.start_unix_server(handle, SOCKET, limit=REQUEST_LIMIT):
            await stop.wait()
    finally:
        await runtime.stop()
        Path(SOCKET).unlink(missing_ok=True)


async def client(operation, argument, harness="deepagents", model=None, inference=None):
    expected = configuration(argument, harness, model, inference)
    deadline = asyncio.get_running_loop().time() + 90
    while True:
        try:
            reader, writer = await asyncio.open_unix_connection(SOCKET, limit=RESULT_LIMIT)
            break
        except (FileNotFoundError, ConnectionRefusedError):
            if (
                operation not in ("configure", "prepare")
                or asyncio.get_running_loop().time() >= deadline
            ):
                raise
            await asyncio.sleep(0.1)
    try:
        request = {"operation": operation}
        if operation in ("configure", "prepare"):
            request.update(name=argument, model=model)
        writer.write(json.dumps(request).encode() + b"\n")
        await writer.drain()
        result = json.loads(await asyncio.wait_for(reader.readline(), 320))
        if operation == "prepare":
            return 0 if result == {"prepared": True} else 2
        if operation in ("check", "configure"):
            if harness == "hermes" and expected["harness"]["adapter_id"] == "nemoclaw.local.hermes":
                from hermes_adapter import healthy

                if not await asyncio.to_thread(healthy, inference):
                    return 2
            if harness == "openclaw":
                from openclaw_adapter import healthy

                if not await asyncio.to_thread(
                    healthy, argument, result.get("runtime_id", ""), inference
                ):
                    return 2
            return (
                0
                if (
                    result.get("ready")
                    and result.get("runtime_id")
                    and result.get("config") == expected
                    and result.get("inference") == inference
                )
                else 2
            )
        print(json.dumps(result))
        return 0 if result.get("status") == "succeeded" else 1
    finally:
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    inference = None
    if len(sys.argv) >= 3 and sys.argv[-2] == "--inference":
        inference = json.loads(sys.argv[-1])
        del sys.argv[-2:]
    if len(sys.argv) == 2 and sys.argv[1] == "serve":
        asyncio.run(serve())
    elif len(sys.argv) == 2 and sys.argv[1] == "health":
        from health import request_health

        print(json.dumps(asyncio.run(request_health(SOCKET))))
    elif (
        len(sys.argv) == 5
        and sys.argv[1] in ("configure", "prepare", "check")
        and sys.argv[3] == "pi"
    ):
        sys.exit(
            asyncio.run(
                client(sys.argv[1], sys.argv[2], "pi", json.loads(sys.argv[4]), inference=inference)
            )
        )
    elif len(sys.argv) == 3 and sys.argv[1] == "check":
        sys.exit(asyncio.run(client("check", sys.argv[2], inference=inference)))
    elif (
        len(sys.argv) == 4
        and sys.argv[1] in ("check", "probe")
        and sys.argv[3]
        in (
            "deepagents",
            "hermes",
            "openclaw",
            "claude",
            "codex",
            "mini-swe-agent",
            "nooa",
            "nooa-bench",
            "remote-agent",
            "pi",
        )
    ):
        sys.exit(asyncio.run(client(sys.argv[1], sys.argv[2], sys.argv[3], inference=inference)))
    else:
        sys.exit("usage: fabric.py serve | check NAME [HARNESS]")
