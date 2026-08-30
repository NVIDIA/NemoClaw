#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Root-only hold for one exact runtime state mutation.

The host may invoke only the fixed actions exposed by :func:`main`. Acquire
consumes the full bounded runtime and plan binding. Later actions consume one
exact observation plus the provider handle. The durable marker records the
exact OpenShell PID 1, its direct ``nemoclaw-start`` child, and each held
activation process. A controller restart can therefore re-establish or finish
only the original process fence.

PID 1 remains stopped until release completes. This blocks OpenShell SSH and
exec admission while a root provider exec can continue the transaction. The
helper also stops ``nemoclaw-start`` and terminates every other process that
uses the ``sandbox`` or ``gateway`` account. Activation resumes only the exact
entrypoint, proves a fresh Hermes gateway, and freezes the resulting process
tree before it returns evidence to the host.

Posture transitions use the fixed, root-owned Hermes publisher module and
accept only its exact nonce-bound receipt. The host ledger remains
authoritative for publication completion.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
import pwd
import re
import secrets
import select
import signal
import stat
import sys
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Literal


Action = Literal[
    "acquire", "assert", "publish", "rollback", "activate", "release", "recover"
]
Phase = Literal["fenced", "published", "rolled-back", "activation-proven"]

SCHEMA_VERSION = 1
PLAN_SCHEMA_VERSION = 2
SUPPORTED_STATE_ROOT = "/sandbox/.hermes"
SUPPORTED_WRITER_ACCOUNTS = ("gateway", "sandbox")

MAX_ENVELOPE_BYTES = 128 * 1024
MAX_PLAN_BYTES = 64 * 1024
MAX_MARKER_BYTES = 160 * 1024
MAX_PROC_ENTRIES = 32_768
MAX_PROC_FILE_BYTES = 1024 * 1024
MAX_CONFIG_GENERATION_BYTES = 64 * 1024
MAX_ACTIVATION_PROCESSES = 256
MAX_SELECTORS = 256
MAX_STRING_BYTES = 4096
TERM_SECONDS = 3.0
KILL_SECONDS = 5.0
PROCESS_STATE_SECONDS = 5.0
ACTIVATION_SECONDS = 150.0
HEALTH_SECONDS = 3.0
STABLE_SCANS = 3
POLL_SECONDS = 0.05

ROOT_UID = 0
ROOT_GID = 0
PROC_ROOT = "/proc"
MOUNT_NAMESPACE_PATH = "/proc/1/ns/mnt"
DURABLE_DIRECTORY = "/var/lib/nemoclaw/runtime-state-mutation"
RUNTIME_DIRECTORY = "/run/nemoclaw/runtime-state-mutation"
STARTUP_HANDOFF_DIRECTORY = "/run/nemoclaw/runtime-state-mutation-startup"
DURABLE_PARENT_MODE = 0o755
DURABLE_DIRECTORY_MODE = 0o711
RUNTIME_DIRECTORY_MODE = 0o700
STARTUP_HANDOFF_PARENT_MODE = 0o711
MARKER_NAME = "active.json"
LOCK_NAME = "control.lock"
SENTINEL_NAME = "hold.json"
ACTIVATION_RECEIPT_NAME = "activation.json"
ACTIVATION_PERMIT_NAME = "activation-permit.json"
ACTIVATION_RELEASE_NAME = "activation-release.json"
ACTIVATION_RETRY_NAME = "activation-retry.json"
ACTIVATION_CLEANUP_NAME = "activation-cleanup.json"
STARTUP_CANDIDATE_NAME = "startup-complete.json"
STARTUP_RETRY_ACK_NAME = "retry-ack.json"
STARTUP_RELEASE_ACK_NAME = "release-ack.json"
RELEASED_RECEIPT_NAME = "released.json"
PUBLISHER_MODULE_PATH = (
    "/usr/local/lib/nemoclaw/runtime_state_mutation_hermes_publisher.py"
)
PUBLISHER_PROTOCOL = "nemoclaw-runtime-state-mutation-publisher-v1"
ACTIVATION_PERMIT_PROTOCOL = "nemoclaw-runtime-state-mutation-activation-permit-v1"
ACTIVATION_RELEASE_PROTOCOL = "nemoclaw-runtime-state-mutation-activation-release-v1"
ACTIVATION_RETRY_PROTOCOL = "nemoclaw-runtime-state-mutation-activation-retry-v1"
ACTIVATION_CLEANUP_PROTOCOL = "nemoclaw-runtime-state-mutation-activation-cleanup-v1"
STARTUP_CANDIDATE_PROTOCOL = "nemoclaw-runtime-state-mutation-startup-complete-v1"
STARTUP_RETRY_ACK_PROTOCOL = "nemoclaw-runtime-state-mutation-retry-ack-v1"
STARTUP_RELEASE_ACK_PROTOCOL = "nemoclaw-runtime-state-mutation-release-ack-v1"
OPENSHELL_ARGV0 = b"/opt/openshell/bin/openshell-sandbox"
NEMOCLAW_START_PATH = b"/usr/local/bin/nemoclaw-start"
BASH_ARGV0 = (b"bash", b"/bin/bash", b"/usr/bin/bash")
HERMES_GATEWAY_PATHS = (b"/usr/local/bin/hermes", b"/usr/local/bin/hermes.real")
HERMES_INTERNAL_PORT = 18642
HERMES_HEALTH_PATH = "/health"
HERMES_CONFIG_GENERATION_PATH = "/sandbox/.hermes/.config-hash"
START_LOG_PATH = b"/tmp/nemoclaw-start.log"
START_LOG_DRAIN_PATHS = (b"tee", b"/usr/bin/tee", b"/bin/tee")
STARTUP_GATE_PYTHON = b"/opt/hermes/.venv/bin/python3"
STARTUP_GATE_HELPER = b"/usr/local/lib/nemoclaw/runtime-state-mutation-startup-gate.py"
TRANSPORT_BROKER_PYTHON = b"/opt/hermes/.venv/bin/python3"
TRANSPORT_BROKER_PATH = (
    b"/usr/local/lib/nemoclaw/runtime-state-mutation-transport-broker.py"
)

HEX_64 = re.compile(r"[0-9a-f]{64}\Z")
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
PROVIDER_ID = re.compile(r"[a-z][a-z0-9-]{0,62}\Z")
RUNTIME_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/=+\-]{0,511}\Z")
MOUNT_NAMESPACE = re.compile(r"mnt:\[[1-9][0-9]*\]\Z")
PID_NAMESPACE = re.compile(r"pid:\[[1-9][0-9]*\]\Z")
NETWORK_NAMESPACE = re.compile(r"net:\[[1-9][0-9]*\]\Z")
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
TOP_LEVEL = re.compile(r"[A-Za-z0-9._-]+\Z")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
PUBLISHER_ERROR_CODE = re.compile(r"[a-z][a-z0-9-]{0,127}\Z")
PHASES = frozenset(("fenced", "published", "rolled-back", "activation-proven"))
ACTIONS = frozenset(
    ("acquire", "assert", "publish", "rollback", "activate", "release", "recover")
)


class ControlError(RuntimeError):
    """A fixed-code, non-sensitive control failure."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class AcquireRequest:
    transaction_id: str
    provider_id: str
    sandbox_name: str
    lifecycle_generation: str
    engine_binding_sha256: str
    runtime_id: str
    runtime_pid: int
    sandbox_identity_sha256: str
    container_mounts_sha256: str
    state_root: str
    state_root_mounts_sha256: str
    plan_sha256: str
    projection_sha256: str
    nonce: str
    plan: dict[str, object]
    canonical_plan: str
    target: str
    rollback: str


@dataclass(frozen=True)
class StatusRequest:
    action: Action
    transaction_id: str
    provider_id: str
    sandbox_name: str
    lifecycle_generation: str
    engine_binding_sha256: str
    runtime_id: str
    runtime_pid: int
    sandbox_identity_sha256: str
    container_mounts_sha256: str
    provider_handle: str | None
    activation_provider_handle: str | None
    completed_ledger_sha256: str | None


Request = AcquireRequest | StatusRequest


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    state: str
    parent_pid: int
    start_identity: str
    uids: tuple[int, int, int, int]
    command: tuple[bytes, ...]
    proc_device: int
    proc_inode: int
    executable_device: int
    executable_inode: int

    def identity_key(self) -> tuple[object, ...]:
        return (
            self.pid,
            self.parent_pid,
            self.start_identity,
            self.uids,
            self.command,
            self.proc_device,
            self.proc_inode,
            self.executable_device,
            self.executable_inode,
        )

    def kernel_task_key(self) -> tuple[object, ...]:
        return (
            self.pid,
            self.start_identity,
            self.proc_device,
            self.proc_inode,
        )

    def executable_key(self) -> tuple[int, int]:
        return (self.executable_device, self.executable_inode)


@dataclass(frozen=True)
class ProcessReference:
    pid: int
    start_identity: str
    parent_pid: int
    uids: tuple[int, int, int, int]
    command_sha256: str
    proc_device: int
    proc_inode: int
    executable_device: int
    executable_inode: int


@dataclass(frozen=True)
class FenceProof:
    supervisor: ProcessReference
    start: ProcessReference
    start_support: tuple[ProcessReference, ...]
    writer_uids: tuple[int, ...]


@dataclass(frozen=True)
class ActivationProof:
    service_pid: int
    service_start_identity: str
    service_uid: int
    configuration_generation: str
    listener_identity: str
    health_sha256: str
    startup_checkpoint_sha256: str
    persistent_pids: tuple[int, ...]
    processes: tuple[ProcessReference, ...]


def _fail(code: str) -> None:
    raise ControlError(code)


def _json_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _fail("duplicate-json-field")
        result[key] = value
    return result


def _bounded_json_integer(value: str) -> int:
    if len(value) > 10:
        _fail("json-integer-out-of-range")
    parsed = int(value, 10)
    if parsed < 0 or parsed > 0x7FFFFFFF:
        _fail("json-integer-out-of-range")
    return parsed


def _reject_json_constant(_value: str) -> None:
    _fail("non-finite-json-number")


def _reject_json_float(_value: str) -> None:
    _fail("json-number-not-integer")


def _parse_json(raw: bytes, maximum: int, invalid_code: str) -> object:
    if not raw or len(raw) > maximum or b"\x00" in raw:
        _fail(invalid_code)
    try:
        text = raw.decode("utf-8", "strict")
        value = json.loads(
            text,
            object_pairs_hook=_json_pairs,
            parse_int=_bounded_json_integer,
            parse_float=_reject_json_float,
            parse_constant=_reject_json_constant,
        )
    except ControlError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError):
        _fail(invalid_code)
    return value


def _read_stdin() -> bytes:
    raw = sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1)
    if len(raw) > MAX_ENVELOPE_BYTES:
        _fail("envelope-too-large")
    return raw


def _exact_keys(
    value: object, expected: tuple[str, ...], code: str
) -> dict[str, object]:
    if not isinstance(value, dict) or tuple(value.keys()) != expected:
        _fail(code)
    return value


def _bounded_string(value: object, pattern: re.Pattern[str], code: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or CONTROL_CHARACTERS.search(value)
        or len(value.encode("utf-8", "strict")) > MAX_STRING_BYTES
        or pattern.fullmatch(value) is None
    ):
        _fail(code)
    return value


def _hex_digest(value: object, code: str) -> str:
    return _bounded_string(value, HEX_64, code)


def _decimal_identity(value: object, code: str) -> str:
    return _bounded_string(value, DECIMAL, code)


def _canonical_relative_path(value: object, code: str) -> str:
    if not isinstance(value, str):
        _fail(code)
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeEncodeError:
        _fail(code)
    if (
        not value
        or len(encoded) > 512
        or value.startswith("/")
        or "\\" in value
        or CONTROL_CHARACTERS.search(value)
        or os.path.normpath(value) != value
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        _fail(code)
    return value


def _string_array(value: object, code: str, normalize) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_SELECTORS:
        _fail(code)
    result = [normalize(item, code) for item in value]
    if result != sorted(result, key=lambda item: item.encode("utf-8")) or len(
        set(result)
    ) != len(result):
        _fail(code)
    return result


def _top_level(value: object, code: str) -> str:
    return _bounded_string(value, TOP_LEVEL, code)


def _writable_subpath(value: object, code: str) -> str:
    path = _canonical_relative_path(value, code)
    parts = path.split("/")
    if (
        len(parts) < 2
        or any("*" in part and part != "*" for part in parts)
        or parts[-1] == "*"
    ):
        _fail(code)
    return path


def _writable_patterns_overlap(first: str, second: str) -> bool:
    left = first.split("/")
    right = second.split("/")
    return all(
        a == "*" or b == "*" or a == b for a, b in zip(left, right, strict=False)
    )


def _normalize_state_lock_plan(value: object) -> dict[str, object]:
    plan = _exact_keys(
        value,
        (
            "version",
            "readOnlyRoots",
            "confidentialRoots",
            "readOnlyPrefixes",
            "confidentialPrefixes",
            "writableSubpaths",
        ),
        "state-lock-plan-schema",
    )
    if type(plan["version"]) is not int or plan["version"] != 1:
        _fail("state-lock-plan-version")
    read_only_roots = _string_array(
        plan["readOnlyRoots"], "state-lock-plan-roots", _top_level
    )
    confidential_roots = _string_array(
        plan["confidentialRoots"], "state-lock-plan-roots", _top_level
    )
    read_only_prefixes = _string_array(
        plan["readOnlyPrefixes"], "state-lock-plan-prefixes", _top_level
    )
    confidential_prefixes = _string_array(
        plan["confidentialPrefixes"], "state-lock-plan-prefixes", _top_level
    )
    writable_subpaths = _string_array(
        plan["writableSubpaths"], "state-lock-plan-writable", _writable_subpath
    )
    roots = read_only_roots + confidential_roots
    prefixes = read_only_prefixes + confidential_prefixes
    if len(set(roots)) != len(roots) or len(set(prefixes)) != len(prefixes):
        _fail("state-lock-plan-policy-overlap")
    if any(root.startswith(prefix) for root in roots for prefix in prefixes):
        _fail("state-lock-plan-policy-overlap")
    for index, prefix in enumerate(prefixes):
        if any(
            prefix.startswith(other) or other.startswith(prefix)
            for other in prefixes[index + 1 :]
        ):
            _fail("state-lock-plan-policy-overlap")
    if any(path.split("/", 1)[0] not in read_only_roots for path in writable_subpaths):
        _fail("state-lock-plan-writable")
    for index, pattern in enumerate(writable_subpaths):
        if any(
            _writable_patterns_overlap(pattern, other)
            for other in writable_subpaths[index + 1 :]
        ):
            _fail("state-lock-plan-writable-overlap")
    return {
        "version": 1,
        "readOnlyRoots": read_only_roots,
        "confidentialRoots": confidential_roots,
        "readOnlyPrefixes": read_only_prefixes,
        "confidentialPrefixes": confidential_prefixes,
        "writableSubpaths": writable_subpaths,
    }


def _normalize_plan(
    value: object, state_root: str, projection: str
) -> dict[str, object]:
    plan = _exact_keys(
        value,
        (
            "schemaVersion",
            "intent",
            "target",
            "rollback",
            "stateLockPlan",
            "stateRoot",
            "selectors",
            "projectionSha256",
        ),
        "plan-schema",
    )
    if (
        type(plan["schemaVersion"]) is not int
        or plan["schemaVersion"] != PLAN_SCHEMA_VERSION
    ):
        _fail("plan-version")
    if plan["intent"] != "protection-transition":
        _fail("plan-intent")
    target = plan["target"]
    rollback = plan["rollback"]
    if target not in ("locked", "mutable") or rollback not in ("locked", "mutable"):
        _fail("plan-posture")
    if target == rollback:
        _fail("plan-posture")
    if plan["stateRoot"] != state_root or plan["projectionSha256"] != projection:
        _fail("plan-binding")
    state_lock_plan = _normalize_state_lock_plan(plan["stateLockPlan"])
    selectors_value = plan["selectors"]
    if (
        not isinstance(selectors_value, list)
        or not selectors_value
        or len(selectors_value) > MAX_SELECTORS
    ):
        _fail("plan-selectors")
    selectors: list[dict[str, str]] = []
    identities: list[str] = []
    for selector_value in selectors_value:
        if not isinstance(selector_value, dict) or selector_value.get("kind") not in (
            "path",
            "prefix",
        ):
            _fail("plan-selector-schema")
        if selector_value["kind"] == "path":
            selector = _exact_keys(
                selector_value, ("kind", "path"), "plan-selector-schema"
            )
            path = _canonical_relative_path(selector["path"], "plan-selector-path")
            selectors.append({"kind": "path", "path": path})
            identities.append(f"path:{path}")
        else:
            selector = _exact_keys(
                selector_value, ("kind", "prefix"), "plan-selector-schema"
            )
            prefix = _top_level(selector["prefix"], "plan-selector-prefix")
            selectors.append({"kind": "prefix", "prefix": prefix})
            identities.append(f"prefix:{prefix}")
    if identities != sorted(identities, key=lambda item: item.encode("utf-8")) or len(
        set(identities)
    ) != len(identities):
        _fail("plan-selector-order")
    required = [
        *(f"path:{item}" for item in state_lock_plan["readOnlyRoots"]),
        *(f"path:{item}" for item in state_lock_plan["confidentialRoots"]),
        *(f"prefix:{item}" for item in state_lock_plan["readOnlyPrefixes"]),
        *(f"prefix:{item}" for item in state_lock_plan["confidentialPrefixes"]),
    ]
    if any(identity not in identities for identity in required):
        _fail("plan-selector-scope")
    return {
        "schemaVersion": PLAN_SCHEMA_VERSION,
        "intent": "protection-transition",
        "target": target,
        "rollback": rollback,
        "stateLockPlan": state_lock_plan,
        "stateRoot": state_root,
        "selectors": selectors,
        "projectionSha256": projection,
    }


def _json_bytes(value: object) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8", "strict"
        )
    except (TypeError, ValueError, UnicodeEncodeError):
        _fail("json-serialization")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


ACQUIRE_KEYS = (
    "schemaVersion",
    "action",
    "transactionId",
    "providerId",
    "sandboxName",
    "lifecycleGeneration",
    "engineBindingSha256",
    "runtimeId",
    "runtimePid",
    "sandboxIdentitySha256",
    "containerMountsSha256",
    "stateRoot",
    "stateRootMountsSha256",
    "plan",
    "planSha256",
    "projectionSha256",
    "nonce",
    "target",
    "rollback",
)

STATUS_KEYS = (
    "schemaVersion",
    "action",
    "transactionId",
    "providerId",
    "sandboxName",
    "lifecycleGeneration",
    "engineBindingSha256",
    "runtimeId",
    "runtimePid",
    "sandboxIdentitySha256",
    "containerMountsSha256",
)

MARKER_KEYS = (
    "schemaVersion",
    "phase",
    "transactionId",
    "providerId",
    "sandboxName",
    "lifecycleGeneration",
    "engineBindingSha256",
    "runtimeId",
    "runtimePid",
    "sandboxIdentitySha256",
    "containerMountsSha256",
    "stateRoot",
    "stateRootMountsSha256",
    "mountNamespace",
    "stateRootDevice",
    "stateRootInode",
    "plan",
    "planSha256",
    "projectionSha256",
    "nonce",
    "target",
    "rollback",
    "fence",
    "activation",
)

RELEASED_RECEIPT_KEYS = (
    "schemaVersion",
    "releaseState",
    "transactionId",
    "providerHandle",
    "activationProviderHandle",
    "completedLedgerSha256",
    "marker",
)

PROVIDER_HANDLE = re.compile(
    r"([a-z][a-z0-9-]{0,62})-state-mutation-v1:([0-9a-f]{64}):([0-9a-f]{64})\Z"
)
ACTIVATION_PROVIDER_HANDLE = re.compile(
    r"([a-z][a-z0-9-]{0,62})-state-mutation-activation-v1:([0-9a-f]{64}):([0-9a-f]{64})\Z"
)


def _canonical_state_root(value: object) -> str:
    if not isinstance(value, str):
        _fail("state-root")
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeEncodeError:
        _fail("state-root")
    if (
        not value.startswith("/sandbox/")
        or value.endswith("/")
        or "\\" in value
        or CONTROL_CHARACTERS.search(value)
        or len(encoded) > MAX_STRING_BYTES
        or os.path.normpath(value) != value
    ):
        _fail("state-root")
    if value != SUPPORTED_STATE_ROOT:
        _fail("state-root-unsupported")
    return value


def _positive_integer(value: object, code: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        _fail(code)
    return value


def _runtime_state_sha256(request: AcquireRequest) -> str:
    return _sha256(
        _json_bytes(
            {
                "schemaVersion": SCHEMA_VERSION,
                "providerId": request.provider_id,
                "sandboxName": request.sandbox_name,
                "lifecycleGeneration": request.lifecycle_generation,
                "engineBindingSha256": request.engine_binding_sha256,
                "runtimeId": request.runtime_id,
                "runtimePid": request.runtime_pid,
                "sandboxIdentitySha256": request.sandbox_identity_sha256,
                "containerMountsSha256": request.container_mounts_sha256,
                "stateRoot": request.state_root,
                "stateRootMountsSha256": request.state_root_mounts_sha256,
            }
        )
    )


def _expected_transaction_id(request: AcquireRequest) -> str:
    return _sha256(
        _json_bytes(
            {
                "schemaVersion": SCHEMA_VERSION,
                "action": "state-mutation",
                "runtimeStateSha256": _runtime_state_sha256(request),
                "planSha256": request.plan_sha256,
                "projectionSha256": request.projection_sha256,
                "nonce": request.nonce,
                "target": request.target,
                "rollback": request.rollback,
            }
        )
    )


def _parse_request(action: Action, raw: bytes) -> Request:
    value = _parse_json(raw, MAX_ENVELOPE_BYTES, "invalid-envelope-json")
    expected = ACQUIRE_KEYS if action == "acquire" else STATUS_KEYS
    if action not in ("acquire", "recover"):
        expected += ("providerHandle",)
    if action == "release":
        expected += ("activationProviderHandle", "completedLedgerSha256")
    envelope = _exact_keys(value, expected, "envelope-schema")
    if (
        type(envelope["schemaVersion"]) is not int
        or envelope["schemaVersion"] != SCHEMA_VERSION
        or envelope["action"] != action
    ):
        _fail("envelope-version")
    transaction_id = _hex_digest(envelope["transactionId"], "transaction-id")
    provider_id = _bounded_string(envelope["providerId"], PROVIDER_ID, "provider-id")
    sandbox_name = _bounded_string(envelope["sandboxName"], SAFE_NAME, "sandbox-name")
    lifecycle_generation = _bounded_string(
        envelope["lifecycleGeneration"], RUNTIME_ID, "lifecycle-generation"
    )
    engine_binding_sha256 = _hex_digest(
        envelope["engineBindingSha256"], "engine-binding-digest"
    )
    runtime_id = _hex_digest(envelope["runtimeId"], "runtime-id")
    runtime_pid = _positive_integer(envelope["runtimePid"], "runtime-pid")
    sandbox_identity_sha256 = _hex_digest(
        envelope["sandboxIdentitySha256"], "sandbox-identity-digest"
    )
    container_mounts_sha256 = _hex_digest(
        envelope["containerMountsSha256"], "container-mounts-digest"
    )
    common: dict[str, object] = {
        "schemaVersion": SCHEMA_VERSION,
        "action": action,
        "transactionId": transaction_id,
        "providerId": provider_id,
        "sandboxName": sandbox_name,
        "lifecycleGeneration": lifecycle_generation,
        "engineBindingSha256": engine_binding_sha256,
        "runtimeId": runtime_id,
        "runtimePid": runtime_pid,
        "sandboxIdentitySha256": sandbox_identity_sha256,
        "containerMountsSha256": container_mounts_sha256,
    }
    if action != "acquire":
        provider_handle = (
            _bounded_string(
                envelope["providerHandle"], PROVIDER_HANDLE, "provider-handle"
            )
            if action != "recover"
            else None
        )
        if provider_handle is not None:
            provider_match = PROVIDER_HANDLE.fullmatch(provider_handle)
            if provider_match is None or not secrets.compare_digest(
                provider_match.group(1), provider_id
            ):
                _fail("provider-handle")
        activation_provider_handle = (
            _bounded_string(
                envelope["activationProviderHandle"],
                ACTIVATION_PROVIDER_HANDLE,
                "activation-provider-handle",
            )
            if action == "release"
            else None
        )
        if activation_provider_handle is not None:
            activation_match = ACTIVATION_PROVIDER_HANDLE.fullmatch(
                activation_provider_handle
            )
            if activation_match is None or not secrets.compare_digest(
                activation_match.group(1), provider_id
            ):
                _fail("activation-provider-handle")
        completed = (
            _hex_digest(envelope["completedLedgerSha256"], "completed-ledger-digest")
            if action == "release"
            else None
        )
        normalized = {
            **common,
            **(
                {"providerHandle": provider_handle}
                if provider_handle is not None
                else {}
            ),
            **(
                {
                    "activationProviderHandle": activation_provider_handle,
                    "completedLedgerSha256": completed,
                }
                if action == "release"
                else {}
            ),
        }
        if raw != _json_bytes(normalized) + b"\n":
            _fail("envelope-not-canonical")
        return StatusRequest(
            action,
            transaction_id,
            provider_id,
            sandbox_name,
            lifecycle_generation,
            engine_binding_sha256,
            runtime_id,
            runtime_pid,
            sandbox_identity_sha256,
            container_mounts_sha256,
            provider_handle,
            activation_provider_handle,
            completed,
        )

    state_root = _canonical_state_root(envelope["stateRoot"])
    state_root_mounts_sha256 = _hex_digest(
        envelope["stateRootMountsSha256"], "state-root-mounts-digest"
    )
    plan_sha256 = _hex_digest(envelope["planSha256"], "plan-digest")
    projection_sha256 = _hex_digest(envelope["projectionSha256"], "projection-digest")
    nonce = _hex_digest(envelope["nonce"], "nonce")
    if not isinstance(envelope["plan"], str):
        _fail("plan-transport")
    plan_transport = envelope["plan"].encode("utf-8", "strict")
    if not plan_transport or len(plan_transport) > MAX_PLAN_BYTES:
        _fail("plan-transport")
    plan_value = _parse_json(plan_transport, MAX_PLAN_BYTES, "invalid-plan-json")
    plan = _normalize_plan(plan_value, state_root, projection_sha256)
    canonical_plan = _json_bytes(plan).decode("utf-8", "strict")
    if envelope["plan"] != canonical_plan or _sha256(plan_transport) != plan_sha256:
        _fail("plan-digest-mismatch")
    target = envelope["target"]
    rollback = envelope["rollback"]
    if (
        target not in ("locked", "mutable")
        or rollback not in ("locked", "mutable")
        or target == rollback
        or plan["target"] != target
        or plan["rollback"] != rollback
    ):
        _fail("plan-posture")
    normalized = {
        **common,
        "stateRoot": state_root,
        "stateRootMountsSha256": state_root_mounts_sha256,
        "plan": canonical_plan,
        "planSha256": plan_sha256,
        "projectionSha256": projection_sha256,
        "nonce": nonce,
        "target": target,
        "rollback": rollback,
    }
    if raw != _json_bytes(normalized) + b"\n":
        _fail("envelope-not-canonical")
    request = AcquireRequest(
        transaction_id,
        provider_id,
        sandbox_name,
        lifecycle_generation,
        engine_binding_sha256,
        runtime_id,
        runtime_pid,
        sandbox_identity_sha256,
        container_mounts_sha256,
        state_root,
        state_root_mounts_sha256,
        plan_sha256,
        projection_sha256,
        nonce,
        plan,
        canonical_plan,
        str(target),
        str(rollback),
    )
    if not secrets.compare_digest(
        request.transaction_id, _expected_transaction_id(request)
    ):
        _fail("transaction-binding-mismatch")
    return request


PROCESS_REFERENCE_KEYS = (
    "pid",
    "startIdentity",
    "parentPid",
    "uids",
    "commandSha256",
    "procDevice",
    "procInode",
    "executableDevice",
    "executableInode",
)

FENCE_KEYS = ("supervisor", "start", "startSupport", "writerUids")
ACTIVATION_PERMIT_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "markerSha256",
    "start",
    "candidateDirectory",
)
ACTIVATION_RELEASE_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "checkpointSha256",
    "start",
    "candidateDirectory",
)
ACTIVATION_RETRY_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "permitSha256",
    "checkpointSha256",
    "start",
    "candidateDirectory",
)
ACTIVATION_CLEANUP_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "start",
    "candidateDirectory",
)
STARTUP_CANDIDATE_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "markerSha256",
    "start",
)
STARTUP_RETRY_ACK_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "retrySha256",
    "start",
)
STARTUP_RELEASE_ACK_KEYS = (
    "schemaVersion",
    "protocol",
    "transactionId",
    "nonce",
    "releaseSha256",
    "start",
)


def _process_command_sha256(command: tuple[bytes, ...]) -> str:
    framed = b"".join(len(part).to_bytes(4, "big") + part for part in command)
    return _sha256(framed)


def _process_reference(process: ProcessIdentity) -> ProcessReference:
    return ProcessReference(
        process.pid,
        process.start_identity,
        process.parent_pid,
        process.uids,
        _process_command_sha256(process.command),
        process.proc_device,
        process.proc_inode,
        process.executable_device,
        process.executable_inode,
    )


def _process_reference_payload(reference: ProcessReference) -> dict[str, object]:
    return {
        "pid": reference.pid,
        "startIdentity": reference.start_identity,
        "parentPid": reference.parent_pid,
        "uids": list(reference.uids),
        "commandSha256": reference.command_sha256,
        "procDevice": str(reference.proc_device),
        "procInode": str(reference.proc_inode),
        "executableDevice": str(reference.executable_device),
        "executableInode": str(reference.executable_inode),
    }


def _process_reference_from_value(value: object, code: str) -> ProcessReference:
    reference = _exact_keys(value, PROCESS_REFERENCE_KEYS, code)
    pid = _positive_integer(reference["pid"], code)
    parent_pid = reference["parentPid"]
    uids = reference["uids"]
    if (
        type(parent_pid) is not int
        or parent_pid < 0
        or not isinstance(uids, list)
        or len(uids) != 4
        or any(type(uid) is not int or uid < 0 for uid in uids)
    ):
        _fail(code)
    start_identity = _decimal_identity(reference["startIdentity"], code)
    command_sha256 = _hex_digest(reference["commandSha256"], code)
    proc_device = _decimal_identity(reference["procDevice"], code)
    proc_inode = _decimal_identity(reference["procInode"], code)
    executable_device = _decimal_identity(reference["executableDevice"], code)
    executable_inode = _decimal_identity(reference["executableInode"], code)
    if (
        proc_device == "0"
        or proc_inode == "0"
        or executable_device == "0"
        or executable_inode == "0"
    ):
        _fail(code)
    return ProcessReference(
        pid,
        start_identity,
        parent_pid,
        tuple(uids),  # type: ignore[arg-type]
        command_sha256,
        int(proc_device, 10),
        int(proc_inode, 10),
        int(executable_device, 10),
        int(executable_inode, 10),
    )


def _fence_payload(fence: FenceProof) -> dict[str, object]:
    return {
        "supervisor": _process_reference_payload(fence.supervisor),
        "start": _process_reference_payload(fence.start),
        "startSupport": [
            _process_reference_payload(reference)
            for reference in fence.start_support
        ],
        "writerUids": list(fence.writer_uids),
    }


def _fence_from_value(value: object, code: str = "fence-marker-invalid") -> FenceProof:
    fence = _exact_keys(value, FENCE_KEYS, code)
    supervisor = _process_reference_from_value(fence["supervisor"], code)
    start = _process_reference_from_value(fence["start"], code)
    start_support = fence["startSupport"]
    writer_uids = fence["writerUids"]
    if (
        supervisor.pid != 1
        or supervisor.parent_pid != 0
        or supervisor.uids != (ROOT_UID,) * 4
        or start.pid <= 1
        or start.parent_pid != 1
        or not isinstance(start_support, list)
        or len(start_support) != 2
        or not isinstance(writer_uids, list)
        or not writer_uids
        or len(writer_uids) > len(SUPPORTED_WRITER_ACCOUNTS)
        or any(type(uid) is not int or uid <= 0 for uid in writer_uids)
        or writer_uids != sorted(set(writer_uids))
        or not any(uid in writer_uids for uid in start.uids)
    ):
        _fail(code)
    support = tuple(
        _process_reference_from_value(reference, code)
        for reference in start_support
    )
    if (
        tuple(sorted(reference.pid for reference in support))
        != tuple(reference.pid for reference in support)
        or len({reference.pid for reference in support}) != 2
        or any(
            reference.parent_pid != start.pid
            or reference.uids != start.uids
            or not any(uid in writer_uids for uid in reference.uids)
            for reference in support
        )
    ):
        _fail(code)
    return FenceProof(supervisor, start, support, tuple(writer_uids))


def _startup_candidate_directory(marker: dict[str, object]) -> str:
    return os.path.join(STARTUP_HANDOFF_DIRECTORY, str(marker["nonce"]))


def _activation_permit_payload(
    marker: dict[str, object], fence: FenceProof
) -> dict[str, object]:
    marker_binding = {
        key: value
        for key, value in marker.items()
        if key not in ("phase", "activation")
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": ACTIVATION_PERMIT_PROTOCOL,
        "transactionId": marker["transactionId"],
        "nonce": marker["nonce"],
        "markerSha256": _sha256(_json_bytes(marker_binding) + b"\n"),
        "start": _process_reference_payload(fence.start),
        "candidateDirectory": _startup_candidate_directory(marker),
    }


def _startup_candidate_payload(
    marker: dict[str, object], fence: FenceProof
) -> dict[str, object]:
    permit = _activation_permit_payload(marker, fence)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": STARTUP_CANDIDATE_PROTOCOL,
        "transactionId": marker["transactionId"],
        "nonce": marker["nonce"],
        "markerSha256": permit["markerSha256"],
        "start": permit["start"],
    }


def _activation_release_payload(
    marker: dict[str, object], fence: FenceProof, activation: ActivationProof
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": ACTIVATION_RELEASE_PROTOCOL,
        "transactionId": marker["transactionId"],
        "nonce": marker["nonce"],
        "checkpointSha256": activation.startup_checkpoint_sha256,
        "start": _process_reference_payload(fence.start),
        "candidateDirectory": _startup_candidate_directory(marker),
    }


def _activation_retry_payload(
    marker: dict[str, object],
    fence: FenceProof,
    permit_payload: bytes,
    checkpoint_payload: bytes | None,
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": ACTIVATION_RETRY_PROTOCOL,
        "transactionId": marker["transactionId"],
        "nonce": marker["nonce"],
        "permitSha256": _sha256(permit_payload),
        "checkpointSha256": (
            _sha256(checkpoint_payload) if checkpoint_payload is not None else None
        ),
        "start": _process_reference_payload(fence.start),
        "candidateDirectory": _startup_candidate_directory(marker),
    }


def _activation_cleanup_payload(
    marker: dict[str, object], fence: FenceProof
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": ACTIVATION_CLEANUP_PROTOCOL,
        "transactionId": marker["transactionId"],
        "nonce": marker["nonce"],
        "start": _process_reference_payload(fence.start),
        "candidateDirectory": _startup_candidate_directory(marker),
    }


def _startup_retry_ack_payload(
    marker: dict[str, object], fence: FenceProof, retry_payload: bytes
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": STARTUP_RETRY_ACK_PROTOCOL,
        "transactionId": marker["transactionId"],
        "nonce": marker["nonce"],
        "retrySha256": _sha256(retry_payload),
        "start": _process_reference_payload(fence.start),
    }


def _startup_release_ack_payload(
    marker: dict[str, object], fence: FenceProof, release_payload: bytes
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": STARTUP_RELEASE_ACK_PROTOCOL,
        "transactionId": marker["transactionId"],
        "nonce": marker["nonce"],
        "releaseSha256": _sha256(release_payload),
        "start": _process_reference_payload(fence.start),
    }


def _marker_payload(
    request: AcquireRequest,
    phase: Phase,
    mount_namespace: str,
    state_root_device: str,
    state_root_inode: str,
    fence: dict[str, object],
    activation: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "phase": phase,
        "transactionId": request.transaction_id,
        "providerId": request.provider_id,
        "sandboxName": request.sandbox_name,
        "lifecycleGeneration": request.lifecycle_generation,
        "engineBindingSha256": request.engine_binding_sha256,
        "runtimeId": request.runtime_id,
        "runtimePid": request.runtime_pid,
        "sandboxIdentitySha256": request.sandbox_identity_sha256,
        "containerMountsSha256": request.container_mounts_sha256,
        "stateRoot": request.state_root,
        "stateRootMountsSha256": request.state_root_mounts_sha256,
        "mountNamespace": mount_namespace,
        "stateRootDevice": state_root_device,
        "stateRootInode": state_root_inode,
        "plan": request.canonical_plan,
        "planSha256": request.plan_sha256,
        "projectionSha256": request.projection_sha256,
        "nonce": request.nonce,
        "target": request.target,
        "rollback": request.rollback,
        "fence": fence,
        "activation": activation,
    }


def _validate_marker(value: object) -> dict[str, object]:
    marker = _exact_keys(value, MARKER_KEYS, "marker-schema")
    if (
        type(marker["schemaVersion"]) is not int
        or marker["schemaVersion"] != SCHEMA_VERSION
        or marker["phase"] not in PHASES
    ):
        _fail("marker-schema")
    provider_id = _bounded_string(marker["providerId"], PROVIDER_ID, "marker-schema")
    transaction_id = _hex_digest(marker["transactionId"], "marker-schema")
    sandbox_name = _bounded_string(marker["sandboxName"], SAFE_NAME, "marker-schema")
    lifecycle_generation = _bounded_string(
        marker["lifecycleGeneration"], RUNTIME_ID, "marker-schema"
    )
    engine_binding_sha256 = _hex_digest(marker["engineBindingSha256"], "marker-schema")
    runtime_id = _hex_digest(marker["runtimeId"], "marker-schema")
    runtime_pid = _positive_integer(marker["runtimePid"], "marker-schema")
    sandbox_identity_sha256 = _hex_digest(
        marker["sandboxIdentitySha256"], "marker-schema"
    )
    container_mounts_sha256 = _hex_digest(
        marker["containerMountsSha256"], "marker-schema"
    )
    state_root = _canonical_state_root(marker["stateRoot"])
    state_root_mounts_sha256 = _hex_digest(
        marker["stateRootMountsSha256"], "marker-schema"
    )
    mount_namespace = _bounded_string(
        marker["mountNamespace"], MOUNT_NAMESPACE, "marker-schema"
    )
    state_root_device = _decimal_identity(marker["stateRootDevice"], "marker-schema")
    state_root_inode = _decimal_identity(marker["stateRootInode"], "marker-schema")
    if state_root_device == "0" or state_root_inode == "0":
        _fail("marker-schema")
    projection_sha256 = _hex_digest(marker["projectionSha256"], "marker-schema")
    plan_sha256 = _hex_digest(marker["planSha256"], "marker-schema")
    nonce = _hex_digest(marker["nonce"], "marker-schema")
    if not isinstance(marker["plan"], str):
        _fail("marker-schema")
    plan_transport = marker["plan"].encode("utf-8", "strict")
    plan = _normalize_plan(
        _parse_json(plan_transport, MAX_PLAN_BYTES, "marker-schema"),
        state_root,
        projection_sha256,
    )
    canonical_plan = _json_bytes(plan).decode("utf-8", "strict")
    if canonical_plan != marker["plan"] or _sha256(plan_transport) != plan_sha256:
        _fail("marker-schema")
    target = marker["target"]
    rollback = marker["rollback"]
    if target != plan["target"] or rollback != plan["rollback"]:
        _fail("marker-schema")
    fence = _fence_from_value(marker["fence"], "marker-schema")
    request = AcquireRequest(
        transaction_id,
        provider_id,
        sandbox_name,
        lifecycle_generation,
        engine_binding_sha256,
        runtime_id,
        runtime_pid,
        sandbox_identity_sha256,
        container_mounts_sha256,
        state_root,
        state_root_mounts_sha256,
        plan_sha256,
        projection_sha256,
        nonce,
        plan,
        canonical_plan,
        str(target),
        str(rollback),
    )
    if not secrets.compare_digest(transaction_id, _expected_transaction_id(request)):
        _fail("marker-schema")
    activation = marker["activation"]
    if marker["phase"] == "activation-proven":
        if activation is None:
            _fail("marker-schema")
        activation = _activation_payload(_activation_from_marker(marker))  # type: ignore[arg-type]
    elif marker["phase"] == "rolled-back" and activation is not None:
        activation = _activation_payload(_activation_from_marker(marker))  # type: ignore[arg-type]
    elif activation is not None:
        _fail("marker-schema")
    return _marker_payload(
        request,
        marker["phase"],  # type: ignore[arg-type]
        mount_namespace,
        state_root_device,
        state_root_inode,
        _fence_payload(fence),
        activation,  # type: ignore[arg-type]
    )


def _base_receipt(
    marker: dict[str, object], phase: Phase | None = None
) -> dict[str, object]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "phase": marker["phase"] if phase is None else phase,
        "transactionId": marker["transactionId"],
        "providerId": marker["providerId"],
        "sandboxName": marker["sandboxName"],
        "lifecycleGeneration": marker["lifecycleGeneration"],
        "engineBindingSha256": marker["engineBindingSha256"],
        "runtimeId": marker["runtimeId"],
        "runtimePid": marker["runtimePid"],
        "sandboxIdentitySha256": marker["sandboxIdentitySha256"],
        "containerMountsSha256": marker["containerMountsSha256"],
        "stateRoot": marker["stateRoot"],
        "stateRootMountsSha256": marker["stateRootMountsSha256"],
        "mountNamespace": marker["mountNamespace"],
        "stateRootDevice": marker["stateRootDevice"],
        "stateRootInode": marker["stateRootInode"],
        "planSha256": marker["planSha256"],
        "projectionSha256": marker["projectionSha256"],
        "nonce": marker["nonce"],
        "target": marker["target"],
        "rollback": marker["rollback"],
    }


def _provider_handle(marker: dict[str, object]) -> str:
    return (
        f"{marker['providerId']}-state-mutation-v1:{marker['transactionId']}:"
        f"{_sha256(_json_bytes(_base_receipt(marker, 'fenced')))}"
    )


def _activation_provider_handle(marker: dict[str, object]) -> str:
    activation = marker["activation"]
    if not isinstance(activation, dict):
        _fail("activation-marker-invalid")
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "providerId": marker["providerId"],
        "sandboxName": marker["sandboxName"],
        "lifecycleGeneration": marker["lifecycleGeneration"],
        "runtimeId": marker["runtimeId"],
        "nonce": marker["nonce"],
        "configurationGeneration": activation["configurationGeneration"],
        "listenerIdentity": activation["listenerIdentity"],
        "healthSha256": activation["healthSha256"],
        "fenceProviderHandle": _provider_handle(marker),
    }
    return (
        f"{marker['providerId']}-state-mutation-activation-v1:{marker['transactionId']}:"
        f"{_sha256(_json_bytes(payload))}"
    )


def _receipt_payload(marker: dict[str, object]) -> dict[str, object]:
    receipt = _base_receipt(marker)
    if marker["phase"] == "activation-proven":
        activation = marker["activation"]
        if not isinstance(activation, dict):
            _fail("activation-marker-invalid")
        receipt.update(
            {
                "configurationGeneration": activation["configurationGeneration"],
                "listenerIdentity": activation["listenerIdentity"],
                "healthSha256": activation["healthSha256"],
                "activationProviderHandle": _activation_provider_handle(marker),
            }
        )
    return receipt


def _released_receipt_payload(
    marker: dict[str, object], completed_ledger_sha256: str, release_state: str
) -> dict[str, object]:
    if release_state not in ("intent", "acknowledged", "complete"):
        _fail("released-receipt-invalid")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "releaseState": release_state,
        "transactionId": marker["transactionId"],
        "providerHandle": _provider_handle(marker),
        "activationProviderHandle": _activation_provider_handle(marker),
        "completedLedgerSha256": completed_ledger_sha256,
        "marker": marker,
    }


def _validate_released_receipt(value: object) -> dict[str, object]:
    receipt = _exact_keys(value, RELEASED_RECEIPT_KEYS, "released-receipt-invalid")
    if (
        type(receipt["schemaVersion"]) is not int
        or receipt["schemaVersion"] != SCHEMA_VERSION
        or receipt["releaseState"] not in ("intent", "acknowledged", "complete")
    ):
        _fail("released-receipt-invalid")
    marker = _validate_marker(receipt["marker"])
    if marker["phase"] != "activation-proven":
        _fail("released-receipt-invalid")
    completed = _hex_digest(
        receipt["completedLedgerSha256"], "released-receipt-invalid"
    )
    expected = _released_receipt_payload(
        marker, completed, str(receipt["releaseState"])
    )
    if not secrets.compare_digest(_json_bytes(receipt), _json_bytes(expected)):
        _fail("released-receipt-invalid")
    return expected


def _marker_matches_acquire(marker: dict[str, object], request: AcquireRequest) -> bool:
    expected = _marker_payload(
        request,
        marker["phase"],  # type: ignore[arg-type]
        str(marker["mountNamespace"]),
        str(marker["stateRootDevice"]),
        str(marker["stateRootInode"]),
        marker["fence"],  # type: ignore[arg-type]
        marker["activation"] if isinstance(marker["activation"], dict) else None,
    )
    return secrets.compare_digest(_json_bytes(marker), _json_bytes(expected))


def _marker_matches_status(marker: dict[str, object], request: StatusRequest) -> bool:
    matches = (
        marker["transactionId"] == request.transaction_id
        and marker["providerId"] == request.provider_id
        and marker["sandboxName"] == request.sandbox_name
        and marker["lifecycleGeneration"] == request.lifecycle_generation
        and marker["engineBindingSha256"] == request.engine_binding_sha256
        and marker["runtimeId"] == request.runtime_id
        and marker["runtimePid"] == request.runtime_pid
        and marker["sandboxIdentitySha256"] == request.sandbox_identity_sha256
        and marker["containerMountsSha256"] == request.container_mounts_sha256
    )
    if not matches:
        return False
    return request.provider_handle is None or secrets.compare_digest(
        request.provider_handle, _provider_handle(marker)
    )


def _directory_flags() -> int:
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _open_absolute_directory(path: str) -> int:
    if not path.startswith("/") or os.path.normpath(path) != path:
        _fail("unsafe-directory")
    current = os.open("/", _directory_flags())
    try:
        for component in path.split("/")[1:]:
            next_fd = os.open(component, _directory_flags(), dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except OSError:
        os.close(current)
        _fail("unsafe-directory")


def _open_or_create_directory(path: str, mode: int) -> int:
    parent, name = os.path.split(path)
    parent_fd = _open_absolute_directory(parent)
    try:
        try:
            os.mkdir(name, mode, dir_fd=parent_fd)
            os.fsync(parent_fd)
        except FileExistsError:
            pass
        directory_fd = os.open(name, _directory_flags(), dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    metadata = os.fstat(directory_fd)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != ROOT_UID
        or metadata.st_gid != ROOT_GID
        or stat.S_IMODE(metadata.st_mode) != mode
    ):
        os.close(directory_fd)
        _fail("unsafe-control-directory")
    return directory_fd


def _open_or_create_private_directory(path: str) -> int:
    return _open_or_create_directory(path, 0o700)


def _verify_control_parent(directory_fd: int, *, searchable: bool = False) -> None:
    metadata = os.fstat(directory_fd)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != ROOT_UID
        or metadata.st_gid != ROOT_GID
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or (searchable and not stat.S_IMODE(metadata.st_mode) & 0o001)
    ):
        _fail("unsafe-control-parent")


def _open_control_directories() -> tuple[int, int]:
    # The stable parents are image/OS owned.  Only the controller leaves are
    # created here, and each leaf is descriptor-opened without following links.
    durable_parent = os.path.dirname(DURABLE_DIRECTORY)
    runtime_parent = os.path.dirname(RUNTIME_DIRECTORY)
    for parent, created_mode, searchable in (
        (durable_parent, DURABLE_PARENT_MODE, True),
        (runtime_parent, 0o755, False),
    ):
        try:
            parent_fd = _open_absolute_directory(parent)
        except ControlError:
            # Create only the fixed NemoClaw parent, never an arbitrary path.
            grandparent, leaf = os.path.split(parent)
            grandparent_fd = _open_absolute_directory(grandparent)
            try:
                try:
                    os.mkdir(leaf, created_mode, dir_fd=grandparent_fd)
                    os.fsync(grandparent_fd)
                except FileExistsError:
                    pass
            finally:
                os.close(grandparent_fd)
        else:
            _verify_control_parent(parent_fd, searchable=searchable)
            os.close(parent_fd)
            continue
        parent_fd = _open_absolute_directory(parent)
        try:
            _verify_control_parent(parent_fd, searchable=searchable)
        finally:
            os.close(parent_fd)
    return (
        _open_or_create_directory(DURABLE_DIRECTORY, DURABLE_DIRECTORY_MODE),
        _open_or_create_directory(RUNTIME_DIRECTORY, RUNTIME_DIRECTORY_MODE),
    )


def _open_lock(directory_fd: int) -> int:
    fd = os.open(
        LOCK_NAME,
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=directory_fd,
    )
    metadata = os.fstat(fd)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != ROOT_UID
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_nlink != 1
    ):
        os.close(fd)
        _fail("unsafe-control-lock")
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def _read_control_file(
    directory_fd: int, name: str, maximum: int, *, mode: int
) -> bytes | None:
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
            dir_fd=directory_fd,
        )
    except FileNotFoundError:
        return None
    except OSError:
        _fail("unsafe-control-file")
    try:
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != ROOT_UID
            or before.st_gid != ROOT_GID
            or stat.S_IMODE(before.st_mode) != mode
            or before.st_nlink != 1
            or before.st_size <= 0
            or before.st_size > maximum
        ):
            _fail("unsafe-control-file")
        data = b""
        while len(data) <= maximum:
            chunk = os.read(fd, min(65_536, maximum + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        after = os.fstat(fd)
        if len(data) > maximum or _stable_stat(before) != _stable_stat(after):
            _fail("raced-control-file")
        return data
    finally:
        os.close(fd)


def _read_private_file(directory_fd: int, name: str, maximum: int) -> bytes | None:
    return _read_control_file(directory_fd, name, maximum, mode=0o600)


def _stable_stat(value: os.stat_result) -> tuple[object, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_nlink,
        value.st_uid,
        value.st_gid,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _atomic_write(
    directory_fd: int, name: str, payload: bytes, *, mode: int = 0o600
) -> None:
    temporary = f".{name}.tmp.{secrets.token_hex(12)}"
    fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=directory_fd,
    )
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(fd, payload[offset:])
        os.fchown(fd, ROOT_UID, ROOT_GID)
        os.fchmod(fd, mode)
        os.fsync(fd)
    except Exception:
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except OSError:
            pass
        raise
    finally:
        os.close(fd)
    os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
    os.fsync(directory_fd)


def _unlink_control_file(directory_fd: int, name: str, *, mode: int) -> None:
    existing = _read_control_file(directory_fd, name, MAX_MARKER_BYTES, mode=mode)
    if existing is None:
        return
    os.unlink(name, dir_fd=directory_fd)
    os.fsync(directory_fd)


def _unlink_private(directory_fd: int, name: str) -> None:
    _unlink_control_file(directory_fd, name, mode=0o600)


def _load_marker(durable_fd: int) -> dict[str, object] | None:
    raw = _read_private_file(durable_fd, MARKER_NAME, MAX_MARKER_BYTES)
    if raw is None:
        return None
    value = _parse_json(raw, MAX_MARKER_BYTES, "invalid-marker-json")
    marker = _validate_marker(value)
    if raw != _json_bytes(marker) + b"\n":
        _fail("marker-not-canonical")
    return marker


def _write_marker(durable_fd: int, marker: dict[str, object]) -> bytes:
    payload = _json_bytes(marker) + b"\n"
    if len(payload) > MAX_MARKER_BYTES:
        _fail("marker-too-large")
    _atomic_write(durable_fd, MARKER_NAME, payload)
    return payload


def _sandbox_account() -> tuple[int, int]:
    try:
        account = pwd.getpwnam("sandbox")
    except KeyError:
        _fail("writer-account-unavailable")
    if account.pw_uid == ROOT_UID or account.pw_gid == ROOT_GID:
        _fail("writer-account-is-root")
    return account.pw_uid, account.pw_gid


def _open_startup_handoff_root() -> int:
    parent = os.path.dirname(STARTUP_HANDOFF_DIRECTORY)
    parent_fd = _open_absolute_directory(parent)
    try:
        _verify_control_parent(parent_fd, searchable=True)
    finally:
        os.close(parent_fd)
    return _open_or_create_directory(
        STARTUP_HANDOFF_DIRECTORY, STARTUP_HANDOFF_PARENT_MODE
    )


def _open_startup_candidate_directory(
    marker: dict[str, object], *, create: bool
) -> tuple[int, int] | None:
    root_fd = _open_startup_handoff_root()
    name = str(marker["nonce"])
    sandbox_uid, sandbox_gid = _sandbox_account()
    try:
        if create:
            created = False
            try:
                os.mkdir(name, 0o700, dir_fd=root_fd)
                created = True
            except FileExistsError:
                pass
            try:
                directory_fd = os.open(name, _directory_flags(), dir_fd=root_fd)
            except OSError:
                _fail("activation-candidate-directory-invalid")
            if created:
                os.fchown(directory_fd, sandbox_uid, sandbox_gid)
                os.fchmod(directory_fd, 0o700)
                os.fsync(directory_fd)
                os.fsync(root_fd)
        else:
            try:
                directory_fd = os.open(name, _directory_flags(), dir_fd=root_fd)
            except FileNotFoundError:
                os.close(root_fd)
                return None
            except OSError:
                _fail("activation-candidate-directory-invalid")
        metadata = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != sandbox_uid
            or metadata.st_gid != sandbox_gid
            or stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            os.close(directory_fd)
            _fail("activation-candidate-directory-invalid")
        return root_fd, directory_fd
    except BaseException:
        try:
            os.close(root_fd)
        except OSError:
            pass
        raise


def _read_startup_candidate(
    marker: dict[str, object], fence: FenceProof, *, required: bool
) -> tuple[dict[str, object], bytes] | None:
    opened = _open_startup_candidate_directory(marker, create=False)
    if opened is None:
        if required:
            _fail("activation-checkpoint-missing")
        return None
    root_fd, directory_fd = opened
    sandbox_uid, sandbox_gid = _sandbox_account()
    try:
        # The candidate is intentionally sandbox-owned inside the one
        # controller-created handoff directory; re-open it with that exact
        # ownership instead of the root-only control-file helper.
        try:
            fd = os.open(
                STARTUP_CANDIDATE_NAME,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                dir_fd=directory_fd,
            )
        except FileNotFoundError:
            if required:
                _fail("activation-checkpoint-missing")
            return None
        except OSError:
            _fail("activation-checkpoint-invalid")
        try:
            before = os.fstat(fd)
            payload = os.read(fd, MAX_MARKER_BYTES + 1)
            after = os.fstat(fd)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_uid != sandbox_uid
                or before.st_gid != sandbox_gid
                or stat.S_IMODE(before.st_mode) != 0o600
                or before.st_nlink != 1
                or len(payload) > MAX_MARKER_BYTES
                or os.read(fd, 1)
                or _stable_stat(before) != _stable_stat(after)
            ):
                _fail("activation-checkpoint-invalid")
        finally:
            os.close(fd)
        candidate = _exact_keys(
            _parse_json(payload, MAX_MARKER_BYTES, "activation-checkpoint-invalid"),
            STARTUP_CANDIDATE_KEYS,
            "activation-checkpoint-invalid",
        )
        marker_sha256 = _hex_digest(
            candidate["markerSha256"], "activation-checkpoint-invalid"
        )
        expected = {
            "schemaVersion": SCHEMA_VERSION,
            "protocol": STARTUP_CANDIDATE_PROTOCOL,
            "transactionId": marker["transactionId"],
            "nonce": marker["nonce"],
            "markerSha256": marker_sha256,
            "start": _process_reference_payload(fence.start),
        }
        if (
            payload != _json_bytes(expected) + b"\n"
            or not secrets.compare_digest(_json_bytes(candidate), _json_bytes(expected))
            or not secrets.compare_digest(
                marker_sha256,
                str(_startup_candidate_payload(marker, fence)["markerSha256"]),
            )
        ):
            _fail("activation-checkpoint-invalid")
        return expected, payload
    finally:
        os.close(directory_fd)
        os.close(root_fd)


def _read_public_protocol_file(
    durable_fd: int,
    name: str,
    keys: tuple[str, ...],
    protocol: str,
    code: str,
) -> dict[str, object] | None:
    raw = _read_control_file(durable_fd, name, MAX_MARKER_BYTES, mode=0o444)
    if raw is None:
        return None
    value = _exact_keys(_parse_json(raw, MAX_MARKER_BYTES, code), keys, code)
    if (
        value["schemaVersion"] != SCHEMA_VERSION
        or value["protocol"] != protocol
        or raw != _json_bytes(value) + b"\n"
    ):
        _fail(code)
    return value


def _canonical_protocol_payload(value: dict[str, object]) -> bytes:
    return _json_bytes(value) + b"\n"


def _read_activation_permit(
    durable_fd: int, marker: dict[str, object], fence: FenceProof
) -> dict[str, object] | None:
    permit = _read_public_protocol_file(
        durable_fd,
        ACTIVATION_PERMIT_NAME,
        ACTIVATION_PERMIT_KEYS,
        ACTIVATION_PERMIT_PROTOCOL,
        "activation-permit-invalid",
    )
    if permit is not None and not secrets.compare_digest(
        _json_bytes(permit), _json_bytes(_activation_permit_payload(marker, fence))
    ):
        _fail("activation-permit-conflict")
    return permit


def _read_activation_retry(
    durable_fd: int,
) -> dict[str, object] | None:
    retry = _read_public_protocol_file(
        durable_fd,
        ACTIVATION_RETRY_NAME,
        ACTIVATION_RETRY_KEYS,
        ACTIVATION_RETRY_PROTOCOL,
        "activation-retry-invalid",
    )
    if retry is not None:
        _hex_digest(retry["permitSha256"], "activation-retry-invalid")
        checkpoint = retry["checkpointSha256"]
        if checkpoint is not None:
            _hex_digest(checkpoint, "activation-retry-invalid")
    return retry


def _read_activation_cleanup(
    durable_fd: int, marker: dict[str, object], fence: FenceProof
) -> dict[str, object] | None:
    raw = _read_private_file(durable_fd, ACTIVATION_CLEANUP_NAME, MAX_MARKER_BYTES)
    if raw is None:
        return None
    cleanup = _exact_keys(
        _parse_json(raw, MAX_MARKER_BYTES, "activation-cleanup-invalid"),
        ACTIVATION_CLEANUP_KEYS,
        "activation-cleanup-invalid",
    )
    expected = _activation_cleanup_payload(marker, fence)
    if (
        cleanup["schemaVersion"] != SCHEMA_VERSION
        or cleanup["protocol"] != ACTIVATION_CLEANUP_PROTOCOL
        or raw != _canonical_protocol_payload(expected)
        or not secrets.compare_digest(_json_bytes(cleanup), _json_bytes(expected))
    ):
        _fail("activation-cleanup-invalid")
    return cleanup


def _activation_attempt_pending(
    durable_fd: int, marker: dict[str, object], fence: FenceProof
) -> bool:
    if _read_activation_cleanup(durable_fd, marker, fence) is not None:
        # The exact shell has already authenticated and acknowledged its exec
        # restart. Finish the durable, idempotent cleanup before issuing a fresh
        # permit; every process is still covered by the activation guardian.
        _cleanup_activation_protocol(durable_fd, marker)
        return False
    permit = _read_activation_permit(durable_fd, marker, fence)
    retry = _read_activation_retry(durable_fd)
    opened = _open_startup_candidate_directory(marker, create=False)
    candidate_entries: list[str] | None = None
    if opened is not None:
        root_fd, directory_fd = opened
        candidate_entries = os.listdir(directory_fd)
        os.close(directory_fd)
        os.close(root_fd)
    if permit is None:
        if retry is not None or candidate_entries:
            _fail("activation-attempt-orphaned")
        if opened is not None:
            _cleanup_startup_candidate_directory(marker)
        return False
    return True


def _publish_activation_permit(
    durable_fd: int, marker: dict[str, object], fence: FenceProof
) -> None:
    opened = _open_startup_candidate_directory(marker, create=True)
    assert opened is not None
    root_fd, directory_fd = opened
    os.close(directory_fd)
    os.close(root_fd)
    if (
        _read_public_protocol_file(
            durable_fd,
            ACTIVATION_RELEASE_NAME,
            ACTIVATION_RELEASE_KEYS,
            ACTIVATION_RELEASE_PROTOCOL,
            "activation-release-invalid",
        )
        is not None
    ):
        _fail("activation-release-conflict")
    if _read_activation_retry(durable_fd) is not None:
        _fail("activation-retry-conflict")
    expected = _activation_permit_payload(marker, fence)
    existing = _read_activation_permit(durable_fd, marker, fence)
    if existing is not None:
        if not secrets.compare_digest(_json_bytes(existing), _json_bytes(expected)):
            _fail("activation-permit-conflict")
        return
    _atomic_write(
        durable_fd,
        ACTIVATION_PERMIT_NAME,
        _json_bytes(expected) + b"\n",
        mode=0o444,
    )


def _publish_activation_release(
    durable_fd: int,
    marker: dict[str, object],
    fence: FenceProof,
    activation: ActivationProof,
) -> None:
    expected = _activation_release_payload(marker, fence, activation)
    existing = _read_public_protocol_file(
        durable_fd,
        ACTIVATION_RELEASE_NAME,
        ACTIVATION_RELEASE_KEYS,
        ACTIVATION_RELEASE_PROTOCOL,
        "activation-release-invalid",
    )
    if existing is not None:
        if not secrets.compare_digest(_json_bytes(existing), _json_bytes(expected)):
            _fail("activation-release-conflict")
        return
    _atomic_write(
        durable_fd,
        ACTIVATION_RELEASE_NAME,
        _json_bytes(expected) + b"\n",
        mode=0o444,
    )


def _publish_activation_retry(
    durable_fd: int, marker: dict[str, object], fence: FenceProof
) -> bytes:
    permit = _read_activation_permit(durable_fd, marker, fence)
    if permit is None:
        _fail("activation-permit-missing")
    selected = _read_startup_candidate(marker, fence, required=False)
    checkpoint_payload = selected[1] if selected is not None else None
    permit_payload = _canonical_protocol_payload(permit)
    expected = _activation_retry_payload(
        marker, fence, permit_payload, checkpoint_payload
    )
    existing = _read_activation_retry(durable_fd)
    if existing is not None:
        if not secrets.compare_digest(_json_bytes(existing), _json_bytes(expected)):
            _fail("activation-retry-conflict")
        return _canonical_protocol_payload(existing)
    payload = _canonical_protocol_payload(expected)
    _atomic_write(durable_fd, ACTIVATION_RETRY_NAME, payload, mode=0o444)
    return payload


def _read_startup_retry_ack(
    marker: dict[str, object], fence: FenceProof, retry_payload: bytes
) -> dict[str, object] | None:
    opened = _open_startup_candidate_directory(marker, create=False)
    if opened is None:
        return None
    root_fd, directory_fd = opened
    sandbox_uid, sandbox_gid = _sandbox_account()
    try:
        try:
            fd = os.open(
                STARTUP_RETRY_ACK_NAME,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                dir_fd=directory_fd,
            )
        except FileNotFoundError:
            return None
        except OSError:
            _fail("activation-retry-ack-invalid")
        try:
            before = os.fstat(fd)
            payload = os.read(fd, MAX_MARKER_BYTES + 1)
            after = os.fstat(fd)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_uid != sandbox_uid
                or before.st_gid != sandbox_gid
                or stat.S_IMODE(before.st_mode) != 0o600
                or before.st_nlink != 1
                or len(payload) > MAX_MARKER_BYTES
                or os.read(fd, 1)
                or _stable_stat(before) != _stable_stat(after)
            ):
                _fail("activation-retry-ack-invalid")
        finally:
            os.close(fd)
        ack = _exact_keys(
            _parse_json(payload, MAX_MARKER_BYTES, "activation-retry-ack-invalid"),
            STARTUP_RETRY_ACK_KEYS,
            "activation-retry-ack-invalid",
        )
        expected = _startup_retry_ack_payload(marker, fence, retry_payload)
        if (
            ack["schemaVersion"] != SCHEMA_VERSION
            or ack["protocol"] != STARTUP_RETRY_ACK_PROTOCOL
            or payload != _json_bytes(expected) + b"\n"
            or not secrets.compare_digest(_json_bytes(ack), _json_bytes(expected))
        ):
            _fail("activation-retry-ack-invalid")
        return expected
    finally:
        os.close(directory_fd)
        os.close(root_fd)


def _wait_for_startup_retry_ack(
    marker: dict[str, object], fence: FenceProof, retry_payload: bytes
) -> None:
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    while True:
        if _read_startup_retry_ack(marker, fence, retry_payload) is not None:
            _recapture_reference(fence.start, "activation-retry-identity-drift")
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("activation-retry-timeout")
        time.sleep(min(POLL_SECONDS, remaining))


def _read_startup_release_ack(
    marker: dict[str, object], fence: FenceProof, release_payload: bytes
) -> dict[str, object] | None:
    opened = _open_startup_candidate_directory(marker, create=False)
    if opened is None:
        return None
    root_fd, directory_fd = opened
    sandbox_uid, sandbox_gid = _sandbox_account()
    try:
        try:
            fd = os.open(
                STARTUP_RELEASE_ACK_NAME,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                dir_fd=directory_fd,
            )
        except FileNotFoundError:
            return None
        except OSError:
            _fail("activation-release-ack-invalid")
        try:
            before = os.fstat(fd)
            payload = os.read(fd, MAX_MARKER_BYTES + 1)
            after = os.fstat(fd)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_uid != sandbox_uid
                or before.st_gid != sandbox_gid
                or stat.S_IMODE(before.st_mode) != 0o600
                or before.st_nlink != 1
                or len(payload) > MAX_MARKER_BYTES
                or os.read(fd, 1)
                or _stable_stat(before) != _stable_stat(after)
            ):
                _fail("activation-release-ack-invalid")
        finally:
            os.close(fd)
        ack = _exact_keys(
            _parse_json(payload, MAX_MARKER_BYTES, "activation-release-ack-invalid"),
            STARTUP_RELEASE_ACK_KEYS,
            "activation-release-ack-invalid",
        )
        expected = _startup_release_ack_payload(
            marker, fence, release_payload
        )
        if (
            ack["schemaVersion"] != SCHEMA_VERSION
            or ack["protocol"] != STARTUP_RELEASE_ACK_PROTOCOL
            or payload != _json_bytes(expected) + b"\n"
            or not secrets.compare_digest(_json_bytes(ack), _json_bytes(expected))
        ):
            _fail("activation-release-ack-invalid")
        return expected
    finally:
        os.close(directory_fd)
        os.close(root_fd)


def _wait_for_startup_release_ack(
    marker: dict[str, object], fence: FenceProof, release_payload: bytes
) -> None:
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    while True:
        if _read_startup_release_ack(marker, fence, release_payload) is not None:
            _recapture_reference(fence.start, "activation-release-identity-drift")
            # The exact publisher stops after writing the acknowledgement. Its
            # parent stops only after the controller resumes that child, Bash
            # reaps it, and the parent observes success.
            _wait_for_release_ack_publisher(fence)
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("activation-release-ack-timeout")
        time.sleep(min(POLL_SECONDS, remaining))


def _is_release_ack_publisher(
    process: ProcessIdentity, start: ProcessReference
) -> bool:
    return bool(
        process.parent_pid == start.pid
        and process.uids == start.uids
        and process.command
        == (
            STARTUP_GATE_PYTHON,
            b"-I",
            STARTUP_GATE_HELPER,
            b"acknowledge",
        )
    )


def _wait_for_release_ack_publisher(fence: FenceProof) -> None:
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    resumed_publisher: ProcessReference | None = None
    while True:
        start = _recapture_reference(
            fence.start, "activation-release-identity-drift"
        )
        publishers = tuple(
            process
            for process in _capture_writer_processes(fence.writer_uids)
            if _is_release_ack_publisher(process, fence.start)
        )
        if len(publishers) > 1:
            _fail("activation-release-ack-invalid")
        if publishers:
            publisher = publishers[0]
            if resumed_publisher is not None and not _process_matches_reference(
                publisher, resumed_publisher
            ):
                _fail("activation-release-ack-invalid")
            if publisher.state in ("T", "t") and resumed_publisher is None:
                publisher_reference = _process_reference(publisher)
                _signal_reference(publisher_reference, signal.SIGCONT)
                resumed_publisher = publisher_reference
        elif not publishers and start.state in ("T", "t"):
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("activation-release-ack-timeout")
        time.sleep(min(POLL_SECONDS, remaining))


def _verify_activation_checkpoint(
    marker: dict[str, object], fence: FenceProof, activation: ActivationProof
) -> None:
    selected = _read_startup_candidate(marker, fence, required=True)
    assert selected is not None
    _candidate, payload = selected
    if not secrets.compare_digest(
        _sha256(payload), activation.startup_checkpoint_sha256
    ):
        _fail("activation-checkpoint-drift")


def _cleanup_startup_candidate_directory(marker: dict[str, object]) -> None:
    opened = _open_startup_candidate_directory(marker, create=False)
    if opened is None:
        return
    root_fd, directory_fd = opened
    sandbox_uid, sandbox_gid = _sandbox_account()
    try:
        for name in os.listdir(directory_fd):
            if (
                name
                not in (
                    STARTUP_CANDIDATE_NAME,
                    STARTUP_RETRY_ACK_NAME,
                    STARTUP_RELEASE_ACK_NAME,
                )
                and not name.startswith(f".{STARTUP_CANDIDATE_NAME}.")
                and not name.startswith(f".{STARTUP_RETRY_ACK_NAME}.")
                and not name.startswith(f".{STARTUP_RELEASE_ACK_NAME}.")
            ):
                _fail("activation-candidate-directory-invalid")
            try:
                metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except OSError:
                _fail("activation-candidate-directory-invalid")
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != sandbox_uid
                or metadata.st_gid != sandbox_gid
                or stat.S_IMODE(metadata.st_mode) != 0o600
                or metadata.st_nlink != 1
            ):
                _fail("activation-candidate-directory-invalid")
            os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
        os.close(directory_fd)
        directory_fd = -1
        os.rmdir(str(marker["nonce"]), dir_fd=root_fd)
        os.fsync(root_fd)
    finally:
        if directory_fd >= 0:
            os.close(directory_fd)
        os.close(root_fd)


def _cleanup_activation_protocol(durable_fd: int, marker: dict[str, object]) -> None:
    fence = _fence_from_value(marker["fence"])
    cleanup = _read_activation_cleanup(durable_fd, marker, fence)
    if cleanup is None:
        cleanup = _activation_cleanup_payload(marker, fence)
        _atomic_write(
            durable_fd,
            ACTIVATION_CLEANUP_NAME,
            _canonical_protocol_payload(cleanup),
        )
    for name, keys, protocol, code in (
        (
            ACTIVATION_PERMIT_NAME,
            ACTIVATION_PERMIT_KEYS,
            ACTIVATION_PERMIT_PROTOCOL,
            "activation-permit-invalid",
        ),
        (
            ACTIVATION_RELEASE_NAME,
            ACTIVATION_RELEASE_KEYS,
            ACTIVATION_RELEASE_PROTOCOL,
            "activation-release-invalid",
        ),
        (
            ACTIVATION_RETRY_NAME,
            ACTIVATION_RETRY_KEYS,
            ACTIVATION_RETRY_PROTOCOL,
            "activation-retry-invalid",
        ),
    ):
        value = _read_public_protocol_file(durable_fd, name, keys, protocol, code)
        if value is None:
            continue
        if (
            value["transactionId"] != marker["transactionId"]
            or value["nonce"] != marker["nonce"]
            or value["start"] != _process_reference_payload(fence.start)
            or value["candidateDirectory"] != _startup_candidate_directory(marker)
        ):
            _fail(code)
        _unlink_control_file(durable_fd, name, mode=0o444)
    _cleanup_startup_candidate_directory(marker)
    # This durable progress record is removed last. Its presence makes every
    # preceding unlink boundary recognizable and safely resumable.
    _unlink_private(durable_fd, ACTIVATION_CLEANUP_NAME)


def _load_released_receipt(durable_fd: int) -> dict[str, object] | None:
    raw = _read_private_file(durable_fd, RELEASED_RECEIPT_NAME, MAX_MARKER_BYTES)
    if raw is None:
        return None
    value = _parse_json(raw, MAX_MARKER_BYTES, "released-receipt-invalid")
    receipt = _validate_released_receipt(value)
    if raw != _json_bytes(receipt) + b"\n":
        _fail("released-receipt-invalid")
    return receipt


def _write_released_receipt(
    durable_fd: int,
    marker: dict[str, object],
    completed_ledger_sha256: str,
    release_state: str,
) -> dict[str, object]:
    receipt = _released_receipt_payload(marker, completed_ledger_sha256, release_state)
    payload = _json_bytes(receipt) + b"\n"
    if len(payload) > MAX_MARKER_BYTES:
        _fail("released-receipt-too-large")
    _atomic_write(durable_fd, RELEASED_RECEIPT_NAME, payload)
    return receipt


def _released_receipt_matches_status(
    receipt: dict[str, object], request: StatusRequest
) -> bool:
    marker = receipt["marker"]
    if not isinstance(marker, dict) or not _marker_matches_status(marker, request):
        return False
    if request.action != "release":
        return True
    return (
        request.activation_provider_handle is not None
        and request.completed_ledger_sha256 is not None
        and secrets.compare_digest(
            request.activation_provider_handle,
            str(receipt["activationProviderHandle"]),
        )
        and secrets.compare_digest(
            request.completed_ledger_sha256,
            str(receipt["completedLedgerSha256"]),
        )
    )


def _finish_released_cleanup(
    durable_fd: int, runtime_fd: int, released_marker: dict[str, object]
) -> None:
    active = _load_marker(durable_fd)
    if active is not None and not secrets.compare_digest(
        _json_bytes(active), _json_bytes(released_marker)
    ):
        return
    _cleanup_activation_protocol(durable_fd, released_marker)
    _unlink_private(runtime_fd, SENTINEL_NAME)
    _unlink_private(runtime_fd, ACTIVATION_RECEIPT_NAME)
    # ``active.json`` is the durable non-root startup gate. Remove it last so a
    # replacement entrypoint cannot pass the gate before release cleanup is
    # itself complete and durable.
    _unlink_private(durable_fd, MARKER_NAME)


def _publish_sentinel(runtime_fd: int, marker_payload: bytes, nonce: str) -> None:
    sentinel = {
        "schemaVersion": SCHEMA_VERSION,
        "nonce": nonce,
        "markerSha256": _sha256(marker_payload),
    }
    _atomic_write(runtime_fd, SENTINEL_NAME, _json_bytes(sentinel) + b"\n")


def _verify_sentinel(runtime_fd: int, marker_payload: bytes, nonce: str) -> None:
    raw = _read_private_file(runtime_fd, SENTINEL_NAME, MAX_MARKER_BYTES)
    expected = (
        _json_bytes(
            {
                "schemaVersion": SCHEMA_VERSION,
                "nonce": nonce,
                "markerSha256": _sha256(marker_payload),
            }
        )
        + b"\n"
    )
    if raw is None or not secrets.compare_digest(raw, expected):
        _fail("sentinel-mismatch")


def _capture_runtime_binding(state_root: str) -> tuple[str, str, str]:
    root_fd = _open_absolute_directory(state_root)
    try:
        metadata = os.fstat(root_fd)
    finally:
        os.close(root_fd)
    try:
        mount_namespace = os.readlink(MOUNT_NAMESPACE_PATH)
    except OSError:
        _fail("mount-namespace-unavailable")
    if MOUNT_NAMESPACE.fullmatch(mount_namespace) is None:
        _fail("mount-namespace-unavailable")
    return mount_namespace, str(metadata.st_dev), str(metadata.st_ino)


def _assert_runtime_binding(marker: dict[str, object]) -> None:
    mount_namespace, state_root_device, state_root_inode = _capture_runtime_binding(
        str(marker["stateRoot"])
    )
    if mount_namespace != marker["mountNamespace"]:
        _fail("mount-namespace-drift")
    if (
        state_root_device != marker["stateRootDevice"]
        or state_root_inode != marker["stateRootInode"]
    ):
        _fail("state-root-drift")


def _read_proc_file(path: str, maximum: int = MAX_PROC_FILE_BYTES) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            _fail("unreadable-writer-process")
        data = b""
        while len(data) <= maximum:
            chunk = os.read(fd, min(65_536, maximum + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        if len(data) > maximum:
            _fail("unreadable-writer-process")
        return data
    finally:
        os.close(fd)


def _parse_proc_stat(pid: int, raw: bytes) -> tuple[str, int, str]:
    try:
        text = raw.decode("ascii", "strict")
        suffix = text[text.rindex(") ") + 2 :].split()
        state = suffix[0]
        parent = int(suffix[1], 10)
        start = suffix[19]
    except (UnicodeDecodeError, ValueError, IndexError):
        _fail("unreadable-writer-process")
    if len(state) != 1 or DECIMAL.fullmatch(start) is None or parent < 0:
        _fail("unreadable-writer-process")
    return state, parent, start


def _parse_proc_uids(raw: bytes) -> tuple[int, int, int, int]:
    try:
        text = raw.decode("ascii", "strict")
    except UnicodeDecodeError:
        _fail("unreadable-writer-process")
    for line in text.splitlines():
        if line.startswith("Uid:"):
            fields = line.split()[1:]
            if len(fields) != 4 or any(
                DECIMAL.fullmatch(item) is None for item in fields
            ):
                break
            return tuple(int(item, 10) for item in fields)  # type: ignore[return-value]
    _fail("unreadable-writer-process")


def _same_filesystem_object(first: os.stat_result, second: os.stat_result) -> bool:
    return first.st_dev == second.st_dev and first.st_ino == second.st_ino


def _assert_private_procfs() -> None:
    try:
        proc_metadata = os.lstat(PROC_ROOT)
        proc_root = os.stat(PROC_ROOT)
        container_root = os.stat("/")
        pid_one_root = os.stat(os.path.join(PROC_ROOT, "1", "root"))
        self_root = os.stat(os.path.join(PROC_ROOT, "self", "root"))
        pid_one_namespace = os.readlink(os.path.join(PROC_ROOT, "1", "ns", "pid"))
        self_namespace = os.readlink(os.path.join(PROC_ROOT, "self", "ns", "pid"))
    except OSError:
        _fail("unsafe-proc-namespace")
    if (
        not stat.S_ISDIR(proc_metadata.st_mode)
        or stat.S_ISLNK(proc_metadata.st_mode)
        or proc_root.st_dev == container_root.st_dev
        or PID_NAMESPACE.fullmatch(pid_one_namespace) is None
        or pid_one_namespace != self_namespace
        or not _same_filesystem_object(pid_one_root, container_root)
        or not _same_filesystem_object(self_root, container_root)
    ):
        _fail("unsafe-proc-namespace")


def _capture_process(pid: int) -> ProcessIdentity | None:
    process_path = os.path.join(PROC_ROOT, str(pid))
    executable_path = os.path.join(process_path, "exe")
    try:
        before = os.stat(process_path, follow_symlinks=False)
        executable_before = os.stat(executable_path)
        first_stat = _read_proc_file(os.path.join(process_path, "stat"))
        status = _read_proc_file(os.path.join(process_path, "status"))
        command_raw = _read_proc_file(os.path.join(process_path, "cmdline"))
        second_stat = _read_proc_file(os.path.join(process_path, "stat"))
        executable_after = os.stat(executable_path)
        after = os.stat(process_path, follow_symlinks=False)
    except (FileNotFoundError, ProcessLookupError):
        return None
    except PermissionError:
        _fail("unreadable-writer-process")
    except OSError:
        _fail("unreadable-writer-process")
    _first_state, parent, start = _parse_proc_stat(pid, first_stat)
    second_state, second_parent, second_start = _parse_proc_stat(pid, second_stat)
    if (
        not stat.S_ISDIR(before.st_mode)
        or _stable_stat(before) != _stable_stat(after)
        or not _same_filesystem_object(executable_before, executable_after)
        or (parent, start) != (second_parent, second_start)
    ):
        _fail("raced-writer-process")
    return ProcessIdentity(
        pid,
        second_state,
        parent,
        start,
        _parse_proc_uids(status),
        tuple(part for part in command_raw.split(b"\0") if part),
        before.st_dev,
        before.st_ino,
        executable_after.st_dev,
        executable_after.st_ino,
    )


def _supported_writer_uids() -> tuple[int, ...]:
    values: list[int] = []
    try:
        for account in SUPPORTED_WRITER_ACCOUNTS:
            uid = pwd.getpwnam(account).pw_uid
            if uid == ROOT_UID:
                _fail("writer-account-is-root")
            values.append(uid)
    except KeyError:
        _fail("writer-account-unavailable")
    return tuple(sorted(set(values)))


def _sandbox_uid() -> int:
    try:
        uid = pwd.getpwnam("sandbox").pw_uid
    except KeyError:
        _fail("writer-account-unavailable")
    if uid == ROOT_UID:
        _fail("writer-account-is-root")
    return uid


def _capture_writer_processes(
    writer_uids: tuple[int, ...],
) -> tuple[ProcessIdentity, ...]:
    _assert_private_procfs()
    try:
        entries = os.listdir(PROC_ROOT)
    except OSError:
        _fail("proc-unavailable")
    numeric = sorted(int(name) for name in entries if name.isascii() and name.isdigit())
    if len(numeric) > MAX_PROC_ENTRIES:
        _fail("proc-entry-limit")
    result: list[ProcessIdentity] = []
    for pid in numeric:
        process = _capture_process(pid)
        if (
            process is not None
            and process.state != "Z"
            and any(uid in writer_uids for uid in process.uids)
        ):
            result.append(process)
    return tuple(result)


def _is_openshell_supervisor(process: ProcessIdentity) -> bool:
    return bool(
        process.pid == 1
        and process.parent_pid == 0
        and process.state != "Z"
        and process.uids == (ROOT_UID,) * 4
        and process.command
        and process.command[0] == OPENSHELL_ARGV0
    )


def _is_nemoclaw_start(process: ProcessIdentity, sandbox_uid: int) -> bool:
    # Docker appends image CMD arguments after ENTRYPOINT. Authenticate the
    # fixed startup-script position, then bind the complete argv to the fence.
    direct = bool(process.command) and process.command[0] == NEMOCLAW_START_PATH
    interpreted = bool(
        len(process.command) >= 2
        and process.command[0] in BASH_ARGV0
        and process.command[1] == NEMOCLAW_START_PATH
    )
    return bool(
        process.pid > 1
        and process.parent_pid == 1
        and process.state != "Z"
        and process.uids == (sandbox_uid,) * 4
        and (direct or interpreted)
    )


def _is_start_log_drain(
    process: ProcessIdentity, start: ProcessIdentity, sandbox_uid: int
) -> bool:
    return bool(
        process.pid > 1
        and process.parent_pid == start.pid
        and process.state != "Z"
        and process.uids == (sandbox_uid,) * 4
        and len(process.command) == 3
        and process.command[0] in START_LOG_DRAIN_PATHS
        and process.command[1:] == (b"-a", START_LOG_PATH)
    )


def _start_log_drains(
    writers: tuple[ProcessIdentity, ...], start: ProcessIdentity, sandbox_uid: int
) -> tuple[ProcessIdentity, ...]:
    drains = tuple(
        sorted(
            (
                process
                for process in writers
                if _is_start_log_drain(process, start, sandbox_uid)
            ),
            key=lambda process: process.pid,
        )
    )
    if len(drains) != 2:
        _fail("startup-support-unavailable")
    return drains


def _process_matches_reference(
    process: ProcessIdentity, reference: ProcessReference
) -> bool:
    return bool(
        _process_has_reference_identity(process, reference) and process.state != "Z"
    )


def _process_has_reference_identity(
    process: ProcessIdentity, reference: ProcessReference
) -> bool:
    return bool(
        _process_has_kernel_task_reference(process, reference)
        and process.parent_pid == reference.parent_pid
        and process.uids == reference.uids
        and _process_command_sha256(process.command) == reference.command_sha256
        and _process_has_reference_executable(process, reference)
    )


def _process_has_reference_executable(
    process: ProcessIdentity, reference: ProcessReference
) -> bool:
    return bool(
        process.executable_device == reference.executable_device
        and process.executable_inode == reference.executable_inode
    )


def _process_has_kernel_task_reference(
    process: ProcessIdentity, reference: ProcessReference
) -> bool:
    return bool(
        process.pid == reference.pid
        and process.start_identity == reference.start_identity
        and process.proc_device == reference.proc_device
        and process.proc_inode == reference.proc_inode
    )


def _recapture_reference(
    reference: ProcessReference, code: str = "fenced-process-drift"
) -> ProcessIdentity:
    process = _capture_process(reference.pid)
    if process is None or not _process_matches_reference(process, reference):
        _fail(code)
    return process


def _recapture_supervisor(reference: ProcessReference) -> ProcessIdentity:
    process = _capture_process(reference.pid)
    # PID 1 can refresh its displayed argv suffix while it remains the same
    # kernel task. Revalidate the fixed OpenShell supervisor semantics instead
    # of treating that mutable display metadata as task replacement. Start
    # time and procfs identity still bind the original task. The executable
    # identity rejects an exec replacement that forges the expected argv0.
    if (
        process is None
        or not _process_has_kernel_task_reference(process, reference)
        or not _process_has_reference_executable(process, reference)
        or not _is_openshell_supervisor(process)
    ):
        _fail("supervisor-identity-drift")
    return process


def _discover_fence(expected_mount_namespace: str) -> FenceProof:
    _assert_private_procfs()
    try:
        mount_namespace = os.readlink(MOUNT_NAMESPACE_PATH)
    except OSError:
        _fail("supervisor-unavailable")
    if mount_namespace != expected_mount_namespace:
        _fail("supervisor-unavailable")
    writer_uids = _supported_writer_uids()
    sandbox_uid = _sandbox_uid()
    supervisor = _capture_process(1)
    if supervisor is None or not _is_openshell_supervisor(supervisor):
        _fail("supervisor-unavailable")
    writers = _capture_writer_processes(writer_uids)
    starts = [
        process for process in writers if _is_nemoclaw_start(process, sandbox_uid)
    ]
    if len(starts) != 1:
        _fail("supervisor-unavailable")
    start = starts[0]
    support = _start_log_drains(writers, start, sandbox_uid)
    supervisor_reference = _process_reference(supervisor)
    start_reference = _process_reference(start)
    support_references = tuple(_process_reference(process) for process in support)
    second_supervisor = _recapture_supervisor(supervisor_reference)
    second_writers = _capture_writer_processes(writer_uids)
    second_starts = [
        process
        for process in second_writers
        if _is_nemoclaw_start(process, sandbox_uid)
    ]
    second_support = (
        _start_log_drains(second_writers, second_starts[0], sandbox_uid)
        if len(second_starts) == 1
        else ()
    )
    if not _is_openshell_supervisor(second_supervisor):
        _fail("supervisor-identity-drift")
    if len(second_starts) != 1 or not _process_matches_reference(
        second_starts[0], start_reference
    ):
        _fail("start-process-identity-drift")
    if len(second_support) != len(support_references) or any(
        not _process_matches_reference(process, reference)
        for process, reference in zip(second_support, support_references)
    ):
        _fail("startup-support-identity-drift")
    return FenceProof(
        supervisor_reference,
        start_reference,
        support_references,
        writer_uids,
    )


def _signal_exact_process(process: ProcessIdentity, requested_signal: int) -> None:
    _assert_private_procfs()
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        _fail("pidfd-unavailable")
    try:
        pidfd = os.pidfd_open(process.pid, 0)
    except ProcessLookupError:
        return
    except OSError:
        _fail("pidfd-unavailable")
    try:
        current = _capture_process(process.pid)
        if current is None:
            return
        # The full process reference was authenticated before opening the
        # pidfd. Recheck only immutable kernel task identity here: parent,
        # credentials, and argv can change on the same task between the two
        # observations. The pidfd remains bound to that task. A real PID
        # replacement changes its start time or procfs inode, while an exec
        # replacement changes its executable identity; both fail closed.
        if (
            current.kernel_task_key() != process.kernel_task_key()
            or current.executable_key() != process.executable_key()
        ):
            _fail("writer-pid-reused")
        try:
            signal.pidfd_send_signal(pidfd, requested_signal)
        except ProcessLookupError:
            return
        except OSError:
            _fail("writer-signal-failed")
    finally:
        os.close(pidfd)


def _signal_reference(reference: ProcessReference, requested_signal: int) -> None:
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    while True:
        process = _recapture_reference(reference)
        try:
            _signal_exact_process(process, requested_signal)
            return
        except ControlError as error:
            if error.code != "writer-pid-reused":
                raise
            # Re-open the persisted exact reference within the existing
            # process-state deadline. A real replacement fails recapture; a
            # process that still matches can be signalled through a fresh
            # pidfd without weakening the identity check. A busy restart can
            # cross more than one short-lived PID snapshot before settling.
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(POLL_SECONDS, remaining))


def _wait_for_reference_state(
    reference: ProcessReference, expected: tuple[str, ...]
) -> ProcessIdentity:
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    while True:
        process = _recapture_reference(reference)
        if process.state in expected:
            return process
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("process-state-timeout")
        time.sleep(min(POLL_SECONDS, remaining))


def _stop_reference(reference: ProcessReference) -> None:
    process = _recapture_reference(reference)
    if process.state not in ("T", "t"):
        _signal_reference(reference, signal.SIGSTOP)
    _wait_for_reference_state(reference, ("T", "t"))


def _wait_for_host_stopped_supervisor(reference: ProcessReference) -> ProcessIdentity:
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    while True:
        process = _recapture_supervisor(reference)
        if process.state in ("T", "t"):
            return process
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("supervisor-not-host-stopped")
        time.sleep(min(POLL_SECONDS, remaining))


def _allowed_writer_map(
    allowed: tuple[ProcessReference, ...],
) -> dict[int, ProcessReference]:
    result: dict[int, ProcessReference] = {}
    for reference in allowed:
        if reference.pid in result:
            _fail("fenced-process-drift")
        result[reference.pid] = reference
    return result


def _writers_match_allowed(
    writers: tuple[ProcessIdentity, ...], allowed: tuple[ProcessReference, ...]
) -> bool:
    references = _allowed_writer_map(allowed)
    if len(writers) != len(references):
        return False
    return all(
        writer.pid in references
        and _process_matches_reference(writer, references[writer.pid])
        and writer.state in ("T", "t")
        for writer in writers
    )


def _exclude_writers(
    writer_uids: tuple[int, ...], allowed: tuple[ProcessReference, ...]
) -> None:
    term_deadline = time.monotonic() + TERM_SECONDS
    kill_deadline = term_deadline + KILL_SECONDS
    stable = 0
    signalled: set[tuple[int, str, int]] = set()
    allowed_by_pid = _allowed_writer_map(allowed)
    while True:
        writers = _capture_writer_processes(writer_uids)
        unexpected: list[ProcessIdentity] = []
        for writer in writers:
            reference = allowed_by_pid.get(writer.pid)
            if reference is None:
                unexpected.append(writer)
                continue
            if not _process_matches_reference(writer, reference):
                _fail("fenced-process-drift")
            if writer.state not in ("T", "t"):
                _fail("allowed-writer-running")
        if not unexpected and _writers_match_allowed(writers, allowed):
            stable += 1
            if stable >= STABLE_SCANS:
                return
            time.sleep(POLL_SECONDS)
            continue
        stable = 0
        now = time.monotonic()
        if now >= kill_deadline:
            _fail("writer-exclusion-timeout")
        requested = signal.SIGTERM if now < term_deadline else signal.SIGKILL
        for writer in unexpected:
            identity = (writer.pid, writer.start_identity, requested)
            if identity not in signalled:
                try:
                    _signal_exact_process(writer, requested)
                except ControlError as error:
                    if error.code != "writer-pid-reused":
                        raise
                    # The pidfd check proved that this captured writer no longer
                    # owns the PID. Do not signal its replacement; the next scan
                    # authenticates the replacement as a separate writer.
                    continue
                signalled.add(identity)
        time.sleep(POLL_SECONDS)


def _assert_writer_exclusion(
    writer_uids: tuple[int, ...], allowed: tuple[ProcessReference, ...]
) -> None:
    stable = 0
    while stable < STABLE_SCANS:
        writers = _capture_writer_processes(writer_uids)
        if not _writers_match_allowed(writers, allowed):
            _fail("writer-fence-breached")
        stable += 1
        time.sleep(POLL_SECONDS)


def _prove_fence_shape(
    fence: FenceProof, expected_mount_namespace: str
) -> tuple[ProcessIdentity, ProcessIdentity]:
    _assert_private_procfs()
    try:
        mount_namespace = os.readlink(MOUNT_NAMESPACE_PATH)
    except OSError:
        _fail("supervisor-identity-drift")
    if (
        mount_namespace != expected_mount_namespace
        or fence.writer_uids != _supported_writer_uids()
    ):
        _fail("supervisor-identity-drift")
    supervisor = _recapture_supervisor(fence.supervisor)
    start = _recapture_reference(fence.start, "start-process-identity-drift")
    support = tuple(
        _recapture_reference(reference, "startup-support-identity-drift")
        for reference in fence.start_support
    )
    sandbox_uid = _sandbox_uid()
    if not _is_openshell_supervisor(supervisor):
        _fail("supervisor-identity-drift")
    if not _is_nemoclaw_start(start, sandbox_uid):
        _fail("start-process-identity-drift")
    if any(
        not _is_start_log_drain(process, start, sandbox_uid)
        for process in support
    ):
        _fail("startup-support-identity-drift")
    return supervisor, start


def _held_writer_references(
    fence: FenceProof, activation: ActivationProof | None
) -> tuple[ProcessReference, ...]:
    if activation is None:
        return (fence.start, *fence.start_support)
    retained: list[ProcessReference] = []
    persistent = set(activation.persistent_pids)
    for reference in activation.processes:
        if _reference_is_terminated(reference):
            if reference.pid in persistent:
                _fail("activation-process-drift")
            continue
        retained.append(reference)
    return (fence.start, *retained)


def _hold_exact_processes(
    fence: FenceProof,
    expected_mount_namespace: str,
    activation: ActivationProof | None,
) -> None:
    _prove_fence_shape(fence, expected_mount_namespace)
    # PID-namespace init accepts SIGSTOP only from an ancestor PID namespace.
    # The provider must therefore stop the exact persisted runtime through its
    # host-side engine authority before invoking this root helper. Keep the
    # helper responsible for proving that boundary and for fencing every
    # workload writer inside the already-proven private namespace.
    _wait_for_host_stopped_supervisor(fence.supervisor)
    _stop_reference(fence.start)
    for reference in fence.start_support:
        _stop_reference(reference)
    if activation is not None:
        persistent = set(activation.persistent_pids)
        support_by_pid = {
            reference.pid: reference for reference in fence.start_support
        }
        for reference in activation.processes:
            support = support_by_pid.get(reference.pid)
            if support is not None:
                if reference != support:
                    _fail("activation-process-drift")
                continue
            if _reference_is_terminated(reference):
                if reference.pid in persistent:
                    _fail("activation-process-drift")
                continue
            _stop_reference(reference)
    allowed = _held_writer_references(fence, activation)
    _exclude_writers(fence.writer_uids, allowed)
    _assert_writer_exclusion(fence.writer_uids, allowed)


def _assert_exact_process_fence(
    fence: FenceProof,
    expected_mount_namespace: str,
    activation: ActivationProof | None,
) -> None:
    supervisor, start = _prove_fence_shape(fence, expected_mount_namespace)
    if supervisor.state not in ("T", "t") or start.state not in ("T", "t"):
        _fail("process-fence-breached")
    _assert_writer_exclusion(
        fence.writer_uids, _held_writer_references(fence, activation)
    )


def _read_activation_guard_byte(fd: int, code: str) -> bytes:
    ready, _writable, _exceptional = select.select([fd], [], [], PROCESS_STATE_SECONDS)
    if not ready:
        _fail(code)
    try:
        value = os.read(fd, 1)
    except OSError:
        _fail(code)
    if len(value) != 1:
        _fail(code)
    return value


def _wait_activation_guard_child(pid: int, code: str) -> None:
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    while True:
        try:
            selected, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            _fail(code)
        if selected == pid:
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
                _fail(code)
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail(code)
        time.sleep(min(POLL_SECONDS, remaining))


def _close_activation_guard_inherited_fds(keep: tuple[int, ...]) -> None:
    entries: list[str] | None = None
    for directory in (os.path.join(PROC_ROOT, "self", "fd"), "/dev/fd"):
        try:
            entries = os.listdir(directory)
            break
        except OSError:
            continue
    if entries is None:
        retained = set(keep)
        for fd in range(3, 1024):
            if fd in retained:
                continue
            try:
                os.close(fd)
            except OSError:
                pass
        return
    retained = set(keep)
    for entry in entries:
        if not entry.isascii() or not entry.isdigit():
            continue
        fd = int(entry, 10)
        if fd <= 2 or fd in retained:
            continue
        try:
            os.close(fd)
        except OSError:
            pass


def _pid_namespace_process_ids() -> tuple[int, ...]:
    try:
        entries = os.listdir(PROC_ROOT)
    except BaseException:
        return ()
    return tuple(
        sorted(
            int(entry, 10) for entry in entries if entry.isascii() and entry.isdigit()
        )
    )


def _open_activation_guard_pidfd(reference: ProcessReference) -> int:
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        _fail("activation-guard-unavailable")
    _recapture_reference(reference, "activation-guard-unavailable")
    try:
        pidfd = os.pidfd_open(reference.pid, 0)
    except OSError:
        _fail("activation-guard-unavailable")
    try:
        os.set_inheritable(pidfd, False)
        _recapture_reference(reference, "activation-guard-unavailable")
    except BaseException:
        os.close(pidfd)
        raise
    return pidfd


def _open_activation_guard_current_pidfd() -> int:
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return _fail("activation-guard-unavailable")
    try:
        pidfd = os.pidfd_open(os.getpid(), 0)
        os.set_inheritable(pidfd, False)
    except OSError:
        return _fail("activation-guard-unavailable")
    return pidfd


def _stop_activation_guard_pidfd(pidfd: int) -> None:
    with suppress(AttributeError, OSError, ValueError):
        signal.pidfd_send_signal(pidfd, signal.SIGSTOP, None, 0)


def _resume_activation_guard_pidfd(pidfd: int) -> None:
    with suppress(AttributeError, OSError, ValueError):
        signal.pidfd_send_signal(pidfd, signal.SIGCONT, None, 0)


def _transport_broker_reference() -> ProcessReference | None:
    try:
        executable_before = os.stat(TRANSPORT_BROKER_PYTHON)
    except OSError:
        return None
    process = _capture_process(os.getppid())
    if process is None:
        return None
    try:
        executable_after = os.stat(TRANSPORT_BROKER_PYTHON)
    except OSError:
        return None
    command = process.command
    if (
        not stat.S_ISREG(executable_before.st_mode)
        or executable_before.st_uid != ROOT_UID
        or executable_before.st_gid != ROOT_GID
        or stat.S_IMODE(executable_before.st_mode) & 0o022
        or not _same_filesystem_object(executable_before, executable_after)
        or process.pid <= 1
        or process.state in ("Z", "X", "x")
        or process.uids != (ROOT_UID,) * 4
        or len(command) != 4
        or command[0] != TRANSPORT_BROKER_PYTHON
        or command[1] != b"-I"
        or command[2] != TRANSPORT_BROKER_PATH
        or re.fullmatch(rb"[0-9a-f]{64}", command[3]) is None
        or process.executable_key()
        != (executable_after.st_dev, executable_after.st_ino)
    ):
        return None
    return _process_reference(process)


def _kernel_pid_namespace_stop() -> None:
    # Linux excludes both PID 1 and the sender from kill(-1, signal). The
    # guardian handles PID 1 through its pre-opened pidfd; excluding the sender
    # is what lets it keep the transaction lock and repeat this broadcast.
    os.kill(-1, signal.SIGSTOP)


def _stop_pid_namespace_fail_closed(pidfds: tuple[int, ...]) -> None:
    for pidfd in pidfds:
        _stop_activation_guard_pidfd(pidfd)
    with suppress(OSError):
        _kernel_pid_namespace_stop()
    # Enumeration is defense in depth only. The kernel broadcast above is the
    # fail-closed primitive when procfs is missing or unreadable.
    try:
        pids = _pid_namespace_process_ids()
    except OSError:
        pids = ()
    own_pid = os.getpid()
    for pid in pids:
        if pid == own_pid:
            continue
        with suppress(OSError):
            os.kill(pid, signal.SIGSTOP)


def _hold_pid_namespace_for_live_controller(
    stopped_pidfds: tuple[int, ...], resumed_pidfds: tuple[int, ...]
) -> None:
    # An authenticated H command proves the root controller is still alive and
    # owns the transaction lock. Stop the complete private namespace, then
    # resume only that pidfd-bound controller lineage so it can return the
    # fixed failure receipt and invoke the durable retry protocol. Workload
    # writers and PID 1 remain stopped throughout the handoff.
    _stop_pid_namespace_fail_closed(stopped_pidfds)
    for pidfd in resumed_pidfds:
        _resume_activation_guard_pidfd(pidfd)


def _park_pid_namespace_fail_closed(pidfds: tuple[int, ...]) -> None:
    # Both identity-aware hold attempts failed. There is no safe protocol
    # response left: retain the inherited transaction lock and repeatedly stop
    # every other process in the already-proven private PID namespace. Only
    # sandbox/container destruction may terminate this last-resort guardian.
    for ignored in (
        signal.SIGHUP,
        signal.SIGINT,
        signal.SIGQUIT,
        signal.SIGTERM,
        signal.SIGUSR1,
        signal.SIGUSR2,
    ):
        try:
            signal.signal(ignored, signal.SIG_IGN)
        except BaseException:
            pass
    while True:
        # The child inherited the already-proven private PID namespace, and
        # Linux never moves an existing process into another PID namespace.
        # This broadcast therefore cannot reach host processes and cannot stop
        # the guardian itself.
        _stop_pid_namespace_fail_closed(pidfds)
        try:
            time.sleep(max(POLL_SECONDS, 0.01))
        except BaseException:
            pass


def _activation_guard_child(
    command_fd: int,
    acknowledgement_fd: int,
    fence: FenceProof,
    mount_namespace: str,
    lock_fd: int | None,
    supervisor_pidfd: int,
    start_pidfd: int,
    controller_pidfd: int,
    broker_pidfd: int | None,
) -> None:
    retained = [
        command_fd,
        acknowledgement_fd,
        supervisor_pidfd,
        start_pidfd,
        controller_pidfd,
    ]
    if broker_pidfd is not None:
        retained.append(broker_pidfd)
    if lock_fd is not None:
        retained.append(lock_fd)
    _close_activation_guard_inherited_fds(tuple(retained))
    try:
        null_fd = os.open("/dev/null", os.O_RDWR | os.O_CLOEXEC)
        try:
            for target in (0, 1, 2):
                os.dup2(null_fd, target)
        finally:
            if null_fd > 2:
                os.close(null_fd)
        os.write(acknowledgement_fd, b"R")
        command = os.read(command_fd, 1)
        if command == b"D":
            os.write(acknowledgement_fd, b"D")
            os._exit(0)
        live_controller_hold = command == b"H"
        # EOF is the kernel-backed controller-death signal. Any malformed
        # command is treated identically: restore the original exact hold and
        # exclude every other writer before this orphan exits.
        _hold_exact_processes(fence, mount_namespace, None)
        try:
            os.write(acknowledgement_fd, b"H")
        except OSError:
            pass
        os._exit(0)
    except Exception:
        if "live_controller_hold" in locals() and live_controller_hold:
            _hold_pid_namespace_for_live_controller(
                (supervisor_pidfd, start_pidfd),
                tuple(
                    pidfd
                    for pidfd in (broker_pidfd, controller_pidfd)
                    if pidfd is not None
                ),
            )
            with suppress(OSError):
                os.write(acknowledgement_fd, b"H")
            os._exit(0)
        try:
            _hold_exact_processes(fence, mount_namespace, None)
        except Exception:
            _park_pid_namespace_fail_closed((supervisor_pidfd, start_pidfd))
        os._exit(70)


@dataclass
class ActivationGuard:
    pid: int
    command_fd: int
    acknowledgement_fd: int
    fence: FenceProof
    mount_namespace: str
    active: bool = True

    def disarm(self) -> None:
        if not self.active:
            return
        try:
            os.write(self.command_fd, b"D")
            if (
                _read_activation_guard_byte(
                    self.acknowledgement_fd, "activation-guard-disarm-failed"
                )
                != b"D"
            ):
                _fail("activation-guard-disarm-failed")
            _wait_activation_guard_child(self.pid, "activation-guard-disarm-failed")
        finally:
            os.close(self.command_fd)
            os.close(self.acknowledgement_fd)
            self.active = False

    def fail_closed(self) -> None:
        if not self.active:
            return
        child_held = False
        try:
            os.write(self.command_fd, b"H")
            child_held = (
                _read_activation_guard_byte(
                    self.acknowledgement_fd, "activation-guard-hold-failed"
                )
                == b"H"
            )
            _wait_activation_guard_child(self.pid, "activation-guard-hold-failed")
        except ControlError:
            child_held = False
        finally:
            if self.command_fd >= 0:
                os.close(self.command_fd)
            os.close(self.acknowledgement_fd)
            self.active = False
        if not child_held:
            _hold_exact_processes(self.fence, self.mount_namespace, None)


def _start_activation_guard(
    fence: FenceProof, mount_namespace: str, lock_fd: int | None = None
) -> ActivationGuard:
    # The last-resort child may broadcast SIGSTOP through the whole namespace,
    # so establish this safety property before forking it.
    _assert_private_procfs()
    descriptors: list[int] = []
    try:
        supervisor_pidfd = _open_activation_guard_pidfd(fence.supervisor)
        descriptors.append(supervisor_pidfd)
        start_pidfd = _open_activation_guard_pidfd(fence.start)
        descriptors.append(start_pidfd)
        controller_pidfd = _open_activation_guard_current_pidfd()
        descriptors.append(controller_pidfd)
        broker = _transport_broker_reference()
        broker_pidfd = (
            None if broker is None else _open_activation_guard_pidfd(broker)
        )
        if broker_pidfd is not None:
            descriptors.append(broker_pidfd)
        command_read, command_write = os.pipe()
        descriptors.extend((command_read, command_write))
        acknowledgement_read, acknowledgement_write = os.pipe()
        descriptors.extend((acknowledgement_read, acknowledgement_write))
        for fd in (
            command_read,
            command_write,
            acknowledgement_read,
            acknowledgement_write,
        ):
            os.set_inheritable(fd, False)
        pid = os.fork()
    except (OSError, ControlError):
        for fd in descriptors:
            try:
                os.close(fd)
            except OSError:
                pass
        _hold_exact_processes(fence, mount_namespace, None)
        _fail("activation-guard-unavailable")
    if pid == 0:
        os.close(command_write)
        os.close(acknowledgement_read)
        _activation_guard_child(
            command_read,
            acknowledgement_write,
            fence,
            mount_namespace,
            lock_fd,
            supervisor_pidfd,
            start_pidfd,
            controller_pidfd,
            broker_pidfd,
        )
        os._exit(70)
    os.close(supervisor_pidfd)
    os.close(start_pidfd)
    os.close(controller_pidfd)
    if broker_pidfd is not None:
        os.close(broker_pidfd)
    os.close(command_read)
    os.close(acknowledgement_write)
    guard = ActivationGuard(
        pid,
        command_write,
        acknowledgement_read,
        fence,
        mount_namespace,
    )
    if (
        _read_activation_guard_byte(
            acknowledgement_read, "activation-guard-unavailable"
        )
        != b"R"
    ):
        guard.fail_closed()
        _fail("activation-guard-unavailable")
    return guard


def _load_publisher_module() -> object:
    parent_fd = _open_absolute_directory(os.path.dirname(PUBLISHER_MODULE_PATH))
    try:
        parent = os.fstat(parent_fd)
    finally:
        os.close(parent_fd)
    if (
        parent.st_uid != ROOT_UID
        or parent.st_gid != ROOT_GID
        or stat.S_IMODE(parent.st_mode) & 0o022
    ):
        _fail("publisher-protocol-unavailable")
    try:
        fd = os.open(
            PUBLISHER_MODULE_PATH,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
    except OSError:
        _fail("publisher-protocol-unavailable")
    try:
        metadata = os.fstat(fd)
    finally:
        os.close(fd)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != ROOT_UID
        or metadata.st_gid != ROOT_GID
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or metadata.st_nlink != 1
    ):
        _fail("publisher-protocol-unavailable")
    module_name = "_nemoclaw_runtime_state_mutation_publisher"
    spec = importlib.util.spec_from_file_location(module_name, PUBLISHER_MODULE_PATH)
    if spec is None or spec.loader is None:
        _fail("publisher-protocol-unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(module_name, None)
        _fail("publisher-protocol-unavailable")
    return module


def _apply_plan_posture(marker: dict[str, object], posture: str) -> None:
    module = _load_publisher_module()
    apply = getattr(module, "apply_plan_posture", None)
    publisher_error = getattr(module, "PublisherError", None)
    if not callable(apply) or not isinstance(publisher_error, type):
        _fail("publisher-protocol-unavailable")
    try:
        value = apply(marker, posture)
    except publisher_error as error:  # type: ignore[misc]
        code = getattr(error, "code", None)
        if not isinstance(code, str) or PUBLISHER_ERROR_CODE.fullmatch(code) is None:
            _fail("publisher-failed")
        _fail(code)
    except Exception:
        _fail("publisher-failed")
    receipt = _exact_keys(
        value,
        (
            "schemaVersion",
            "protocol",
            "transactionId",
            "nonce",
            "planSha256",
            "projectionSha256",
            "posture",
            "verificationSha256",
        ),
        "publisher-receipt-invalid",
    )
    if (
        type(receipt["schemaVersion"]) is not int
        or receipt["schemaVersion"] != SCHEMA_VERSION
        or receipt["protocol"] != PUBLISHER_PROTOCOL
        or receipt["transactionId"] != marker["transactionId"]
        or receipt["nonce"] != marker["nonce"]
        or receipt["planSha256"] != marker["planSha256"]
        or receipt["projectionSha256"] != marker["projectionSha256"]
        or receipt["posture"] != posture
    ):
        _fail("publisher-receipt-invalid")
    _hex_digest(receipt["verificationSha256"], "publisher-receipt-invalid")


def _activation_from_marker(marker: dict[str, object]) -> ActivationProof | None:
    value = marker["activation"]
    if value is None:
        return None
    activation = _exact_keys(
        value,
        (
            "servicePid",
            "serviceStartIdentity",
            "serviceUid",
            "configurationGeneration",
            "listenerIdentity",
            "healthSha256",
            "startupCheckpointSha256",
            "persistentPids",
            "processes",
        ),
        "activation-marker-invalid",
    )
    pid = activation["servicePid"]
    uid = activation["serviceUid"]
    if type(pid) is not int or pid <= 1 or type(uid) is not int or uid < 0:
        _fail("activation-marker-invalid")
    process_values = activation["processes"]
    persistent_values = activation["persistentPids"]
    if (
        not isinstance(process_values, list)
        or not process_values
        or len(process_values) > MAX_ACTIVATION_PROCESSES
        or not isinstance(persistent_values, list)
        or not persistent_values
        or persistent_values != sorted(set(persistent_values))
        or any(type(pid) is not int or pid <= 1 for pid in persistent_values)
    ):
        _fail("activation-marker-invalid")
    processes = tuple(
        _process_reference_from_value(item, "activation-marker-invalid")
        for item in process_values
    )
    if len({process.pid for process in processes}) != len(processes):
        _fail("activation-marker-invalid")
    proof = ActivationProof(
        pid,
        _decimal_identity(
            activation["serviceStartIdentity"], "activation-marker-invalid"
        ),
        uid,
        _bounded_string(
            activation["configurationGeneration"],
            RUNTIME_ID,
            "activation-marker-invalid",
        ),
        _bounded_string(
            activation["listenerIdentity"], RUNTIME_ID, "activation-marker-invalid"
        ),
        _hex_digest(activation["healthSha256"], "activation-marker-invalid"),
        _hex_digest(activation["startupCheckpointSha256"], "activation-marker-invalid"),
        tuple(persistent_values),
        processes,
    )
    services = [
        process
        for process in processes
        if process.pid == proof.service_pid
        and process.start_identity == proof.service_start_identity
        and process.uids == (proof.service_uid,) * 4
    ]
    if (
        len(services) != 1
        or proof.service_pid not in proof.persistent_pids
        or any(
            pid not in {process.pid for process in processes}
            for pid in proof.persistent_pids
        )
    ):
        _fail("activation-marker-invalid")
    return proof


def _process_matches_activation(
    process: ProcessIdentity, proof: ActivationProof, fence: FenceProof
) -> bool:
    references = [
        reference for reference in proof.processes if reference.pid == proof.service_pid
    ]
    return bool(
        len(references) == 1
        and _process_matches_reference(process, references[0])
        and process.pid == proof.service_pid
        and process.start_identity == proof.service_start_identity
        and process.parent_pid == fence.start.pid
        and process.uids == (proof.service_uid,) * 4
        and _is_hermes_gateway(process, fence)
    )


def _is_hermes_gateway(process: ProcessIdentity, fence: FenceProof) -> bool:
    command = process.command
    direct = bool(
        len(command) == 3
        and command[0] in HERMES_GATEWAY_PATHS
        and command[1:] == (b"gateway", b"run")
    )
    interpreted = bool(
        len(command) == 4
        and command[0].rsplit(b"/", 1)[-1] in (b"python", b"python3")
        and command[1] in HERMES_GATEWAY_PATHS
        and command[2:] == (b"gateway", b"run")
    )
    return bool(
        process.pid > 1
        and process.parent_pid == fence.start.pid
        and process.state != "Z"
        and len(set(process.uids)) == 1
        and process.uids[0] in fence.writer_uids
        and (direct or interpreted)
    )


def _read_stable_regular(path: str, maximum: int) -> bytes:
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    try:
        fd = os.open(path, flags)
    except OSError:
        _fail("activation-config-unavailable")
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            _fail("activation-config-unavailable")
        chunks: list[bytes] = []
        total = 0
        while total <= maximum:
            chunk = os.read(fd, min(65_536, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        after = os.fstat(fd)
        if total > maximum or _stable_stat(before) != _stable_stat(after):
            _fail("activation-config-unavailable")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _configuration_generation() -> str:
    payload = _read_stable_regular(
        HERMES_CONFIG_GENERATION_PATH, MAX_CONFIG_GENERATION_BYTES
    )
    if not payload:
        _fail("activation-config-unavailable")
    return f"sha256:{_sha256(payload)}"


def _tcp_listener_inodes(process: ProcessIdentity, port: int) -> set[str]:
    expected_port = f"{port:04X}"
    listeners: set[str] = set()
    for table in ("tcp", "tcp6"):
        raw = _read_proc_file(os.path.join(PROC_ROOT, str(process.pid), "net", table))
        try:
            lines = raw.decode("ascii", "strict").splitlines()[1:]
            for line in lines:
                fields = line.split()
                if (
                    len(fields) >= 10
                    and fields[1].rsplit(":", 1)[-1].upper() == expected_port
                    and fields[3] == "0A"
                    and DECIMAL.fullmatch(fields[9]) is not None
                    and fields[9] != "0"
                ):
                    listeners.add(fields[9])
        except (UnicodeDecodeError, IndexError):
            _fail("activation-listener-unavailable")
    fd_path = os.path.join(PROC_ROOT, str(process.pid), "fd")
    try:
        entries = os.listdir(fd_path)
    except OSError:
        _fail("activation-listener-unavailable")
    if len(entries) > MAX_PROC_ENTRIES:
        _fail("proc-entry-limit")
    owned: set[str] = set()
    for entry in entries:
        if not entry.isascii() or not entry.isdigit():
            continue
        try:
            target = os.readlink(os.path.join(fd_path, entry))
        except FileNotFoundError:
            continue
        except OSError:
            _fail("activation-listener-unavailable")
        match = re.fullmatch(r"socket:\[([1-9][0-9]*)\]", target)
        if match is not None:
            owned.add(match.group(1))
    return listeners & owned


def _listener_identity(process: ProcessIdentity) -> str:
    before = _process_reference(process)
    listeners = _tcp_listener_inodes(process, HERMES_INTERNAL_PORT)
    after = _recapture_reference(before, "activation-service-drift")
    if len(listeners) != 1 or after.state in ("Z", "X", "x"):
        _fail("activation-listener-unavailable")
    return f"tcp:{HERMES_INTERNAL_PORT}:{next(iter(listeners))}"


def _network_namespace_identity(path: str) -> str:
    try:
        identity = os.readlink(path)
    except OSError:
        return _fail("activation-network-namespace-unavailable")
    if NETWORK_NAMESPACE.fullmatch(identity) is None:
        return _fail("activation-network-namespace-unavailable")
    return identity


def _open_network_namespace(path: str, expected_identity: str) -> int:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    except OSError:
        return _fail("activation-network-namespace-unavailable")
    try:
        if _network_namespace_identity(path) != expected_identity:
            _fail("activation-network-namespace-unavailable")
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _health_status_in_current_namespace() -> int:
    connection = http.client.HTTPConnection(
        "127.0.0.1", HERMES_INTERNAL_PORT, timeout=HEALTH_SECONDS
    )
    response: http.client.HTTPResponse | None = None
    try:
        connection.request("GET", HERMES_HEALTH_PATH)
        response = connection.getresponse()
        response.read(4096)
        if response.status not in (200, 401):
            _fail("activation-health-unavailable")
        return response.status
    except (OSError, http.client.HTTPException):
        return _fail("activation-health-unavailable")
    finally:
        if response is not None:
            response.close()
        connection.close()


def _health_status(process: ProcessIdentity) -> int:
    reference = _process_reference(process)
    current_path = os.path.join(PROC_ROOT, "self", "ns", "net")
    target_path = os.path.join(PROC_ROOT, str(process.pid), "ns", "net")
    current_identity = _network_namespace_identity(current_path)
    target_identity = _network_namespace_identity(target_path)
    _recapture_reference(reference, "activation-service-drift")
    if target_identity == current_identity:
        status = _health_status_in_current_namespace()
        _recapture_reference(reference, "activation-service-drift")
        return status
    if not hasattr(os, "setns"):
        _fail("activation-network-namespace-unavailable")

    current_fd = _open_network_namespace(current_path, current_identity)
    try:
        target_fd = _open_network_namespace(target_path, target_identity)
    except Exception:
        os.close(current_fd)
        raise
    switched = False
    restore_failed = False
    try:
        _recapture_reference(reference, "activation-service-drift")
        try:
            os.setns(target_fd, 0x40000000)
        except OSError:
            _fail("activation-network-namespace-unavailable")
        switched = True
        if _network_namespace_identity(current_path) != target_identity:
            _fail("activation-network-namespace-unavailable")
        status = _health_status_in_current_namespace()
        _recapture_reference(reference, "activation-service-drift")
        return status
    finally:
        if switched:
            try:
                os.setns(current_fd, 0x40000000)
                if _network_namespace_identity(current_path) != current_identity:
                    restore_failed = True
            except (OSError, ControlError):
                restore_failed = True
        os.close(target_fd)
        os.close(current_fd)
        if restore_failed:
            _fail("activation-network-namespace-restore-failed")


def _prove_live_activation(
    marker: dict[str, object],
    fence: FenceProof,
    gateway: ProcessIdentity,
    expected: ActivationProof | None = None,
    checkpoint_sha256: str | None = None,
) -> ActivationProof:
    if not _is_hermes_gateway(gateway, fence):
        _fail("activation-service-unproven")
    reference = _process_reference(gateway)
    generation = _configuration_generation()
    listener = _listener_identity(gateway)
    status = _health_status(gateway)
    current = _recapture_reference(reference, "activation-service-drift")
    if current.state in ("T", "t"):
        _fail("activation-health-unavailable")
    if generation != _configuration_generation() or listener != _listener_identity(
        current
    ):
        _fail("activation-proof-drift")
    health = _sha256(
        _json_bytes(
            {
                "schemaVersion": SCHEMA_VERSION,
                "nonce": marker["nonce"],
                "serviceStartIdentity": gateway.start_identity,
                "configurationGeneration": generation,
                "listenerIdentity": listener,
                "status": status,
            }
        )
    )
    checkpoint = (
        expected.startup_checkpoint_sha256
        if expected is not None
        else checkpoint_sha256
    )
    if checkpoint is None or HEX_64.fullmatch(checkpoint) is None:
        _fail("activation-checkpoint-invalid")
    proof = ActivationProof(
        gateway.pid,
        gateway.start_identity,
        gateway.uids[0],
        generation,
        listener,
        health,
        checkpoint,
        (gateway.pid,),
        (reference,),
    )
    if expected is not None and (
        proof.service_pid != expected.service_pid
        or proof.service_start_identity != expected.service_start_identity
        or proof.service_uid != expected.service_uid
        or proof.configuration_generation != expected.configuration_generation
        or proof.listener_identity != expected.listener_identity
        or proof.health_sha256 != expected.health_sha256
        or proof.startup_checkpoint_sha256 != expected.startup_checkpoint_sha256
    ):
        _fail("activation-proof-drift")
    return proof


def _activation_tree(
    fence: FenceProof,
) -> tuple[ProcessIdentity | None, tuple[ProcessIdentity, ...]]:
    writers = _capture_writer_processes(fence.writer_uids)
    if len(writers) > MAX_ACTIVATION_PROCESSES + 1:
        _fail("activation-process-limit")
    by_pid = {process.pid: process for process in writers}
    start = by_pid.get(fence.start.pid)
    if start is None or not _process_matches_reference(start, fence.start):
        _fail("start-process-identity-drift")
    tree: list[ProcessIdentity] = []
    for process in writers:
        if process.pid == fence.start.pid:
            continue
        ancestor = process
        seen: set[int] = set()
        while ancestor.parent_pid != fence.start.pid:
            if ancestor.pid in seen or ancestor.parent_pid not in by_pid:
                _fail("activation-writer-drift")
            seen.add(ancestor.pid)
            ancestor = by_pid[ancestor.parent_pid]
        tree.append(process)
    gateways = [process for process in tree if _is_hermes_gateway(process, fence)]
    if len(gateways) > 1:
        _fail("activation-service-ambiguous")
    return (gateways[0] if gateways else None), tuple(
        sorted(tree, key=lambda process: process.pid)
    )


def _wait_for_activation(
    marker: dict[str, object], fence: FenceProof, checkpoint_sha256: str
) -> ActivationProof:
    deadline = time.monotonic() + ACTIVATION_SECONDS
    while True:
        _recapture_supervisor(fence.supervisor)
        gateway, _tree = _activation_tree(fence)
        if gateway is not None:
            try:
                return _prove_live_activation(
                    marker,
                    fence,
                    gateway,
                    checkpoint_sha256=checkpoint_sha256,
                )
            except ControlError as error:
                if error.code not in (
                    "activation-health-unavailable",
                    "activation-listener-unavailable",
                ):
                    raise
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("activation-timeout")
        time.sleep(min(POLL_SECONDS, remaining))


def _freeze_activation(
    marker: dict[str, object], fence: FenceProof, live: ActivationProof
) -> ActivationProof:
    _stop_reference(fence.start)
    gateway, tree = _activation_tree(fence)
    if gateway is None:
        _fail("activation-service-drift")
    live_reference = live.processes[0]
    if not _process_matches_reference(gateway, live_reference):
        _fail("activation-service-drift")
    references = tuple(_process_reference(process) for process in tree)
    for reference in references:
        _stop_reference(reference)
    frozen = ActivationProof(
        live.service_pid,
        live.service_start_identity,
        live.service_uid,
        live.configuration_generation,
        live.listener_identity,
        live.health_sha256,
        live.startup_checkpoint_sha256,
        live.persistent_pids,
        references,
    )
    _assert_writer_exclusion(fence.writer_uids, _held_writer_references(fence, frozen))
    service = _recapture_reference(live_reference, "activation-service-drift")
    if (
        not _process_matches_activation(service, frozen, fence)
        or service.state not in ("T", "t")
        or _configuration_generation() != frozen.configuration_generation
        or _listener_identity(service) != frozen.listener_identity
    ):
        _fail("activation-proof-drift")
    return frozen


def _wait_for_startup_checkpoint(marker: dict[str, object], fence: FenceProof) -> str:
    deadline = time.monotonic() + ACTIVATION_SECONDS
    while True:
        supervisor = _recapture_supervisor(fence.supervisor)
        start = _recapture_reference(fence.start, "start-process-identity-drift")
        selected = _read_startup_candidate(marker, fence, required=False)
        if selected is not None and start.state in ("T", "t"):
            if supervisor.state not in ("T", "t"):
                _fail("process-fence-breached")
            _candidate, payload = selected
            return _sha256(payload)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("activation-checkpoint-timeout")
        time.sleep(min(POLL_SECONDS, remaining))


def _reset_activation_attempt(
    durable_fd: int, marker: dict[str, object], fence: FenceProof
) -> None:
    retry_payload = _publish_activation_retry(durable_fd, marker, fence)
    if _read_startup_retry_ack(marker, fence, retry_payload) is None:
        # The retry receipt is root-owned and bound to the current permit and
        # optional checkpoint. Queue the signal while the exact shell is held;
        # its immutable trap validates that receipt before execing the fixed
        # entrypoint path with the same PID/starttime/parent identity.
        for reference in fence.start_support:
            _resume_reference(reference)
        _signal_reference(fence.start, signal.SIGUSR2)
        _signal_reference(fence.start, signal.SIGCONT)
        _wait_for_startup_retry_ack(marker, fence, retry_payload)
    else:
        _recapture_reference(fence.start, "activation-retry-identity-drift")
    _cleanup_activation_protocol(durable_fd, marker)


def _activate_exact(
    durable_fd: int,
    marker: dict[str, object],
    fence: FenceProof,
    lock_fd: int | None = None,
) -> ActivationProof:
    mount_namespace = str(marker["mountNamespace"])
    pending = _activation_attempt_pending(durable_fd, marker, fence)
    if lock_fd is None:
        guard = _start_activation_guard(fence, mount_namespace)
    else:
        guard = _start_activation_guard(fence, mount_namespace, lock_fd)
    try:
        if pending:
            _hold_exact_processes(fence, mount_namespace, None)
            _reset_activation_attempt(durable_fd, marker, fence)
        else:
            _assert_exact_process_fence(fence, mount_namespace, None)
        _publish_activation_permit(durable_fd, marker, fence)
        for reference in fence.start_support:
            _resume_reference(reference)
        _signal_reference(fence.start, signal.SIGCONT)
        checkpoint_sha256 = _wait_for_startup_checkpoint(marker, fence)
        live = _wait_for_activation(marker, fence, checkpoint_sha256)
        frozen = _freeze_activation(marker, fence, live)
        _verify_activation_checkpoint(marker, fence, frozen)
        # From this point to durable marker publication no process is resumed.
        # Waiting for guardian disarm therefore cannot open a runnable-writer
        # crash window, while every earlier controller death is pipe EOF and
        # forces the guardian to restore the exact original hold.
        guard.disarm()
        return frozen
    except BaseException:
        guard.fail_closed()
        raise


def _activation_payload(proof: ActivationProof) -> dict[str, object]:
    return {
        "servicePid": proof.service_pid,
        "serviceStartIdentity": proof.service_start_identity,
        "serviceUid": proof.service_uid,
        "configurationGeneration": proof.configuration_generation,
        "listenerIdentity": proof.listener_identity,
        "healthSha256": proof.health_sha256,
        "startupCheckpointSha256": proof.startup_checkpoint_sha256,
        "persistentPids": list(proof.persistent_pids),
        "processes": [
            _process_reference_payload(process) for process in proof.processes
        ],
    }


def _activation_receipt_payload(marker: dict[str, object]) -> dict[str, object]:
    fence = _fence_from_value(marker["fence"])
    activation = _activation_from_marker(marker)
    if marker["phase"] != "activation-proven" or activation is None:
        _fail("activation-marker-invalid")
    marker_payload = _json_bytes(marker) + b"\n"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "nonce": marker["nonce"],
        "markerSha256": _sha256(marker_payload),
        "supervisorStartIdentity": fence.supervisor.start_identity,
        "startPid": fence.start.pid,
        "startStartIdentity": fence.start.start_identity,
        "activation": _activation_payload(activation),
    }


def _publish_activation_receipt(runtime_fd: int, marker: dict[str, object]) -> None:
    receipt = _activation_receipt_payload(marker)
    _atomic_write(
        runtime_fd,
        ACTIVATION_RECEIPT_NAME,
        _json_bytes(receipt) + b"\n",
    )


def _verify_activation_receipt(runtime_fd: int, marker: dict[str, object]) -> None:
    raw = _read_private_file(runtime_fd, ACTIVATION_RECEIPT_NAME, MAX_MARKER_BYTES)
    expected = _json_bytes(_activation_receipt_payload(marker)) + b"\n"
    if raw is None or not secrets.compare_digest(raw, expected):
        _fail("activation-receipt-mismatch")


def _write_phase(
    durable_fd: int,
    runtime_fd: int,
    marker: dict[str, object],
    phase: Phase,
    activation: dict[str, object] | None = None,
) -> dict[str, object]:
    updated = {**marker, "phase": phase, "activation": activation}
    payload = _write_marker(durable_fd, updated)
    _publish_sentinel(runtime_fd, payload, str(updated["nonce"]))
    return updated


def _load_exact_active(
    durable_fd: int, runtime_fd: int, request: StatusRequest
) -> tuple[dict[str, object], bytes]:
    marker = _load_marker(durable_fd)
    if marker is None:
        _fail("no-active-fence")
    if not _marker_matches_status(marker, request):
        _fail("active-fence-binding-mismatch")
    payload = _json_bytes(marker) + b"\n"
    _verify_sentinel(runtime_fd, payload, str(marker["nonce"]))
    return marker, payload


def _assert_active_state(marker: dict[str, object], runtime_fd: int) -> None:
    fence = _fence_from_value(marker["fence"])
    activation = _activation_from_marker(marker)
    _assert_exact_process_fence(fence, str(marker["mountNamespace"]), activation)
    if activation is None:
        return
    _verify_activation_checkpoint(marker, fence, activation)
    service = _recapture_reference(
        next(
            process
            for process in activation.processes
            if process.pid == activation.service_pid
        ),
        "activation-service-drift",
    )
    if (
        service.state not in ("T", "t")
        or not _process_matches_activation(service, activation, fence)
        or _configuration_generation() != activation.configuration_generation
        or _listener_identity(service) != activation.listener_identity
    ):
        _fail("activation-proof-drift")
    if marker["phase"] == "activation-proven":
        _verify_activation_receipt(runtime_fd, marker)


def _reference_is_terminated(reference: ProcessReference) -> bool:
    process = _capture_process(reference.pid)
    if process is None:
        return True
    if process.state == "Z" and (
        process.pid == reference.pid
        and process.start_identity == reference.start_identity
        and process.parent_pid == reference.parent_pid
        and process.proc_device == reference.proc_device
        and process.proc_inode == reference.proc_inode
    ):
        return True
    if not _process_matches_reference(process, reference):
        _fail("activation-process-drift")
    return False


def _retire_activation_tree(
    marker: dict[str, object], runtime_fd: int, activation: ActivationProof
) -> None:
    fence = _fence_from_value(marker["fence"])
    _prove_fence_shape(fence, str(marker["mountNamespace"]))
    _wait_for_host_stopped_supervisor(fence.supervisor)
    _stop_reference(fence.start)
    support_by_pid = {reference.pid: reference for reference in fence.start_support}
    retired: list[ProcessReference] = []
    for reference in activation.processes:
        support = support_by_pid.get(reference.pid)
        if support is not None:
            if reference != support:
                _fail("activation-process-drift")
            _stop_reference(support)
            continue
        retired.append(reference)
        if not _reference_is_terminated(reference):
            _signal_reference(reference, signal.SIGKILL)
    deadline = time.monotonic() + KILL_SECONDS
    while not all(
        _reference_is_terminated(reference) for reference in retired
    ):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("activation-retirement-timeout")
        time.sleep(min(POLL_SECONDS, remaining))
    held = (fence.start, *fence.start_support)
    _exclude_writers(fence.writer_uids, held)
    _assert_writer_exclusion(fence.writer_uids, held)
    _unlink_private(runtime_fd, ACTIVATION_RECEIPT_NAME)


def _acquire(
    durable_fd: int, runtime_fd: int, request: AcquireRequest
) -> dict[str, object]:
    mount_namespace, state_root_device, state_root_inode = _capture_runtime_binding(
        request.state_root
    )
    marker = _load_marker(durable_fd)
    if marker is not None:
        if not _marker_matches_acquire(marker, request):
            _fail("active-fence-binding-mismatch")
        _assert_runtime_binding(marker)
        payload = _json_bytes(marker) + b"\n"
        _publish_sentinel(runtime_fd, payload, request.nonce)
        fence = _fence_from_value(marker["fence"])
        activation = _activation_from_marker(marker)
        _hold_exact_processes(fence, mount_namespace, activation)
        if marker["phase"] == "activation-proven":
            _publish_activation_receipt(runtime_fd, marker)
        _assert_active_state(marker, runtime_fd)
        return marker
    released = _load_released_receipt(durable_fd)
    if released is not None and released["transactionId"] == request.transaction_id:
        _fail(
            "transaction-release-pending"
            if released["releaseState"] != "complete"
            else "transaction-already-released"
        )
    fence = _discover_fence(mount_namespace)
    _unlink_private(runtime_fd, ACTIVATION_RECEIPT_NAME)
    marker = _marker_payload(
        request,
        "fenced",
        mount_namespace,
        state_root_device,
        state_root_inode,
        _fence_payload(fence),
    )
    marker_payload = _write_marker(durable_fd, marker)
    _publish_sentinel(runtime_fd, marker_payload, request.nonce)
    _hold_exact_processes(fence, mount_namespace, None)
    _assert_runtime_binding(marker)
    _assert_active_state(marker, runtime_fd)
    if released is not None:
        _unlink_private(durable_fd, RELEASED_RECEIPT_NAME)
    return marker


def _recover(
    durable_fd: int, runtime_fd: int, request: StatusRequest
) -> dict[str, object]:
    marker = _load_marker(durable_fd)
    sentinel = _read_private_file(runtime_fd, SENTINEL_NAME, MAX_MARKER_BYTES)
    if marker is None:
        if sentinel is not None:
            _fail("orphan-sentinel")
        _fail("no-active-fence")
    if not _marker_matches_status(marker, request):
        _fail("active-fence-binding-mismatch")
    _assert_runtime_binding(marker)
    payload = _json_bytes(marker) + b"\n"
    _publish_sentinel(runtime_fd, payload, str(marker["nonce"]))
    fence = _fence_from_value(marker["fence"])
    activation = _activation_from_marker(marker)
    if marker["phase"] == "rolled-back" and activation is not None:
        _retire_activation_tree(marker, runtime_fd, activation)
        marker = _write_phase(durable_fd, runtime_fd, marker, "rolled-back", None)
        activation = None
    else:
        _hold_exact_processes(fence, str(marker["mountNamespace"]), activation)
    if marker["phase"] == "activation-proven":
        _publish_activation_receipt(runtime_fd, marker)
    else:
        _unlink_private(runtime_fd, ACTIVATION_RECEIPT_NAME)
    _assert_active_state(marker, runtime_fd)
    return marker


def _wait_for_reference_running(reference: ProcessReference) -> ProcessIdentity:
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    while True:
        process = _recapture_reference(reference)
        if process.state not in ("T", "t"):
            return process
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("process-state-timeout")
        time.sleep(min(POLL_SECONDS, remaining))


def _resume_reference(reference: ProcessReference) -> ProcessIdentity:
    process = _recapture_reference(reference)
    if process.state in ("T", "t"):
        _signal_reference(reference, signal.SIGCONT)
    return _wait_for_reference_running(reference)


def _resume_supervisor(reference: ProcessReference) -> ProcessIdentity:
    process = _recapture_supervisor(reference)
    if process.state in ("T", "t"):
        _signal_exact_process(process, signal.SIGCONT)
    deadline = time.monotonic() + PROCESS_STATE_SECONDS
    while True:
        process = _recapture_supervisor(reference)
        if process.state not in ("T", "t"):
            return process
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("process-state-timeout")
        time.sleep(min(POLL_SECONDS, remaining))


def _prove_released_activation(
    marker: dict[str, object], fence: FenceProof, activation: ActivationProof
) -> None:
    persistent = set(activation.persistent_pids)
    for reference in activation.processes:
        if reference.pid not in persistent:
            continue
        process = _recapture_reference(reference, "activation-process-drift")
        if process.state in ("T", "t"):
            _fail("activation-process-stopped")
    start = _recapture_reference(fence.start, "start-process-identity-drift")
    if start.state in ("T", "t"):
        _fail("start-process-stopped")
    supervisor = _recapture_supervisor(fence.supervisor)
    if supervisor.state in ("T", "t"):
        _fail("supervisor-process-stopped")
    service_reference = next(
        process
        for process in activation.processes
        if process.pid == activation.service_pid
    )
    service = _recapture_reference(service_reference, "activation-service-drift")
    _prove_live_activation(marker, fence, service, activation)


def _prove_parent_acknowledged_activation(
    marker: dict[str, object], fence: FenceProof, activation: ActivationProof
) -> None:
    persistent = set(activation.persistent_pids)
    for reference in activation.processes:
        if reference.pid not in persistent:
            continue
        process = _recapture_reference(reference, "activation-process-drift")
        if process.state in ("T", "t"):
            _fail("activation-process-stopped")
    start = _recapture_reference(fence.start, "start-process-identity-drift")
    if start.state not in ("T", "t"):
        _fail("activation-release-parent-running")
    supervisor = _recapture_supervisor(fence.supervisor)
    if supervisor.state in ("T", "t"):
        _fail("supervisor-process-stopped")
    service_reference = next(
        process
        for process in activation.processes
        if process.pid == activation.service_pid
    )
    service = _recapture_reference(service_reference, "activation-service-drift")
    _prove_live_activation(marker, fence, service, activation)


def _release_activation_hold(durable_fd: int, marker: dict[str, object]) -> None:
    fence = _fence_from_value(marker["fence"])
    activation = _activation_from_marker(marker)
    if activation is None:
        _fail("activation-marker-invalid")
    _verify_activation_checkpoint(marker, fence, activation)
    _publish_activation_release(durable_fd, marker, fence, activation)
    release_payload = _canonical_protocol_payload(
        _activation_release_payload(marker, fence, activation)
    )
    _prove_fence_shape(fence, str(marker["mountNamespace"]))
    acknowledged = _read_startup_release_ack(
        marker, fence, release_payload
    ) is not None
    start = _recapture_reference(fence.start, "start-process-identity-drift")
    parent_already_acknowledged = acknowledged and start.state in ("T", "t")
    persistent = set(activation.persistent_pids)
    for reference in activation.processes:
        if _reference_is_terminated(reference):
            if reference.pid in persistent:
                _fail("activation-process-drift")
            continue
        _resume_reference(reference)
    if not parent_already_acknowledged:
        _resume_reference(fence.start)
    # Resume the exact pinned OpenShell supervisor last. Until the proven
    # workload is live, keeping PID 1 stopped prevents it from advertising a
    # transient Ready state or admitting unrelated sandbox commands.
    _resume_supervisor(fence.supervisor)
    _wait_for_startup_release_ack(marker, fence, release_payload)
    _prove_parent_acknowledged_activation(marker, fence, activation)


def _resume_acknowledged_parent(marker: dict[str, object]) -> None:
    fence = _fence_from_value(marker["fence"])
    activation = _activation_from_marker(marker)
    if activation is None:
        _fail("activation-marker-invalid")
    _resume_reference(fence.start)
    _prove_released_activation(marker, fence, activation)


def _complete_released_receipt(
    durable_fd: int,
    runtime_fd: int,
    receipt: dict[str, object],
) -> dict[str, object]:
    marker = receipt["marker"]
    if not isinstance(marker, dict):
        _fail("released-receipt-invalid")
    if receipt["releaseState"] == "intent":
        _assert_runtime_binding(marker)
        _release_activation_hold(durable_fd, marker)
        receipt = _write_released_receipt(
            durable_fd,
            marker,
            str(receipt["completedLedgerSha256"]),
            "acknowledged",
        )
    if receipt["releaseState"] == "acknowledged":
        _assert_runtime_binding(marker)
        _resume_acknowledged_parent(marker)
        receipt = _write_released_receipt(
            durable_fd,
            marker,
            str(receipt["completedLedgerSha256"]),
            "complete",
        )
    _finish_released_cleanup(durable_fd, runtime_fd, marker)
    return marker


def _run_locked(
    action: Action,
    request: Request,
    durable_fd: int,
    runtime_fd: int,
    lock_fd: int | None = None,
) -> dict[str, object]:
    if action == "acquire":
        if not isinstance(request, AcquireRequest):
            _fail("envelope-schema")
        return _acquire(durable_fd, runtime_fd, request)
    if not isinstance(request, StatusRequest):
        _fail("envelope-schema")
    released = _load_released_receipt(durable_fd)
    if released is not None and _released_receipt_matches_status(released, request):
        if action not in ("recover", "release"):
            _fail("fence-already-released")
        return _complete_released_receipt(durable_fd, runtime_fd, released)
    if action == "recover":
        return _recover(durable_fd, runtime_fd, request)

    marker, _marker_payload = _load_exact_active(durable_fd, runtime_fd, request)
    _assert_runtime_binding(marker)
    fence = _fence_from_value(marker["fence"])
    activation = _activation_from_marker(marker)
    phase = marker["phase"]
    if action == "assert":
        if phase == "rolled-back" and activation is not None:
            _fail("activation-retirement-pending")
        _assert_active_state(marker, runtime_fd)
        return marker
    if action == "publish":
        if phase == "published":
            _assert_active_state(marker, runtime_fd)
            return marker
        if phase != "fenced":
            _fail("publish-phase-invalid")
        _assert_active_state(marker, runtime_fd)
        _apply_plan_posture(marker, str(marker["target"]))
        _assert_runtime_binding(marker)
        _assert_active_state(marker, runtime_fd)
        return _write_phase(durable_fd, runtime_fd, marker, "published")
    if action == "rollback":
        if phase == "rolled-back" and activation is None:
            _assert_active_state(marker, runtime_fd)
            return marker
        if phase == "rolled-back" and activation is not None:
            _retire_activation_tree(marker, runtime_fd, activation)
            return _write_phase(durable_fd, runtime_fd, marker, "rolled-back", None)
        if phase not in ("fenced", "published", "activation-proven"):
            _fail("rollback-phase-invalid")
        _assert_active_state(marker, runtime_fd)
        _apply_plan_posture(marker, str(marker["rollback"]))
        _assert_runtime_binding(marker)
        _assert_active_state(marker, runtime_fd)
        if activation is None:
            return _write_phase(durable_fd, runtime_fd, marker, "rolled-back")
        pending = _write_phase(
            durable_fd,
            runtime_fd,
            marker,
            "rolled-back",
            _activation_payload(activation),
        )
        _retire_activation_tree(pending, runtime_fd, activation)
        return _write_phase(durable_fd, runtime_fd, pending, "rolled-back", None)
    if action == "activate":
        if phase == "activation-proven":
            _assert_active_state(marker, runtime_fd)
            return marker
        if phase not in ("published", "rolled-back"):
            _fail("activation-phase-invalid")
        if activation is not None:
            _retire_activation_tree(marker, runtime_fd, activation)
            marker = _write_phase(durable_fd, runtime_fd, marker, "rolled-back", None)
        if lock_fd is None:
            proof = _activate_exact(durable_fd, marker, fence)
        else:
            proof = _activate_exact(durable_fd, marker, fence, lock_fd)
        _assert_runtime_binding(marker)
        activated = _write_phase(
            durable_fd,
            runtime_fd,
            marker,
            "activation-proven",
            _activation_payload(proof),
        )
        _publish_activation_receipt(runtime_fd, activated)
        _assert_active_state(activated, runtime_fd)
        return activated
    if action == "release":
        if phase != "activation-proven" or request.completed_ledger_sha256 is None:
            _fail("release-phase-invalid")
        if activation is None:
            _fail("activation-marker-invalid")
        if request.activation_provider_handle is None or not secrets.compare_digest(
            request.activation_provider_handle, _activation_provider_handle(marker)
        ):
            _fail("activation-provider-handle-mismatch")
        _assert_active_state(marker, runtime_fd)
        _assert_runtime_binding(marker)
        released = _write_released_receipt(
            durable_fd,
            marker,
            request.completed_ledger_sha256,
            "intent",
        )
        return _complete_released_receipt(durable_fd, runtime_fd, released)
    raise AssertionError(action)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Control one exact runtime state mutation",
        allow_abbrev=False,
    )
    parser.add_argument("action", choices=tuple(sorted(ACTIONS)))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    action: Action = args.action
    try:
        if os.geteuid() != ROOT_UID:
            _fail("root-required")
        request = _parse_request(action, _read_stdin())
        durable_fd, runtime_fd = _open_control_directories()
        lock_fd = -1
        try:
            lock_fd = _open_lock(durable_fd)
            receipt = _run_locked(action, request, durable_fd, runtime_fd, lock_fd)
        finally:
            if lock_fd >= 0:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)
            os.close(runtime_fd)
            os.close(durable_fd)
        print(_json_bytes(_receipt_payload(receipt)).decode("utf-8"))
        return 0
    except ControlError as error:
        print(
            _json_bytes(
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "action": action,
                    "status": "failed",
                    "code": error.code,
                }
            ).decode("utf-8"),
            file=sys.stderr,
        )
        return 1
    except (OSError, ValueError):
        print(
            _json_bytes(
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "action": action,
                    "status": "failed",
                    "code": "control-io-failed",
                }
            ).decode("utf-8"),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
