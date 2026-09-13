# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Start one sandbox-owned Fabric runtime and expose a private readiness probe."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys

SOCKET = "/sandbox/fabric.sock"
REQUEST_LIMIT = 512 * 1024  # accommodates JSON escaping of a 64 KiB prompt
RESULT_LIMIT = 4 * 1024 * 1024


def configuration(name, harness="deepagents"):
    adapter = {"deepagents": "nvidia.fabric.langchain.deepagents",
               "hermes": "nvidia.fabric.hermes",
               "openclaw": "nemoclaw.local.openclaw"}[harness]
    return {
        **({"discovery": {"local_paths": ["/opt/nemoclaw/openclaw.fabric-adapter.json"]}}
           if harness == "openclaw" else {}),
        "metadata": {"name": name},
        "harness": {"adapter_id": adapter,
                    **({"settings": {"agent_name": name}} if harness == "openclaw" else {})},
        "models": {"default": {
            "provider": "openai", "model": "primary",
            "base_url": "https://inference.local/v1", "api_key_env": "OPENAI_API_KEY",
        }},
        "environment": {"workspace": "/sandbox/workspace"},
        "runtime": {**({"max_turns": 8} if harness != "openclaw" else {}),
                    "timeout_seconds": 300, "artifacts": "/sandbox/artifacts"},
    }


async def serve():
    from nemo_fabric import Fabric, FabricConfig, RuntimeStatus

    os.umask(0o077)
    for directory in ("/sandbox/tmp", "/sandbox/workspace", "/sandbox/artifacts"):
        Path(directory).mkdir(parents=True, exist_ok=True)
    config = configuration(os.environ["NEMOCLAW_AGENT_NAME"],
                           os.environ.get("NEMOCLAW_FABRIC_HARNESS", "deepagents"))
    runtime = await Fabric().start_runtime(FabricConfig.model_validate(config), base_dir="/sandbox")

    async def handle(reader, writer):
        try:
            raw = await asyncio.wait_for(reader.readline(), 10)
            request = json.loads(raw)
            if request == {"operation": "check"}:
                response = {"config": config, "runtime_id": runtime.runtime_id,
                            "ready": runtime.status == RuntimeStatus.ACTIVE}
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


async def client(operation, argument, harness="deepagents"):
    reader, writer = await asyncio.open_unix_connection(SOCKET, limit=RESULT_LIMIT)
    try:
        request = {"operation": operation}
        writer.write(json.dumps(request).encode() + b"\n")
        await writer.drain()
        result = json.loads(await asyncio.wait_for(reader.readline(), 320))
        if operation == "check":
            if harness == "openclaw":
                from openclaw_adapter import healthy
                if not await asyncio.to_thread(healthy, argument, result.get("runtime_id", "")):
                    return 2
            return 0 if (result.get("ready") and result.get("runtime_id")
                         and result.get("config") == configuration(argument, harness)) else 2
        print(json.dumps(result))
        return 0 if result.get("status") == "succeeded" else 1
    finally:
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "serve":
        asyncio.run(serve())
    elif len(sys.argv) == 3 and sys.argv[1] == "check":
        sys.exit(asyncio.run(client("check", sys.argv[2])))
    elif len(sys.argv) == 4 and sys.argv[1] == "check" and sys.argv[3] in ("hermes", "openclaw"):
        sys.exit(asyncio.run(client("check", sys.argv[2], sys.argv[3])))
    else:
        sys.exit("usage: fabric.py serve | check NAME [hermes|openclaw]")
