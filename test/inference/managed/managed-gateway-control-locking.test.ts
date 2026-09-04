// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "../../..", "scripts", "managed-gateway-control.py");

const LOCKING_HARNESS = String.raw`
import importlib.util
import json
import os
import sys
import tempfile
import threading

spec = importlib.util.spec_from_file_location("managed_control_locking", sys.argv[1])
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

with tempfile.TemporaryDirectory() as root:
    proc_root = os.path.join(root, "proc")
    system_root = os.path.join(root, "system")
    os.makedirs(proc_root)
    os.makedirs(os.path.join(system_root, "run"))
    os.environ["NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST"] = "1"
    os.environ["NEMOCLAW_MANAGED_CONTROL_PROC_ROOT"] = proc_root
    os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = system_root

    supervisor = identity(40, 222, 1, "supervisor")
    gateway_41 = identity(41, 333, 40, "gateway")
    gateway_43 = identity(43, 555, 40, "gateway")
    gateway_44 = identity(44, 666, 40, "gateway")
    controller = identity(999, 777, 1, "controller")
    marker_path = os.path.join(
        system_root,
        "run/nemoclaw",
        control.EXPECTED_EXIT_MARKER_NAME,
    )
    lock_path = os.path.join(
        system_root,
        "run/nemoclaw",
        control.EXPECTED_EXIT_LOCK_NAME,
    )

    def publish(identity_to_authorize):
        lock = control._acquire_expected_exit_lock(
            control.time.monotonic() + control.RECOVERY_TIMEOUT_SECONDS
        )
        try:
            return control._publish_expected_exit_lease(
                lock,
                identity_to_authorize,
                controller,
            )
        except Exception:
            control._close_expected_exit_lock(lock)
            raise

    active_lease = publish(gateway_41)
    contention_seen = threading.Event()
    release_complete = threading.Event()
    real_flock = control.fcntl.flock
    def observe_contention(fd, operation):
        try:
            return real_flock(fd, operation)
        except BlockingIOError:
            contention_seen.set()
            raise
    def release_after_contention():
        if contention_seen.wait(1.0):
            control._clear_expected_exit_lease(active_lease)
            release_complete.set()
    control.fcntl.flock = observe_contention
    release_thread = threading.Thread(target=release_after_contention)
    release_thread.start()
    try:
        waited_lease = publish(gateway_41)
    finally:
        release_thread.join(1.0)
        control.fcntl.flock = real_flock
    if release_thread.is_alive() or not release_complete.is_set():
        raise AssertionError("active expected-exit lease was not released")
    serialized_lease = ["waited", contention_seen.is_set()]
    control._clear_expected_exit_lease(waited_lease)

    previous_timeout = control.RECOVERY_TIMEOUT_SECONDS
    control.RECOVERY_TIMEOUT_SECONDS = 0.01
    timeout_clock = [0.0]
    original_time = control.time.monotonic, control.time.sleep
    control.time.monotonic = lambda: timeout_clock[0]
    control.time.sleep = lambda duration: timeout_clock.__setitem__(
        0,
        timeout_clock[0] + duration,
    )
    timeout_lease = publish(gateway_41)
    try:
        try:
            publish(gateway_41)
            lock_timeout = "accepted"
        except control.ControlError as error:
            lock_timeout = error.code
    finally:
        control._clear_expected_exit_lease(timeout_lease)
        control.RECOVERY_TIMEOUT_SECONDS = previous_timeout
        control.time.monotonic, control.time.sleep = original_time
    lock_timeout_result = [lock_timeout, timeout_clock[0]]

    late_clock = [0.0]
    original_monotonic = control.time.monotonic
    real_flock = control.fcntl.flock
    def acquire_at_deadline(fd, operation):
        result = real_flock(fd, operation)
        late_clock[0] = 0.01
        return result
    control.time.monotonic = lambda: late_clock[0]
    control.fcntl.flock = acquire_at_deadline
    late_lock = None
    try:
        try:
            late_lock = control._acquire_expected_exit_lock(0.01)
            late_acquisition = "accepted"
        except control.ControlError as error:
            late_acquisition = error.code
    finally:
        if late_lock is not None:
            control._close_expected_exit_lock(late_lock)
        control.fcntl.flock = real_flock
        control.time.monotonic = original_monotonic

    orphaned_lease = publish(gateway_41)
    orphaned_inode = os.stat(marker_path, follow_symlinks=False).st_ino
    os.close(orphaned_lease.marker_fd)
    os.close(orphaned_lease.lock_fd)
    os.close(orphaned_lease.directory_fd)
    untrusted_marker_fd = os.open(marker_path, os.O_RDONLY)
    control.fcntl.flock(untrusted_marker_fd, control.fcntl.LOCK_SH)
    recovered_lease = publish(gateway_41)
    marker_flock_cannot_pin = (
        os.stat(marker_path, follow_symlinks=False).st_ino != orphaned_inode
    )
    control.fcntl.flock(untrusted_marker_fd, control.fcntl.LOCK_UN)
    os.close(untrusted_marker_fd)
    control._clear_expected_exit_lease(recovered_lease)

    original_lease = publish(gateway_41)
    os.unlink(marker_path)
    with open(marker_path, "w", encoding="ascii") as stream:
        stream.write("replacement\n")
    os.chmod(marker_path, 0o444)
    replacement_inode = os.stat(marker_path, follow_symlinks=False).st_ino
    control._clear_expected_exit_lease(original_lease)
    inode_safe_cleanup = (
        os.path.exists(marker_path)
        and os.stat(marker_path, follow_symlinks=False).st_ino
        == replacement_inode
    )
    os.unlink(marker_path)

    os.unlink(lock_path)
    original_umask = os.umask(0o777)
    try:
        restrictive_umask_lease = publish(gateway_41)
    finally:
        os.umask(original_umask)
    restrictive_umask_modes = [
        os.stat(marker_path, follow_symlinks=False).st_mode & 0o777,
        os.stat(lock_path, follow_symlinks=False).st_mode & 0o777,
    ]
    control._clear_expected_exit_lease(restrictive_umask_lease)

    original_open_runtime_directory = control._open_managed_runtime_directory
    original_open_expected_exit_lock = control._open_expected_exit_lock
    original_expected_exit_lock = control.ExpectedExitLock
    original_close = control.os.close
    constructor_cleanup = []
    control._open_managed_runtime_directory = lambda: 101
    control._open_expected_exit_lock = lambda *_args: 202
    control.ExpectedExitLock = lambda **_kwargs: (_ for _ in ()).throw(
        RuntimeError("lock record construction failed")
    )
    control.os.close = lambda fd: constructor_cleanup.append(fd)
    try:
        try:
            control._acquire_expected_exit_lock(
                control.time.monotonic() + control.RECOVERY_TIMEOUT_SECONDS
            )
            raise AssertionError("lock record construction unexpectedly succeeded")
        except RuntimeError as error:
            if str(error) != "lock record construction failed":
                raise
    finally:
        control._open_managed_runtime_directory = original_open_runtime_directory
        control._open_expected_exit_lock = original_open_expected_exit_lock
        control.ExpectedExitLock = original_expected_exit_lock
        control.os.close = original_close

    current_gateway = [gateway_41]
    control._proc_root = lambda: proc_root
    control._detect_agent = lambda: "hermes"
    control._discover_supervisor = lambda _reader: supervisor
    control._agent_spec = lambda *_args: control.AgentSpec("hermes", 18789)
    control._gateway_candidates = lambda *_args: [current_gateway[0]]
    control._preflight = lambda *_args: None
    control._controller_process_identity = lambda _reader: controller
    control._wait_for_healthy_gateway = lambda *_args, **_kwargs: current_gateway[0]

    observed_marker = []
    def replace_after_wait(_reader, gateway, _recovery_deadline=None):
        if gateway.stable_key() != gateway_43.stable_key():
            raise AssertionError("second controller used a stale gateway proof")
        with open(marker_path, "r", encoding="ascii") as stream:
            observed_marker.extend(stream.read().split())
        current_gateway[0] = gateway_44
    original_terminate_gateway = control._terminate_gateway
    control._terminate_gateway = replace_after_wait

    first_controller_lock = control._acquire_expected_exit_lock(
        control.time.monotonic() + control.RECOVERY_TIMEOUT_SECONDS
    )
    controller_waiting = threading.Event()
    real_flock = control.fcntl.flock
    def observe_controller_contention(fd, operation):
        try:
            return real_flock(fd, operation)
        except BlockingIOError:
            controller_waiting.set()
            raise
    control.fcntl.flock = observe_controller_contention
    contended_results = []
    contended_errors = []
    def run_contended_restart():
        try:
            contended_results.append(control._control("restart", "9" * 64))
        except BaseException as error:
            contended_errors.append(error)
    contended_thread = threading.Thread(target=run_contended_restart)
    first_lock_closed = False
    try:
        contended_thread.start()
        if not controller_waiting.wait(1.0):
            raise AssertionError("second controller did not wait for the first")
        current_gateway[0] = gateway_43
        control._close_expected_exit_lock(first_controller_lock)
        first_lock_closed = True
        contended_thread.join(5.0)
    finally:
        if not first_lock_closed:
            control._close_expected_exit_lock(first_controller_lock)
        contended_thread.join(5.0)
        control.fcntl.flock = real_flock
        control._terminate_gateway = original_terminate_gateway
    if contended_thread.is_alive():
        raise AssertionError("second controller did not finish")
    if contended_errors:
        raise contended_errors[0]
    contended_restart = [
        contended_results[0],
        observed_marker,
        not os.path.exists(marker_path),
    ]

    read_fd, write_fd = os.pipe()
    deadline_clock = [0.0]
    deadline_waits = []
    deadline_signals = []
    control._pidfd_open = lambda _pid: os.dup(read_fd)
    control._recapture_exact_identity = lambda *_args, **_kwargs: gateway_41
    control.time.monotonic = lambda: deadline_clock[0]
    control._send_pidfd = lambda _pidfd, signum: (
        deadline_signals.append(int(signum)) or True
    )
    def record_deadline_wait(_pidfd, timeout_seconds):
        deadline_waits.append(timeout_seconds)
        deadline_clock[0] = 3.0
        return False
    control._pidfd_exited = record_deadline_wait
    try:
        try:
            control._terminate_gateway(object(), gateway_41, 3.0)
            termination_deadline = "accepted"
        except control.ControlError as error:
            termination_deadline = [
                error.code,
                deadline_waits,
                deadline_signals,
            ]

        accounted_clock = [0.0]
        accounted_waits = []
        accounted_signals = []
        control.time.monotonic = lambda: accounted_clock[0]
        control._send_pidfd = lambda _pidfd, signum: (
            accounted_signals.append(int(signum)) or True
        )
        def record_accounted_exit(_pidfd, timeout_seconds):
            accounted_waits.append(timeout_seconds)
            accounted_clock[0] = 3.0
            return len(accounted_waits) > 1
        control._pidfd_exited = record_accounted_exit
        try:
            control._terminate_gateway(object(), gateway_41, 3.0)
            termination_accounted = [
                "accounted",
                accounted_waits,
                accounted_signals,
            ]
        except control.ControlError as error:
            termination_accounted = [
                error.code,
                accounted_waits,
                accounted_signals,
            ]
    finally:
        os.close(read_fd)
        os.close(write_fd)

    print(json.dumps({
        "serialized_lease": serialized_lease,
        "lock_timeout": lock_timeout_result,
        "late_acquisition": late_acquisition,
        "marker_flock_cannot_pin": marker_flock_cannot_pin,
        "inode_safe_cleanup": inode_safe_cleanup,
        "restrictive_umask_modes": restrictive_umask_modes,
        "constructor_cleanup": constructor_cleanup,
        "contended_restart": contended_restart,
        "termination_deadline": termination_deadline,
        "termination_accounted": termination_accounted,
    }))
`;

describe("managed gateway lifecycle locking", () => {
  it("acquires the expected-exit lock before gateway inspection and enforces one recovery deadline (#8262)", () => {
    const result = spawnSync("python3", ["-c", LOCKING_HARNESS, HELPER], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });

    expect(result.error, result.error?.stack ?? result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      serialized_lease: ["waited", true],
      lock_timeout: ["SUPERVISOR_BUSY", 0.01],
      late_acquisition: "SUPERVISOR_BUSY",
      marker_flock_cannot_pin: true,
      inode_safe_cleanup: true,
      restrictive_umask_modes: [0o444, 0o600],
      constructor_cleanup: [202, 101],
      contended_restart: [["ok", 43, 44], ["v1", "43", "555", "999", "777"], true],
      termination_deadline: ["GATEWAY_FAILED", [3, 0], [15]],
      termination_accounted: ["accounted", [3, 0], [15]],
    });
  });
});
