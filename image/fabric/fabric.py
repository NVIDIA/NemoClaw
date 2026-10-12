# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Expose the sandbox's Fabric runtime through the provisioning protocol."""

import asyncio
import copy
import fcntl
import json
import os
import signal
import sys
import threading
import uuid
from contextlib import redirect_stdout
from pathlib import Path

from bridge_contract import OPERATIONS, REQUEST_LIMIT, RESULT_LIMIT, SHUTDOWN_SECONDS
from bridge_protocol import (
    CONFIG_OPERATIONS,
    MESSAGES,
    MUTATIONS,
    NATIVE_CODES,
    ProtocolError,
    bounded_response,
    decode_object,
    encode,
    envelope,
    parse_command,
    read_message,
    read_object,
    unknown_snapshot,
    validate_request,
    validate_response,
)

SOCKET = "/sandbox/fabric.sock"
PROVENANCE = "/opt/nemoclaw/provenance.json"
CALL_SECONDS = 320
HEALTH_SECONDS = 10


def fabric_revision():
    try:
        revision = read_object(PROVENANCE).get("fabric_revision")
        return (
            revision
            if isinstance(revision, str)
            and len(revision) == 40
            and all(c in "0123456789abcdef" for c in revision)
            else None
        )
    except ProtocolError:
        return None


def takes_text(config):
    """Whether the configured adapter accepts only a text prompt. Fabric does
    not declare an adapter's input type, so the bridge names the one that does."""
    harness = config.get("harness") if isinstance(config, dict) else None
    if not isinstance(harness, dict):
        return False
    settings = harness.get("settings")
    return (
        harness.get("adapter_id") == "nvidia.fabric.hermes"
        and isinstance(settings, dict)
        and settings.get("mode") == "service"
    )


def adapter_input(config, value):
    """The input Fabric receives. A caller always sends an object; for an
    adapter that takes text, the object must be exactly {"text": "..."} and
    the bridge passes the string. Other adapters receive the object as sent."""
    if not takes_text(config):
        return value
    if set(value) != {"text"} or not isinstance(value["text"], str):
        raise ProtocolError("text_input_required", "invoke")
    return value["text"]


def load_backend():
    # Each image installs its owner implementation at this fixed module path.
    # Clients and protocol parsing do not need to import an adapter or the SDK.
    from backend import Backend

    return Backend()


class RuntimeHost:
    def __init__(self, name, directory=Path("/sandbox"), *, backend=None):
        self.name = name
        self.directory = directory
        self.backend = load_backend() if backend is None else backend
        self.config = None
        self.runtime = None
        self.state = "stopped"
        self.generation = uuid.uuid4().hex
        self.shutting_down = False
        self.lock = asyncio.Lock()

    def snapshot(self):
        # No await separates these reads, so lifecycle work cannot interleave.
        state = self.state
        if self.runtime is not None and self.runtime.status != "active":
            state = "unknown"
        return {
            "runtime_id": self.runtime.runtime_id if self.runtime else None,
            "runtime_state": state,
            "generation": self.generation,
            "applied_config": copy.deepcopy(self.config),
        }

    def validate(self, config):
        return self.backend.validate(config, base_dir=self.directory)

    async def stop(self):
        if self.runtime is not None:
            self.state = "unknown"
            await self.runtime.stop()
            self.runtime = None
            self.config = None
            self.state = "stopped"
        elif self.state != "stopped":
            # A failed startup may have left effects without returning a handle.
            raise ProtocolError("fabric_stop_failed", "stop")

    async def handle(self, request):
        operation = request.get("operation", "unknown") if isinstance(request, dict) else "unknown"
        if operation not in OPERATIONS:
            operation = "unknown"
        changed, effects = False, "none"
        result = None
        stage = "request"
        try:
            validate_request(request, self.name)
            if operation == "check":
                result = {**self.snapshot(), "health": None}
            if self.shutting_down or operation == "serve":
                raise ProtocolError("host_stopping")
            if operation == "check":
                stage = "check"
                level = request["level"]
                if level == "operational":
                    raise ProtocolError("operational_unsupported", stage, unsupported=True)
                if level not in self.backend.health_checks:
                    raise ProtocolError("fabric_health_unsupported", stage, unsupported=True)
                observed = self.snapshot()
                passed, report = await asyncio.wait_for(
                    self.backend.check(self.runtime, level), HEALTH_SECONDS
                )
                current = self.snapshot()
                if any(
                    current[key] != observed[key]
                    for key in ("generation", "runtime_id", "runtime_state")
                ):
                    result = {**current, "health": None}
                    raise ProtocolError("health_observation_changed", stage)
                if type(passed) is not bool or not isinstance(report, dict):
                    raise ProtocolError("fabric_health_failed", stage)
                result["health"] = report
                if not passed:
                    raise ProtocolError("fabric_health_failed", stage)
                return envelope(operation, result)
            if operation in CONFIG_OPERATIONS:
                stage = "validate"
                config = copy.deepcopy(request["config"])
                result = (
                    {
                        "valid": None,
                        "adapter": config["harness"].get("adapter_id")
                        if isinstance(config.get("harness"), dict)
                        else None,
                        "fabric_revision": fabric_revision(),
                        "diagnostics": [],
                        "unverified": ["network", "authentication", "health", "inference"],
                    }
                    if operation == "validate"
                    else None
                )
                typed = await asyncio.to_thread(self.validate, config)
                if operation == "validate":
                    result["valid"] = True
                    return envelope(operation, result)
            async with self.lock:
                if self.shutting_down:
                    raise ProtocolError("host_stopping")
                if operation in MUTATIONS:
                    if request["expected_generation"] != self.generation:
                        raise ProtocolError("stale_generation", "generation")
                    if (
                        operation == "configure"
                        and self.snapshot()["runtime_state"] == "running"
                        and json.dumps(self.config, sort_keys=True)
                        == json.dumps(config, sort_keys=True)
                    ):
                        return envelope(operation, self.snapshot())
                    if operation == "prepare" and self.runtime is None and self.state == "stopped":
                        return envelope(operation, {**self.snapshot(), "prepared": True})
                    self.generation = uuid.uuid4().hex
                    changed, effects = None, "unknown"
                    stage = "stop"
                    await self.stop()
                    if operation == "configure":
                        stage = "start"
                        self.state = "unknown"
                        self.runtime = await self.backend.start_runtime(
                            typed, base_dir=self.directory
                        )
                        if self.runtime.status != "active":
                            raise ProtocolError("fabric_start_failed", "start")
                        self.config = config
                        self.state = "running"
                    result = self.snapshot()
                    if operation == "prepare":
                        result["prepared"] = True
                    return envelope(operation, result, changed=True)
                stage = "invoke"
                if self.snapshot()["runtime_state"] != "running":
                    raise ProtocolError("runtime_unavailable", stage)
                # Refusing the input sends nothing, so its effects are none.
                native_input = adapter_input(self.config, request["input"])
                changed, effects = None, "unknown"
                runtime_id = self.runtime.runtime_id
                native_result = (await self.runtime.invoke(input=native_input)).to_mapping()
                result = {"runtime_id": runtime_id, "fabric_result": native_result}
                if native_result.get("status") != "succeeded":
                    raise ProtocolError("fabric_invoke_failed", stage)
                return envelope(operation, result, changed=None)
        except Exception as error:
            if not isinstance(error, ProtocolError):
                code, error_is_invalid, unverified = self.backend.error_details(error)
                if code not in NATIVE_CODES:
                    code = (
                        f"fabric_{stage}_failed"
                        if stage in ("validate", "start", "stop", "invoke")
                        else "fabric_health_failed"
                        if stage == "check"
                        else "fabric_configuration_failed"
                    )
                if stage == "validate" and not error_is_invalid:
                    code = "validation_unavailable"
                if operation == "validate" and result is not None:
                    result["valid"] = False if error_is_invalid else None
                    if unverified:
                        result["unverified"].append("adapter_capabilities")
                error = ProtocolError(code, stage)
            if operation == "validate" and result is not None:
                result["diagnostics"] = [
                    {"code": error.code, "field": "$", "message": MESSAGES[error.code]}
                ]
            if operation in MUTATIONS:
                result = self.snapshot()
                if operation == "prepare":
                    result["prepared"] = False
            return envelope(operation, result, changed=changed, error=error, effects=effects)


async def client(request):
    operation = request["operation"]
    sent = False
    writer = None
    try:
        validate_request(request)
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(SOCKET, limit=RESULT_LIMIT), CALL_SECONDS
        )
        writer.write(encode(request))
        sent = True
        await asyncio.wait_for(writer.drain(), CALL_SECONDS)
        response = await read_message(reader, RESULT_LIMIT, CALL_SECONDS)
        return validate_response(response, operation)
    except (OSError, ValueError, TimeoutError) as error:
        if not isinstance(error, ProtocolError):
            error = ProtocolError("host_unavailable", "transport")
        if (
            not sent
            and operation == "check"
            and request["level"] == "operational"
            and error.code == "host_unavailable"
        ):
            error = ProtocolError("operational_unsupported", "check", unsupported=True)
        result = {**unknown_snapshot(), "health": None} if operation == "check" else None
        effects = "unknown" if sent and operation in (*MUTATIONS, "invoke") else "none"
        changed = None if effects == "unknown" else False
        return envelope(operation, result, changed=changed, error=error, effects=effects)
    finally:
        if writer is not None:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 1)
            except (OSError, TimeoutError):
                pass


async def serve(name, directory=Path("/sandbox"), stop_event=None):
    os.umask(0o077)
    host = RuntimeHost(name, directory)
    socket = Path(SOCKET)
    lock = os.open(socket.with_suffix(".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    owned_socket = None
    tasks = set()
    try:
        # Keep this lock file: unlinking a flock inode would allow a second owner.
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for relative in ("tmp", "workspace", "artifacts"):
            (directory / relative).mkdir(parents=True, exist_ok=True)

        async def handle(reader, writer):
            task = asyncio.current_task()
            tasks.add(task)
            try:
                try:
                    request = await read_message(reader, REQUEST_LIMIT, 10)
                    response = await host.handle(request)
                except Exception:
                    response = envelope("unknown", error=ProtocolError())
                writer.write(bounded_response(response))
                await asyncio.wait_for(writer.drain(), 10)
            except (OSError, TimeoutError):
                pass
            finally:
                writer.close()
                tasks.discard(task)

        stop = stop_event or asyncio.Event()
        loop = asyncio.get_running_loop()
        watchdog = None

        def request_stop():
            nonlocal watchdog
            host.shutting_down = True
            stop.set()
            if watchdog is None:
                # Native calls can outlive asyncio cancellation. Bound this host's
                # exit; callers must confirm sandbox stop before replacing the host.
                watchdog = threading.Timer(SHUTDOWN_SECONDS, os._exit, args=(1,))
                watchdog.daemon = True
                watchdog.start()

        if stop_event is None:
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, request_stop)
        socket.unlink(missing_ok=True)
        server = await asyncio.start_unix_server(handle, socket, limit=REQUEST_LIMIT)
        owned_socket = socket.stat()
        os.chmod(socket, 0o600)
        try:
            async with server:
                await stop.wait()
                host.shutting_down = True
                server.close()
                await server.wait_closed()
                async with asyncio.timeout(SHUTDOWN_SECONDS):
                    async with host.lock:
                        await host.stop()
            return 0
        finally:
            for task in tasks:
                task.cancel()
            # Leave the watchdog armed until this process exits. asyncio.run may
            # still be joining a native planner worker after request cancellation.
            if stop_event is None:
                for sig in (signal.SIGINT, signal.SIGTERM):
                    loop.remove_signal_handler(sig)
    finally:
        if owned_socket is not None:
            try:
                current = socket.stat()
                if (current.st_dev, current.st_ino) == (owned_socket.st_dev, owned_socket.st_ino):
                    socket.unlink()
            except FileNotFoundError:
                pass
        os.close(lock)


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    operation = arguments[0] if arguments and arguments[0] in OPERATIONS else "unknown"
    try:
        request = parse_command(arguments)
        if operation == "serve":
            # Inherit stderr for Fabric and subprocess logs, reserving stdout for clients.
            os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
            return asyncio.run(serve(request["agent"]))
        if operation == "validate":
            # Validation belongs to the selected image and needs no running host.
            # Reserve stdout for the response even if an owner library logs there.
            with redirect_stdout(sys.stderr):
                response = asyncio.run(RuntimeHost(request["agent"]).handle(request))
        else:
            response = asyncio.run(client(request))
    except Exception as error:
        if operation == "serve":
            print("Fabric host could not start or shut down cleanly.", file=sys.stderr)
            return 1
        if not isinstance(error, ProtocolError):
            error = ProtocolError()
        response = envelope(operation, error=error)
    encoded = bounded_response(response)
    sys.stdout.write(encoded.decode("utf-8"))
    return 0 if decode_object(encoded)["status"] == "succeeded" else 1


if __name__ == "__main__":
    sys.exit(main())
