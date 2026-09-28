# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Reconcile a sandbox-owned runtime through Fabric's public configuration API."""

import asyncio
import copy
import json
import os
import signal
import sys
from pathlib import Path

from nemo_fabric import Fabric, FabricConfig

SOCKET = "/sandbox/fabric.sock"
REQUEST_LIMIT = 512 * 1024
RESULT_LIMIT = 4 * 1024 * 1024


class RuntimeHost:
    def __init__(self, name, directory=Path("/sandbox")):
        self.name = name
        self.directory = directory
        self.fabric = Fabric()
        self.config = None
        self.runtime = None
        self.stopping = False
        self.lock = asyncio.Lock()

    def status(self):
        return {
            "config": self.config,
            "runtime_id": self.runtime.runtime_id if self.runtime else None,
            "ready": self.runtime is not None
            and not self.stopping
            and self.runtime.status == "active",
        }

    def validate(self, config):
        typed = FabricConfig.model_validate(config)
        if typed.metadata.name != self.name:
            raise ValueError("configuration belongs to a different agent")
        self.fabric.plan(typed, base_dir=self.directory)
        return typed

    async def stop(self):
        if self.runtime is not None:
            self.stopping = True
            await self.runtime.stop()
            self.runtime = None
            self.stopping = False

    async def prepare(self, config):
        self.validate(config)
        async with self.lock:
            if self.config != config:
                await self.stop()
            return {"prepared": True}

    async def configure(self, config):
        typed = self.validate(config)
        async with self.lock:
            if self.status()["ready"] and self.config == config:
                return self.status()
            # OpenTofu retains desired configuration. A new host waits for
            # explicit apply so startup cannot outrun current gateway routes.
            await self.stop()
            self.config = copy.deepcopy(config)
            self.runtime = await self.fabric.start_runtime(typed, base_dir=self.directory)
            return self.status()

    async def handle(self, request):
        if request == {"operation": "status"}:
            return self.status()
        if (
            isinstance(request, dict)
            and request.get("operation") == "health"
            and set(request) <= {"operation", "agent"}
        ):
            from health import runtime_health, unavailable

            runtime = self.runtime if request.get("agent", self.name) == self.name else None
            response = await runtime_health(runtime)
            return (
                unavailable("runtime_changed")
                if self.runtime is not runtime or self.stopping
                else response
            )
        if isinstance(request, dict) and set(request) == {"operation", "config"}:
            if request["operation"] == "prepare":
                return await self.prepare(request["config"])
            if request["operation"] == "configure":
                return await self.configure(request["config"])
        if (
            isinstance(request, dict)
            and set(request) == {"operation", "input", "agent"}
            and request["operation"] == "invoke"
        ):
            if request["agent"] != self.name:
                raise ValueError("request belongs to a different agent")
            async with self.lock:
                if not self.status()["ready"]:
                    raise ValueError("runtime is not ready")
                return (await self.runtime.invoke(input=request["input"])).to_mapping()
        if request == {"operation": "probe"}:
            return {"supported": False, "reason_code": "fabric_probe_unsupported"}
        raise ValueError("invalid runtime request")


async def serve():
    os.umask(0o077)
    host = RuntimeHost(os.environ["NEMOCLAW_AGENT_NAME"])
    for directory in ("/sandbox/tmp", "/sandbox/workspace", "/sandbox/artifacts"):
        Path(directory).mkdir(parents=True, exist_ok=True)

    async def handle(reader, writer):
        try:
            request = json.loads(await asyncio.wait_for(reader.readline(), 10))
            response = await host.handle(request)
            encoded = json.dumps(response).encode() + b"\n"
            if len(encoded) > RESULT_LIMIT:
                raise ValueError("result exceeds transport limit")
        except Exception:
            # Fabric errors may contain authored settings or endpoint details.
            encoded = b'{"error":"Fabric runtime operation failed"}\n'
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
    Path(SOCKET).unlink(missing_ok=True)
    try:
        async with await asyncio.start_unix_server(handle, SOCKET, limit=REQUEST_LIMIT):
            await stop.wait()
    finally:
        async with host.lock:
            await host.stop()
        Path(SOCKET).unlink(missing_ok=True)


async def client(operation, name, config=None, input=None):
    if config is not None and config.get("metadata", {}).get("name") != name:
        raise ValueError("configuration belongs to a different agent")
    deadline = asyncio.get_running_loop().time() + 90
    while True:
        try:
            reader, writer = await asyncio.open_unix_connection(SOCKET, limit=RESULT_LIMIT)
            break
        except (FileNotFoundError, ConnectionRefusedError):
            if (
                operation not in ("prepare", "configure")
                or asyncio.get_running_loop().time() >= deadline
            ):
                raise
            await asyncio.sleep(0.1)
    try:
        request = {"operation": "status" if operation == "check" else operation}
        if operation in ("prepare", "configure"):
            request["config"] = config
        elif operation == "invoke":
            request["agent"] = name
            request["input"] = input
        writer.write(json.dumps(request).encode() + b"\n")
        await writer.drain()
        result = json.loads(await asyncio.wait_for(reader.readline(), 320))
        if operation == "prepare":
            return 0 if result == {"prepared": True} else 2
        if operation in ("check", "configure"):
            return (
                0
                if result.get("ready")
                and result.get("runtime_id")
                and result.get("config") == config
                else 2
            )
        print(json.dumps(result))
        return 0 if result.get("status") == "succeeded" else 1
    finally:
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    if sys.argv[1:] == ["serve"]:
        asyncio.run(serve())
    elif len(sys.argv) in (2, 3) and sys.argv[1] == "health":
        from health import request_health

        print(
            json.dumps(
                asyncio.run(request_health(SOCKET, sys.argv[2] if len(sys.argv) == 3 else None))
            )
        )
    elif len(sys.argv) == 4 and sys.argv[1] in ("prepare", "configure", "check"):
        sys.exit(asyncio.run(client(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))))
    elif len(sys.argv) == 3 and sys.argv[1] == "probe":
        sys.exit(asyncio.run(client("probe", sys.argv[2])))
    elif len(sys.argv) == 4 and sys.argv[1] == "invoke":
        sys.exit(asyncio.run(client("invoke", sys.argv[2], input=json.loads(sys.argv[3]))))
    else:
        raise SystemExit(
            "usage: fabric.py serve | health [NAME] | {prepare,configure,check} NAME CONFIG_JSON | invoke NAME INPUT_JSON | probe NAME"
        )
