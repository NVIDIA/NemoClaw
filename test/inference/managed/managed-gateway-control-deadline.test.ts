// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "../../..", "scripts", "managed-gateway-control.py");

const CONTROL_DEADLINE_HARNESS = String.raw`
import importlib.util
import json
import os
import sys
import tempfile

spec = importlib.util.spec_from_file_location("managed_control_deadline", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)


def identity(pid, start_time, parent_pid, role):
    uid = os.geteuid()
    return control.ProcessIdentity(
        pid=pid,
        start_time=str(start_time),
        parent_pid=parent_pid,
        state="S",
        uids=(uid,) * 4,
        namespace_pid=pid,
        namespace_inode=1,
        cmdline=(role.encode("ascii"),),
        proc_device=1,
        proc_inode=pid,
    )


def error_code(operation):
    try:
        operation()
        return "accepted"
    except control.ControlError as error:
        return error.code


gateway = identity(41, 333, 40, "gateway")
replacement = identity(43, 555, 40, "gateway")
supervisor = identity(40, 222, 1, "supervisor")
controller = identity(999, 777, 1, "controller")
forwarding_clock = [10.0]
control.time.monotonic = lambda: forwarding_clock[0]
lock = object()
lease = object()
observed = {
    "lock": [],
    "candidates": [],
    "preflight": [],
    "publication": [],
    "termination": [],
    "replacement": [],
    "cleared": [],
}


class FakeProcReader:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def record_candidates(_reader, _supervisor, _spec, recovery_deadline=None):
    observed["candidates"].append(recovery_deadline)
    return [gateway]


def record_preflight(_spec, _reader, _supervisor, recovery_deadline=None):
    observed["preflight"].append(recovery_deadline)


def record_publication(
    received_lock,
    received_gateway,
    received_controller,
    recovery_deadline=None,
):
    assert received_lock is lock
    assert received_gateway is gateway
    assert received_controller is controller
    observed["publication"].append(recovery_deadline)
    return lease


def record_termination(_reader, received_gateway, recovery_deadline=None):
    assert received_gateway is gateway
    observed["termination"].append(recovery_deadline)


def record_replacement(
    _reader,
    _supervisor,
    _spec,
    received_gateway,
    _timeout_seconds=control.RECOVERY_TIMEOUT_SECONDS,
    _require_auxiliary_health=False,
    recovery_deadline=None,
):
    assert received_gateway is gateway
    observed["replacement"].append(recovery_deadline)
    return replacement


real_acquire_lock = control._acquire_expected_exit_lock
real_publish_lease = control._publish_expected_exit_lease
real_close_lock = control._close_expected_exit_lock
real_clear_lease = control._clear_expected_exit_lease
real_terminate_gateway = control._terminate_gateway
control.ProcReader = FakeProcReader
control._acquire_expected_exit_lock = lambda recovery_deadline: (
    observed["lock"].append(recovery_deadline) or lock
)
control._close_expected_exit_lock = lambda _lock: None
control._clear_expected_exit_lease = lambda received_lease: observed["cleared"].append(
    received_lease is lease
)
control._detect_agent = lambda: "hermes"
control._discover_supervisor = lambda _reader: supervisor
control._agent_spec = lambda *_args: control.AgentSpec("hermes", 18642)
control._gateway_candidates = record_candidates
control._preflight = record_preflight
control._controller_process_identity = lambda _reader: controller
control._publish_expected_exit_lease = record_publication
control._terminate_gateway = record_termination
control._wait_for_healthy_gateway = record_replacement

forwarded_result = control._control("restart", "a" * 64)
forwarded_deadlines = [
    *observed["lock"],
    *observed["candidates"],
    *observed["preflight"],
    *observed["publication"],
    *observed["termination"],
    *observed["replacement"],
]
shared_deadline = (
    len(forwarded_deadlines) == 6
    and len(set(forwarded_deadlines)) == 1
    and forwarded_deadlines[0] > forwarding_clock[0]
    and observed["cleared"] == [True]
)

preflight_clock = [0.0]
control.time.monotonic = lambda: preflight_clock[0]
fixed_deadlines = []
hash_checks = []


class EnvironmentReader:
    def read_stable_file(self, _identity, _name, _limit):
        return b"SAFE=1\0"


real_system_path = control._system_path
real_exists = control.os.path.exists
control._system_path = lambda value: value
control.os.path.exists = lambda _path: True
control._run_fixed_validator = (
    lambda _script, _arguments, recovery_deadline=None: fixed_deadlines.append(
        recovery_deadline
    )
)


def expire_runtime_validation(_script, _environment):
    preflight_clock[0] = 1.0


control._validate_runtime_environment = expire_runtime_validation
control._verify_locked_hermes_hash = lambda: hash_checks.append("called")
preflight_after_validation = error_code(
    lambda: control._hermes_preflight(EnvironmentReader(), supervisor, 1.0)
)
after_validation_result = [
    preflight_after_validation,
    fixed_deadlines == [1.0],
    len(hash_checks),
]
fixed_deadlines.clear()
preflight_before_validation = error_code(
    lambda: control._hermes_preflight(EnvironmentReader(), supervisor, 1.0)
)
before_validation_result = [
    preflight_before_validation,
    len(fixed_deadlines),
]
control._system_path = real_system_path
control.os.path.exists = real_exists

control._acquire_expected_exit_lock = real_acquire_lock
control._publish_expected_exit_lease = real_publish_lease
control._close_expected_exit_lock = real_close_lock
control._clear_expected_exit_lease = real_clear_lease
control._terminate_gateway = real_terminate_gateway
with tempfile.TemporaryDirectory() as root:
    proc_root = os.path.join(root, "proc")
    system_root = os.path.join(root, "system")
    os.makedirs(proc_root)
    os.makedirs(os.path.join(system_root, "run"))
    os.environ["NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST"] = "1"
    os.environ["NEMOCLAW_MANAGED_CONTROL_PROC_ROOT"] = proc_root
    os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = system_root
    marker_path = os.path.join(
        system_root,
        "run/nemoclaw",
        control.EXPECTED_EXIT_MARKER_NAME,
    )
    marker_clock = [0.0]
    control.time.monotonic = lambda: marker_clock[0]
    publication_lock = control._acquire_expected_exit_lock(1.0)
    real_path_matches = control._lease_path_matches

    def expire_after_marker_validation(*arguments):
        result = real_path_matches(*arguments)
        marker_clock[0] = 1.0
        return result

    control._lease_path_matches = expire_after_marker_validation
    late_lease = None
    try:
        late_lease = control._publish_expected_exit_lease(
            publication_lock,
            gateway,
            controller,
            1.0,
        )
        publication_status = "accepted"
    except control.ControlError as error:
        publication_status = error.code
    finally:
        control._lease_path_matches = real_path_matches
        if late_lease is None:
            control._close_expected_exit_lock(publication_lock)
        else:
            control._clear_expected_exit_lease(late_lease)
    publication_result = [
        publication_status,
        not os.path.exists(marker_path),
    ]

closed_pidfds = []
control.os.close = lambda pidfd: closed_pidfds.append(pidfd)
control._pidfd_open = lambda _pid: 50
control._pidfd_exited = lambda _pidfd, _timeout: False
termination_signals = []
control._send_pidfd = lambda _pidfd, signum: (
    termination_signals.append(int(signum)) or True
)
termination_clock = [1.0]
control.time.monotonic = lambda: termination_clock[0]
recapture_calls = []


def record_recapture(_reader, _identity, *, deadline=None):
    recapture_calls.append(deadline)
    return gateway


control._recapture_exact_identity = record_recapture
before_recapture_status = error_code(
    lambda: control._terminate_gateway(object(), gateway, 1.0)
)
before_recapture_result = [
    before_recapture_status,
    list(recapture_calls),
    list(termination_signals),
]

termination_clock[0] = 0.0
recapture_calls.clear()
termination_signals.clear()


def expire_during_recapture(_reader, _identity, *, deadline=None):
    recapture_calls.append(deadline)
    termination_clock[0] = 1.0
    return gateway


control._recapture_exact_identity = expire_during_recapture
during_recapture_status = error_code(
    lambda: control._terminate_gateway(object(), gateway, 1.0)
)
during_recapture_result = [
    during_recapture_status,
    list(recapture_calls),
    list(termination_signals),
]

print(json.dumps({
    "forwarding": [forwarded_result, shared_deadline],
    "preflight_after_validation": after_validation_result,
    "preflight_before_validation": before_validation_result,
    "late_publication": publication_result,
    "termination_before_recapture": before_recapture_result,
    "termination_during_recapture": during_recapture_result,
}, sort_keys=True))
`;

const HTTP_DEADLINE_HARNESS = String.raw`
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("managed_control_http_deadline", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

real_connection = control.http.client.HTTPConnection
clock = [0.0]
control.time.monotonic = lambda: clock[0]
active = {}


def advance(duration, timeout=None):
    if timeout is not None and duration >= timeout:
        clock[0] += timeout
        raise control.socket.timeout("deadline reached")
    clock[0] += duration


class ScriptedSocket:
    def __init__(self, chunks, request_delay, close_error=False):
        self.chunks = list(chunks)
        self.request_delay = request_delay
        self.close_error = close_error
        self.timeout = None
        self.closed = False

    def settimeout(self, timeout):
        self.timeout = timeout

    def sendall(self, _data):
        advance(self.request_delay, self.timeout)

    def recv_into(self, buffer):
        if not self.chunks:
            return 0
        delay, payload = self.chunks.pop(0)
        advance(delay, self.timeout)
        count = min(len(buffer), len(payload))
        buffer[:count] = payload[:count]
        if count < len(payload):
            self.chunks.insert(0, (0.0, payload[count:]))
        return count

    def close(self):
        self.closed = True
        if self.close_error:
            raise OSError("transport already closed")


class ScriptedConnection(real_connection):
    def connect(self):
        advance(active["connect_delay"], self.timeout)
        self.sock = ScriptedSocket(
            active["chunks"],
            active["request_delay"],
            active.get("close_error", False),
        )


def byte_chunks(payload, delay):
    return [(delay, bytes((value,))) for value in payload]


status = b"HTTP/1.1 200 OK\r\n"
unauthorized = b"HTTP/1.1 401 Unauthorized\r\n"
headers = b"Content-Length: 4\r\n\r\n"
body = b"pong"
complete = status + headers + body
control.http.client.HTTPConnection = ScriptedConnection


def check(scenario):
    active.clear()
    active.update(scenario)
    clock[0] = 0.0
    return control._http_healthy(18642, "/health", 1.0)


results = {
    "healthy": check({
        "connect_delay": 0.0,
        "request_delay": 0.0,
        "chunks": [(0.0, complete)],
    }),
    "healthy_close_race": check({
        "connect_delay": 0.0,
        "request_delay": 0.0,
        "chunks": [(0.0, complete)],
        "close_error": True,
    }),
    "unauthorized": check({
        "connect_delay": 0.0,
        "request_delay": 0.0,
        "chunks": [(0.0, unauthorized + headers + body)],
    }),
    "slow_connect": check({
        "connect_delay": 1.0,
        "request_delay": 0.0,
        "chunks": [(0.0, complete)],
    }),
    "slow_request": check({
        "connect_delay": 0.0,
        "request_delay": 1.0,
        "chunks": [(0.0, complete)],
    }),
    "slow_status": check({
        "connect_delay": 0.0,
        "request_delay": 0.0,
        "chunks": byte_chunks(status, 0.2) + [(0.0, headers + body)],
    }),
    "slow_headers": check({
        "connect_delay": 0.0,
        "request_delay": 0.0,
        "chunks": [(0.0, status)] + byte_chunks(headers, 0.2) + [(0.0, body)],
    }),
    "slow_body": check({
        "connect_delay": 0.0,
        "request_delay": 0.0,
        "chunks": [(0.0, status + headers)] + byte_chunks(body, 0.3),
    }),
}

print(json.dumps(results, sort_keys=True))
`;

function runHarness(source: string): unknown {
  const result = spawnSync("python3", ["-c", source, HELPER], {
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });

  expect(result.error, result.error?.stack ?? result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("managed gateway recovery deadline", () => {
  it("stops preflight, marker publication, and signaling at the recovery deadline (#8262)", () => {
    expect(runHarness(CONTROL_DEADLINE_HARNESS)).toEqual({
      forwarding: [["ok", 41, 43], true],
      preflight_after_validation: ["GATEWAY_FAILED", true, 0],
      preflight_before_validation: ["GATEWAY_FAILED", 0],
      late_publication: ["GATEWAY_FAILED", true],
      termination_before_recapture: ["GATEWAY_FAILED", [], []],
      termination_during_recapture: ["GATEWAY_FAILED", [1], []],
    });
  });

  it("applies one recovery deadline to every HTTP health check phase (#8262)", () => {
    expect(runHarness(HTTP_DEADLINE_HARNESS)).toEqual({
      healthy: true,
      healthy_close_race: true,
      slow_body: false,
      slow_connect: false,
      slow_headers: false,
      slow_request: false,
      slow_status: false,
      unauthorized: true,
    });
  });
});
