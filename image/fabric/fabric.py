# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Expose the sandbox's Fabric runtime through the provisioning protocol."""

import asyncio
import copy
import fcntl
import json
import os
import signal
import stat
import sys
import threading
import uuid
from contextlib import redirect_stdout
from pathlib import Path

from bridge_contract import OPERATIONS, REQUEST_LIMIT, RESULT_LIMIT, SHUTDOWN_SECONDS

SOCKET = "/sandbox/fabric.sock"
PROVENANCE = "/opt/nemoclaw/provenance.json"
CALL_SECONDS = 320
HEALTH_SECONDS = 10
LEVELS = ("live", "active", "ready", "operational")
CONFIG_OPERATIONS = ("validate", "prepare", "configure")
MUTATIONS = ("prepare", "configure")

MESSAGES = {
    "invalid_request": "The request is invalid.",
    "invalid_file": "The input file must contain one bounded UTF-8 JSON object.",
    "invalid_input": "Standard input must be a pipe or file with one bounded UTF-8 JSON object.",
    "wrong_agent": "The request does not identify this agent.",
    "stale_generation": "The host generation has changed; observe state again.",
    "fabric_health_unsupported": "This Fabric revision does not support runtime health checks.",
    "fabric_health_failed": "The native runtime did not confirm the requested health level.",
    "health_observation_changed": "The runtime changed during the health observation.",
    "operational_unsupported": "Operational checks are deferred; use explicit invocation.",
    "streaming_unsupported": "Streaming invocation is not supported.",
    "host_unavailable": "The runtime host is unavailable.",
    "host_stopping": "The runtime host is shutting down.",
    "runtime_unavailable": "No active runtime is available.",
    "invalid_response": "The host response is missing, invalid, or exceeds the limit.",
    "request_too_large": "The request exceeds the transport limit.",
    "response_too_large": "The result exceeds the transport limit; the outcome is unconfirmed.",
    "fabric_validate_failed": "Fabric rejected the configuration.",
    "validation_unavailable": "Fabric could not establish configuration compatibility.",
    "fabric_start_failed": "Fabric could not establish an active runtime.",
    "fabric_stop_failed": "Fabric could not confirm that the runtime stopped.",
    "fabric_invoke_failed": "Fabric did not report a successful invocation.",
    "fabric_configuration_failed": "Fabric could not complete the operation.",
}
NATIVE_CODES = {
    "pi_model_unknown": "Fabric does not recognize the selected model.",
    "pi_model_invalid": "Fabric rejected the selected model configuration.",
    "lifecycle_adapter_start_failed": MESSAGES["fabric_start_failed"],
    "lifecycle_adapter_stop_failed": MESSAGES["fabric_stop_failed"],
    "lifecycle_adapter_invoke_failed": MESSAGES["fabric_invoke_failed"],
}
MESSAGES.update(NATIVE_CODES)


class ProtocolError(ValueError):
    def __init__(self, code="invalid_request", stage="request", *, unsupported=False):
        self.code = code
        self.stage = stage
        self.unsupported = unsupported
        super().__init__(MESSAGES[code])


def envelope(operation, result=None, *, changed=False, error=None, effects="none"):
    diagnostic = None
    if error is not None:
        diagnostic = {
            "code": error.code,
            "stage": error.stage,
            "message": MESSAGES[error.code],
            "effects": effects,
        }
    return {
        "operation": operation,
        "status": "unsupported"
        if error and error.unsupported
        else "failed"
        if error
        else "succeeded",
        "changed": changed,
        "result": result,
        "error": diagnostic,
    }


def unknown_snapshot():
    return {
        "runtime_id": None,
        "runtime_state": "unknown",
        "generation": None,
        "applied_config": None,
    }


def encode(value):
    return (
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode(
            "utf-8"
        )
        + b"\n"
    )


def decode_object(encoded):
    def reject_constant(_):
        raise ValueError("invalid JSON constant")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON field")
            result[key] = value
        return result

    value = json.loads(
        encoded.decode("utf-8"), parse_constant=reject_constant, object_pairs_hook=unique_object
    )
    if not isinstance(value, dict):
        raise ValueError("expected JSON object")
    return value


def read_object(path):
    try:
        # A pipe or device can block forever or consume stdin through /dev/stdin.
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("expected regular file")
            encoded = stream.read(REQUEST_LIMIT + 1)
        if len(encoded) > REQUEST_LIMIT:
            raise ValueError("file exceeds limit")
        return decode_object(encoded)
    except (OSError, ValueError, RecursionError) as error:
        raise ProtocolError("invalid_file") from error


def read_stdin():
    try:
        # Stdin is read only when a flag names it, never from a terminal that waits for a person.
        if sys.stdin is None or sys.stdin.isatty():
            raise ValueError("stdin is unavailable or a terminal")
        encoded = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
        if len(encoded) > REQUEST_LIMIT:
            raise ValueError("stdin exceeds limit")
        return decode_object(encoded)
    except (OSError, ValueError, RecursionError) as error:
        raise ProtocolError("invalid_input") from error


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


def validate_request(request, name=None):
    if not isinstance(request, dict) or request.get("operation") not in OPERATIONS:
        raise ProtocolError()
    operation = request["operation"]
    required = {"operation", "agent"}
    if operation in CONFIG_OPERATIONS:
        required.add("config")
    if operation in MUTATIONS:
        required.add("expected_generation")
    if operation == "invoke":
        required.add("input")
    if operation == "check":
        required.add("level")
    if set(request) != required:
        raise ProtocolError()
    if not isinstance(request["agent"], str) or not request["agent"] or "\x00" in request["agent"]:
        raise ProtocolError()
    if name is not None and request["agent"] != name:
        raise ProtocolError("wrong_agent")
    if operation in CONFIG_OPERATIONS:
        config = request["config"]
        if not isinstance(config, dict):
            raise ProtocolError()
        metadata = config.get("metadata")
        if not isinstance(metadata, dict) or metadata.get("name") != request["agent"]:
            raise ProtocolError("wrong_agent")
    if operation in MUTATIONS and (
        not isinstance(request["expected_generation"], str) or not request["expected_generation"]
    ):
        raise ProtocolError()
    if operation == "check" and request["level"] not in LEVELS:
        raise ProtocolError()
    if operation == "invoke":
        if not isinstance(request["input"], dict):
            raise ProtocolError()
        if request["input"].get("stream") or request["input"].get("streaming"):
            raise ProtocolError("streaming_unsupported", "invoke", unsupported=True)
    if len(encode(request)) > REQUEST_LIMIT:
        raise ProtocolError("request_too_large")
    return operation


def parse_command(arguments):
    if not arguments or arguments[0] not in OPERATIONS:
        raise ProtocolError()
    operation = arguments[0]
    flags = {}
    index = 1
    while index < len(arguments):
        flag = arguments[index]
        if flag in flags:
            raise ProtocolError()
        if flag in ("--" + level for level in LEVELS):
            flags[flag] = True
            index += 1
        elif flag in ("--agent", "--config", "--input", "--expected-generation"):
            if index + 1 == len(arguments) or arguments[index + 1].startswith("--"):
                raise ProtocolError()
            flags[flag] = arguments[index + 1]
            index += 2
        else:
            raise ProtocolError()
    allowed = {"--agent"}
    if operation in CONFIG_OPERATIONS:
        allowed.add("--config")
    if operation in MUTATIONS:
        allowed.add("--expected-generation")
    if operation == "invoke":
        allowed.add("--input")
    if operation == "check":
        allowed.update("--" + level for level in LEVELS)
    if set(flags) - allowed or not allowed.difference("--" + level for level in LEVELS).issubset(
        flags
    ):
        raise ProtocolError()
    request = {"operation": operation, "agent": flags["--agent"]}
    for flag, field in (("--config", "config"), ("--input", "input")):
        if flag in flags:
            # Only an exact dash selects stdin; every other value names a file.
            request[field] = read_stdin() if flags[flag] == "-" else read_object(flags[flag])
    if "--expected-generation" in flags:
        request["expected_generation"] = flags["--expected-generation"]
    if operation == "check":
        selected = [level for level in LEVELS if "--" + level in flags]
        if len(selected) > 1:
            raise ProtocolError()
        request["level"] = selected[0] if selected else "live"
    validate_request(request, os.environ.get("NEMOCLAW_AGENT_NAME"))
    return request


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
                changed, effects = None, "unknown"
                runtime_id = self.runtime.runtime_id
                native_result = (await self.runtime.invoke(input=request["input"])).to_mapping()
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


async def read_message(reader, limit, seconds):
    try:
        encoded = await asyncio.wait_for(reader.readline(), seconds)
        if len(encoded) > limit or not encoded.endswith(b"\n"):
            raise ValueError("invalid framing")
        return decode_object(encoded)
    except (ValueError, RecursionError, TimeoutError) as error:
        raise ProtocolError("invalid_response", "transport") from error


def bounded_response(response):
    try:
        encoded = encode(response)
        if len(encoded) <= RESULT_LIMIT:
            return encoded
    except (ValueError, TypeError, RecursionError):
        pass
    return encode(
        envelope(
            response["operation"],
            changed=None,
            error=ProtocolError("response_too_large", "transport"),
            effects="unknown",
        )
    )


def confirms_success(response):
    result = response["result"]
    if not isinstance(result, dict):
        return False
    operation = response["operation"]
    runtime_id = result.get("runtime_id")
    if operation in ("configure", "invoke") and (not isinstance(runtime_id, str) or not runtime_id):
        return False
    if operation == "validate":
        return result.get("valid") is True and response["changed"] is False
    if operation == "invoke":
        native = result.get("fabric_result")
        return (
            isinstance(native, dict)
            and native.get("status") == "succeeded"
            and response["changed"] is None
        )
    if operation == "check":
        return isinstance(result.get("health"), dict) and response["changed"] is False
    if not isinstance(result.get("generation"), str) or not result["generation"]:
        return False
    if operation == "prepare":
        return result.get("prepared") is True and result.get("runtime_state") == "stopped"
    return (
        operation == "configure"
        and result.get("runtime_state") == "running"
        and bool(result.get("runtime_id"))
    )


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
        if (
            set(response) != {"operation", "status", "changed", "result", "error"}
            or response["operation"] != operation
            or response["status"] not in ("succeeded", "failed", "unsupported")
            or not (response["changed"] is None or type(response["changed"]) is bool)
            or not (response["result"] is None or isinstance(response["result"], dict))
            or (response["status"] == "succeeded") != (response["error"] is None)
        ):
            raise ProtocolError("invalid_response", "transport")
        if response["status"] == "succeeded" and not confirms_success(response):
            raise ProtocolError("invalid_response", "transport")
        if response["error"] is not None:
            error = response["error"]
            if (
                not isinstance(error, dict)
                or set(error) != {"code", "stage", "message", "effects"}
                or not isinstance(error.get("code"), str)
                or error["code"] not in MESSAGES
                or error.get("effects") not in ("none", "applied", "unknown")
            ):
                raise ProtocolError("invalid_response", "transport")
            if error["stage"] not in (
                "request",
                "validate",
                "generation",
                "check",
                "start",
                "stop",
                "invoke",
                "transport",
            ):
                raise ProtocolError("invalid_response", "transport")
            # Never echo a peer's arbitrary diagnostic text.
            error["message"] = MESSAGES[error["code"]]
        return response
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
