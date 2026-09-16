# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Apply Pi model configuration without replacing its OpenShell sandbox."""

import asyncio
import json
import os
import signal
from pathlib import Path

MODEL_PATH = Path("/sandbox/pi-model.json")


class PiHost:
    def __init__(self, name, configuration, start_runtime, model_path=MODEL_PATH):
        self.name = name
        self.configuration = configuration
        self.start_runtime = start_runtime
        self.model_path = model_path
        self.runtime = None
        self.stopping = False
        self.config = None
        self.inference = None
        self.lock = asyncio.Lock()

    def status(self):
        return {
            "config": self.config,
            "inference": self.inference,
            "runtime_id": self.runtime.runtime_id if self.runtime else None,
            "ready": self.runtime is not None
            and not self.stopping
            and self.runtime.status == "active",
        }

    async def prepare(self, overrides):
        config = self.configuration(self.name, "pi", overrides)
        async with self.lock:
            if self.config != config:
                await self.stop()
            return {"prepared": True}

    async def configure(self, overrides):
        inference = json.loads(os.environ.get("NEMOCLAW_INFERENCE_CONFIG", "null"))
        config = self.configuration(self.name, "pi", overrides, inference=inference)
        async with self.lock:
            if self.status()["ready"] and self.config == config and self.inference == inference:
                return self.status()
            # Retain desired configuration for a sandbox process restart. Never
            # replay invocations when changing the model or recovering startup.
            temporary = self.model_path.with_suffix(".tmp")
            with temporary.open("w") as output:
                json.dump(overrides, output)
                output.flush()
                os.fsync(output.fileno())
            temporary.replace(self.model_path)
            await self.stop()
            self.config = config
            self.inference = inference
            self.runtime = await self.start_runtime(config)
            return self.status()

    async def stop(self):
        if self.runtime is not None:
            self.stopping = True
            await self.runtime.stop()
            self.runtime = None
            self.stopping = False


async def serve(configuration):
    from fabric import SOCKET
    from nemo_fabric import Fabric, FabricConfig

    os.umask(0o077)
    for directory in ("/sandbox/tmp", "/sandbox/workspace", "/sandbox/artifacts"):
        Path(directory).mkdir(parents=True, exist_ok=True)

    async def start(config):
        return await Fabric().start_runtime(
            FabricConfig.model_validate(config), base_dir="/sandbox"
        )

    host = PiHost(os.environ["NEMOCLAW_AGENT_NAME"], configuration, start)
    # Starting a process does not establish the gateway's current route. Wait
    # for explicit apply even when a prior model configuration is retained.

    async def handle(reader, writer):
        try:
            request = json.loads(await asyncio.wait_for(reader.readline(), 10))
            if request == {"operation": "check"}:
                response = host.status()
            elif (
                isinstance(request, dict)
                and set(request) == {"operation", "name", "model"}
                and request["operation"] in ("configure", "prepare")
                and request["name"] == host.name
            ):
                response = await (
                    host.configure(request["model"])
                    if request["operation"] == "configure"
                    else host.prepare(request["model"])
                )
            else:
                raise ValueError("invalid Pi configuration request")
        except Exception:
            response = {"error": "Pi configuration failed; check the model ID and piModel metadata"}
        try:
            writer.write(json.dumps(response).encode() + b"\n")
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
        async with await asyncio.start_unix_server(handle, SOCKET, limit=16384):
            await stop.wait()
    finally:
        async with host.lock:
            await host.stop()
        Path(SOCKET).unlink(missing_ok=True)
