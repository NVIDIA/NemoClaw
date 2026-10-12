# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Parse, bound, and validate provisioning protocol messages."""

import asyncio
import json
import os
import stat
import sys

from bridge_contract import OPERATIONS, REQUEST_LIMIT, RESULT_LIMIT

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
    "text_input_required": 'This agent takes a text prompt; send {"text": "..."} as the input.',
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


def validate_response(response, operation):
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
