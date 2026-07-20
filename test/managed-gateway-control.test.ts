// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "..", "scripts", "managed-gateway-control.py");
const BOUNDARY_VALIDATOR = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);
const NONCE = "a".repeat(64);

const PROCESS_HARNESS = String.raw`
import importlib.util
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
from dataclasses import replace

spec = importlib.util.spec_from_file_location("managed_control", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

def write_process(
    proc_root,
    namespace_path,
    pid,
    start_time,
    parent_pid,
    uid,
    cmdline,
    environ=b"PATH=/usr/bin\0",
    listener_inode=None,
    state="S",
    thread_count=1,
):
    process_root = os.path.join(proc_root, str(pid))
    os.makedirs(os.path.join(process_root, "ns"))
    os.makedirs(os.path.join(process_root, "fd"))
    os.symlink("../net", os.path.join(process_root, "net"))
    fields = (
        [state, str(parent_pid)]
        + (["0"] * 15)
        + [str(thread_count), "0", str(start_time)]
    )
    with open(os.path.join(process_root, "stat"), "w", encoding="ascii") as stream:
        stream.write(f"{pid} (managed) {' '.join(fields)}\n")
    with open(os.path.join(process_root, "status"), "w", encoding="ascii") as stream:
        stream.write(
            f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}\n"
            f"NSpid:\t{pid}\n"
        )
    with open(os.path.join(process_root, "cmdline"), "wb") as stream:
        stream.write(cmdline)
    with open(os.path.join(process_root, "environ"), "wb") as stream:
        stream.write(environ)
    os.link(namespace_path, os.path.join(process_root, "ns", "pid"))
    if listener_inode is not None:
        os.symlink(f"socket:[{listener_inode}]", os.path.join(process_root, "fd", "7"))

def remove_process(proc_root, pid):
    shutil.rmtree(os.path.join(proc_root, str(pid)))

with tempfile.TemporaryDirectory() as root:
    proc_root = os.path.join(root, "proc")
    system_root = os.path.join(root, "system")
    os.makedirs(os.path.join(proc_root, "net"))
    os.makedirs(os.path.join(system_root, "run"))
    os.makedirs(os.path.join(system_root, "usr/local/lib/nemoclaw"))
    os.makedirs(os.path.join(system_root, "sandbox/.hermes"))
    os.makedirs(os.path.join(system_root, "etc/nemoclaw"))
    namespace_path = os.path.join(root, "pid-namespace")
    with open(namespace_path, "wb") as stream:
        stream.write(b"namespace")
    for table in ("tcp", "tcp6"):
        with open(os.path.join(proc_root, "net", table), "w", encoding="ascii") as stream:
            stream.write("sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n")
    with open(os.path.join(proc_root, "net", "tcp"), "a", encoding="ascii") as stream:
        stream.write("0: 0100007F:48D2 00000000:0000 0A 0:0 00:0 0 1000 0 77777\n")

    write_process(
        proc_root,
        namespace_path,
        1,
        111,
        0,
        0,
        b"/opt/openshell/bin/openshell-sandbox\0--managed\0",
    )
    write_process(
        proc_root,
        namespace_path,
        39,
        200,
        1,
        1000,
        b"",
        state="Z",
    )
    write_process(
        proc_root,
        namespace_path,
        40,
        222,
        1,
        1000,
        b"bash\0/usr/local/bin/nemoclaw-start\0",
        b"PATH=/usr/bin\0NEMOCLAW_DASHBOARD_PORT=18789\0",
    )
    write_process(
        proc_root,
        namespace_path,
        41,
        333,
        40,
        1000,
        b"/usr/local/bin/hermes.real\0gateway\0run\0",
        listener_inode="77777",
    )
    controller_pid = os.getpid()
    controller_start_time = "777"
    write_process(
        proc_root,
        namespace_path,
        controller_pid,
        controller_start_time,
        1,
        os.geteuid(),
        b"python3\0-I\0/usr/local/lib/nemoclaw/managed-gateway-control.py\0restart\0"
        + (b"a" * 64)
        + b"\0",
    )

    control._sandbox_uid = lambda: 1000
    control._http_healthy_in_gateway_namespace = (
        lambda _reader, _identity, port, path: (port, path) in {
            (18642, "/health"),
            (8642, "/health"),
        }
    )
    os.environ["NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST"] = "1"
    os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = system_root
    boundary_path = os.path.join(
        system_root,
        "usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
    )
    with open(boundary_path, "w", encoding="utf-8") as stream:
        stream.write("# trusted validator fixture\n")
    os.chmod(boundary_path, 0o755)

    with control.ProcReader(proc_root) as reader:
        zombie = reader.capture(39)
        supervisor = control._discover_supervisor(reader)
        hermes = control._agent_spec("hermes", reader, supervisor)
        candidates = control._gateway_candidates(reader, supervisor, hermes)
        initial_proof = {
            "stable_zombie": [zombie.state, len(zombie.cmdline)],
            "supervisor": [supervisor.pid, supervisor.start_time, supervisor.parent_pid],
            "gateway": [candidates[0].pid, candidates[0].start_time, candidates[0].parent_pid],
            "healthy": control._gateway_healthy(reader, candidates[0], hermes),
        }
        write_process(
            proc_root,
            namespace_path,
            38,
            199,
            1,
            1000,
            b"",
            state="Z",
            thread_count=2,
        )
        try:
            control._discover_supervisor(reader)
            zombie_leader_with_live_sibling = "accepted"
        except control.ControlError as error:
            zombie_leader_with_live_sibling = error.code
        remove_process(proc_root, 38)
        state_key_behavior = [
            replace(candidates[0], state="R").stable_key()
            == candidates[0].stable_key(),
            replace(candidates[0], state="Z").stable_key()
            == candidates[0].stable_key(),
        ]
        mixed_namespace_rejected = not control._gateway_matches(
            candidates[0], replace(supervisor, namespace_inode=None), hermes
        )

        real_supervisor_candidates = control._supervisor_candidates
        transient_scan_calls = []
        def transient_unrelated_process_churn(reader, pid1, sandbox_uid):
            matches, inconclusive = real_supervisor_candidates(reader, pid1, sandbox_uid)
            transient_scan_calls.append(len(matches))
            return matches, len(transient_scan_calls) <= 5 or inconclusive
        control._supervisor_candidates = transient_unrelated_process_churn
        try:
            transient_supervisor = control._discover_supervisor(reader)
            transient_supervisor_retry = [
                transient_supervisor.pid,
                len(transient_scan_calls),
            ]
        finally:
            control._supervisor_candidates = real_supervisor_candidates

        persistent_scan_calls = []
        fake_clock = [0.0]
        real_monotonic = control.time.monotonic
        real_sleep = control.time.sleep
        def persistent_unrelated_process_churn(reader, pid1, sandbox_uid):
            matches, _inconclusive = real_supervisor_candidates(reader, pid1, sandbox_uid)
            persistent_scan_calls.append(len(matches))
            return matches, True
        control._supervisor_candidates = persistent_unrelated_process_churn
        control.time.monotonic = lambda: fake_clock[0]
        control.time.sleep = lambda seconds: fake_clock.__setitem__(0, fake_clock[0] + seconds)
        try:
            control._discover_supervisor(reader)
            persistent_supervisor_churn = ["accepted", len(persistent_scan_calls), fake_clock[0]]
        except control.ControlError as error:
            persistent_supervisor_churn = [
                error.code,
                len(persistent_scan_calls),
                round(fake_clock[0], 3),
            ]
        finally:
            control._supervisor_candidates = real_supervisor_candidates
            control.time.monotonic = real_monotonic
            control.time.sleep = real_sleep

        transient_recapture_calls = []
        real_capture = reader.capture
        def capture_with_transient_supervisor_read(pid):
            if pid == supervisor.pid:
                transient_recapture_calls.append(pid)
                if len(transient_recapture_calls) <= 4:
                    raise control.ControlError("SUPERVISOR_UNAVAILABLE")
            return real_capture(pid)
        reader.capture = capture_with_transient_supervisor_read
        try:
            transient_gateway_candidates = [
                control._gateway_candidates(reader, supervisor, hermes)[0].pid,
                len(transient_recapture_calls),
            ]
        finally:
            reader.capture = real_capture

        real_namespace_inode = control._namespace_inode
        control._namespace_inode = lambda _pid_fd: None
        try:
            namespace_denied_supervisor = control._discover_supervisor(reader)
            namespace_denied = len(
                control._gateway_candidates(reader, namespace_denied_supervisor, hermes)
            ) == 1
        finally:
            control._namespace_inode = real_namespace_inode

        remove_process(proc_root, 41)
        remove_process(proc_root, 40)
        try:
            control._discover_supervisor(reader)
            missing_supervisor = "accepted"
        except control.ControlError as error:
            missing_supervisor = error.code
        real_supervisor_candidates = control._supervisor_candidates
        supervisor_candidate_calls = []
        def supervisor_appears_between_scans(reader, pid1, sandbox_uid):
            matches, inconclusive = real_supervisor_candidates(reader, pid1, sandbox_uid)
            supervisor_candidate_calls.append(len(matches))
            if len(supervisor_candidate_calls) == 1:
                write_process(
                    proc_root,
                    namespace_path,
                    40,
                    222,
                    1,
                    1000,
                    b"bash\0/usr/local/bin/nemoclaw-start\0",
                    b"PATH=/usr/bin\0NEMOCLAW_DASHBOARD_PORT=18789\0",
                )
            return matches, inconclusive
        control._supervisor_candidates = supervisor_appears_between_scans
        try:
            control._discover_supervisor(reader)
            appearing_supervisor = "accepted"
        except control.ControlError as error:
            appearing_supervisor = error.code
        finally:
            control._supervisor_candidates = real_supervisor_candidates
        remove_process(proc_root, 40)
        write_process(
            proc_root,
            namespace_path,
            46,
            666,
            1,
            1000,
            b"unreadable-process\0",
        )
        real_capture = reader.capture
        def capture_with_permission_denial(pid):
            if pid == 46:
                raise PermissionError("denied")
            return real_capture(pid)
        reader.capture = capture_with_permission_denial
        try:
            control._discover_supervisor(reader)
            unreadable_process = "accepted"
        except control.ControlError as error:
            unreadable_process = error.code
        finally:
            reader.capture = real_capture
        remove_process(proc_root, 46)
        write_process(
            proc_root,
            namespace_path,
            46,
            667,
            1,
            1000,
            b"",
        )
        try:
            control._discover_supervisor(reader)
            empty_live_process = "accepted"
        except control.ControlError as error:
            empty_live_process = error.code
        remove_process(proc_root, 46)
        write_process(
            proc_root,
            namespace_path,
            40,
            222,
            1,
            1000,
            b"bash\0/usr/local/bin/nemoclaw-start\0",
            b"PATH=/usr/bin\0NEMOCLAW_DASHBOARD_PORT=18789\0",
        )
        write_process(
            proc_root,
            namespace_path,
            41,
            333,
            40,
            1000,
            b"/usr/local/bin/hermes.real\0gateway\0run\0",
            listener_inode="77777",
        )
        write_process(
            proc_root,
            namespace_path,
            45,
            555,
            1,
            1000,
            b"/usr/local/bin/nemoclaw-start\0",
        )
        try:
            control._discover_supervisor(reader)
            duplicate_supervisor = "accepted"
        except control.ControlError as error:
            duplicate_supervisor = error.code
        remove_process(proc_root, 45)
        # The preceding cases recreate fake PIDs 40 and 41, so refresh their
        # inode-bound identities before testing stable reads and signals.
        supervisor = control._discover_supervisor(reader)

        preflight_steps = []
        real_validator = control._run_fixed_validator
        real_runtime_validator = control._validate_runtime_environment
        real_hash_check = control._verify_locked_hermes_hash
        control._run_fixed_validator = lambda script, arguments: preflight_steps.append({
            "script": script,
            "arguments": arguments,
        })
        control._validate_runtime_environment = lambda script, environment: preflight_steps.append({
            "script": script,
            "arguments": ["runtime-env"],
            "runtime_port": environment.get("NEMOCLAW_DASHBOARD_PORT"),
        })
        control._verify_locked_hermes_hash = lambda: preflight_steps.append({"hash": "checked"})
        try:
            control._hermes_preflight(reader, supervisor)
            verified_preflight_steps = list(preflight_steps)

            real_read_stable_file = reader.read_stable_file
            real_monotonic = control.time.monotonic
            real_sleep = control.time.sleep
            transient_preflight_reads = []
            fake_clock = [0.0]
            def transient_preflight_read(identity, name, limit):
                transient_preflight_reads.append(identity.pid)
                if len(transient_preflight_reads) <= 2:
                    raise control.ControlError("SUPERVISOR_UNAVAILABLE")
                return real_read_stable_file(identity, name, limit)
            reader.read_stable_file = transient_preflight_read
            control.time.monotonic = lambda: fake_clock[0]
            control.time.sleep = lambda seconds: fake_clock.__setitem__(0, fake_clock[0] + seconds)
            try:
                control._hermes_preflight(reader, supervisor)
                transient_preflight_retry = [
                    len(transient_preflight_reads),
                    round(fake_clock[0], 3),
                ]
            finally:
                reader.read_stable_file = real_read_stable_file

            persistent_preflight_reads = []
            fake_clock[0] = 0.0
            def persistent_preflight_read(identity, _name, _limit):
                persistent_preflight_reads.append(identity.pid)
                raise control.ControlError("SUPERVISOR_UNAVAILABLE")
            reader.read_stable_file = persistent_preflight_read
            try:
                control._hermes_preflight(reader, supervisor)
                persistent_preflight_retry = ["accepted", False, fake_clock[0]]
            except control.ControlError as error:
                persistent_preflight_retry = [
                    error.code,
                    len(persistent_preflight_reads) > 1,
                    round(fake_clock[0], 3),
                ]
            finally:
                reader.read_stable_file = real_read_stable_file

            identity_change_reads = []
            fake_clock[0] = 0.0
            real_capture = reader.capture
            def identity_change_read(identity, _name, _limit):
                identity_change_reads.append(identity.pid)
                raise control.ControlError("SUPERVISOR_UNAVAILABLE")
            def capture_changed_supervisor(pid):
                captured = real_capture(pid)
                if pid == supervisor.pid:
                    return replace(captured, start_time="replaced")
                return captured
            reader.read_stable_file = identity_change_read
            reader.capture = capture_changed_supervisor
            try:
                control._hermes_preflight(reader, supervisor)
                changed_preflight_identity = ["accepted", fake_clock[0]]
            except control.ControlError as error:
                changed_preflight_identity = [error.code, fake_clock[0]]
            finally:
                reader.read_stable_file = real_read_stable_file
                reader.capture = real_capture
                control.time.monotonic = real_monotonic
                control.time.sleep = real_sleep
        finally:
            control._run_fixed_validator = real_validator
            control._validate_runtime_environment = real_runtime_validator
            control._verify_locked_hermes_hash = real_hash_check

        real_subprocess_run = control.subprocess.run
        control.subprocess.run = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("runtime boundary must not exec with untrusted env")
        )
        try:
            control._validate_runtime_environment(
                sys.argv[2],
                {"LD_PRELOAD": "/tmp/attacker.so", "SAFE": "1"},
            )
            runtime_validation = "in-process"
        finally:
            control.subprocess.run = real_subprocess_run

        write_process(
            proc_root,
            namespace_path,
            42,
            444,
            40,
            1000,
            b"/usr/local/bin/hermes.real\0gateway\0run\0",
            listener_inode="77777",
        )
        try:
            control._gateway_candidates(reader, supervisor, hermes)
            duplicate = "accepted"
        except control.ControlError as error:
            duplicate = error.code
        remove_process(proc_root, 42)

        expected_gateway = control._gateway_candidates(reader, supervisor, hermes)[0]
        sent = []
        real_pidfd_open = control._pidfd_open
        real_pidfd_exited = control._pidfd_exited
        real_send = control._send_pidfd
        read_fd, write_fd = os.pipe()
        try:
            control._pidfd_open = lambda _pid: os.dup(read_fd)
            exit_checks = [False, True, False]
            control._pidfd_exited = lambda _pidfd, _timeout: exit_checks.pop(0)
            def record_signal(_pidfd, signum):
                sent.append(int(signum))
                return True
            control._send_pidfd = record_signal
            real_capture = reader.capture
            termination_capture_calls = []
            def reject_post_signal_recapture(pid):
                if pid == expected_gateway.pid:
                    termination_capture_calls.append(pid)
                    if len(termination_capture_calls) > 1:
                        raise control.ControlError("SUPERVISOR_UNAVAILABLE")
                return real_capture(pid)
            reader.capture = reject_post_signal_recapture
            control._terminate_gateway(reader, expected_gateway)
            reader.capture = real_capture
            termination_proof_reads = len(termination_capture_calls)

            with open(os.path.join(proc_root, "41", "stat"), "w", encoding="ascii") as stream:
                fields = ["S", "40"] + (["0"] * 15) + ["1", "0", "999"]
                stream.write(f"41 (managed) {' '.join(fields)}\n")
            try:
                control._terminate_gateway(reader, expected_gateway)
                reused = "signalled"
            except control.ControlError as error:
                reused = error.code

            with open(os.path.join(proc_root, "41", "stat"), "w", encoding="ascii") as stream:
                fields = ["S", "40"] + (["0"] * 15) + ["1", "0", "333"]
                stream.write(f"41 (managed) {' '.join(fields)}\n")

            control._pidfd_open = lambda _pid: os.dup(read_fd)
            control._pidfd_exited = lambda _pidfd, _timeout: True
            def reject_recapture_after_pidfd_open(pid):
                if pid == expected_gateway.pid:
                    raise control.ControlError("SUPERVISOR_UNAVAILABLE")
                return real_capture(pid)
            reader.capture = reject_recapture_after_pidfd_open
            try:
                control._terminate_gateway(reader, expected_gateway)
                pidfd_recapture_exit = "accepted"
            finally:
                reader.capture = real_capture

            control._pidfd_open = lambda _pid: None
            control._terminate_gateway(reader, expected_gateway)
            pidfd_open_exit = "accepted"

            control._pidfd_open = lambda _pid: os.dup(read_fd)
            control._send_pidfd = lambda _pidfd, _signum: False
            control._terminate_gateway(reader, expected_gateway)
            pidfd_signal_exit = "accepted"

            timeout_signals = []
            control._send_pidfd = lambda _pidfd, signum: (
                timeout_signals.append(int(signum)) or True
            )
            control._pidfd_exited = lambda _pidfd, _timeout: False
            try:
                control._terminate_gateway(reader, expected_gateway)
                kill_timeout = "accepted"
            except control.ControlError as error:
                kill_timeout = [error.code, timeout_signals]

            real_os_pidfd_open = getattr(control.os, "pidfd_open", None)
            real_signal_pidfd_send = getattr(control.signal, "pidfd_send_signal", None)
            def pidfd_open_esrch(_pid, _flags):
                raise OSError(control.errno.ESRCH, "gone")
            def pidfd_send_esrch(_pidfd, _signum, _siginfo, _flags):
                raise OSError(control.errno.ESRCH, "gone")
            def pidfd_send_eperm(_pidfd, _signum, _siginfo, _flags):
                raise OSError(control.errno.EPERM, "denied")
            control.os.pidfd_open = pidfd_open_esrch
            control.signal.pidfd_send_signal = pidfd_send_esrch
            try:
                helper_pidfd_open_esrch = real_pidfd_open(expected_gateway.pid)
                helper_pidfd_send_esrch = real_send(read_fd, control.signal.SIGTERM)
                control.signal.pidfd_send_signal = pidfd_send_eperm
                try:
                    real_send(read_fd, control.signal.SIGTERM)
                    helper_pidfd_send_eperm = "accepted"
                except control.ControlError as error:
                    helper_pidfd_send_eperm = error.code
            finally:
                if real_os_pidfd_open is None:
                    del control.os.pidfd_open
                else:
                    control.os.pidfd_open = real_os_pidfd_open
                if real_signal_pidfd_send is None:
                    del control.signal.pidfd_send_signal
                else:
                    control.signal.pidfd_send_signal = real_signal_pidfd_send
        finally:
            reader.capture = real_capture
            control._pidfd_open = real_pidfd_open
            control._pidfd_exited = real_pidfd_exited
            control._send_pidfd = real_send
            os.close(read_fd)
            os.close(write_fd)

    # Restore the original gateway fixture, then make the fake TERM atomically
    # expose the replacement that the real shell supervisor would launch.
    remove_process(proc_root, 41)
    write_process(
        proc_root,
        namespace_path,
        41,
        333,
        40,
        1000,
        b"/usr/local/bin/hermes.real\0gateway\0run\0",
        listener_inode="77777",
    )
    with open(
        os.path.join(system_root, "usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"),
        "w",
        encoding="utf-8",
    ) as stream:
        stream.write("# trusted fixture\n")
    os.chmod(
        os.path.join(system_root, "usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"),
        0o755,
    )
    real_proc_root = control._proc_root
    control._proc_root = lambda: proc_root
    control._preflight = lambda *_args: None
    control._http_healthy_in_gateway_namespace = lambda *_args: True
    real_terminate = control._terminate_gateway
    with control.ProcReader(proc_root) as controller_reader:
        controller_identity = control._controller_process_identity(controller_reader)
    lease_path = os.path.join(
        system_root,
        "run/nemoclaw",
        control.EXPECTED_EXIT_MARKER_NAME,
    )
    lock_path = os.path.join(
        system_root,
        "run/nemoclaw",
        control.EXPECTED_EXIT_LOCK_NAME,
    )
    lease_observations = []
    def observe_expected_exit_lease(identity, label):
        metadata = os.stat(lease_path, follow_symlinks=False)
        lock_metadata = os.stat(lock_path, follow_symlinks=False)
        with open(lease_path, "r", encoding="ascii") as stream:
            version, pid, start_time, controller, controller_start = stream.read().split()
        lease_observations.append({
            "label": label,
            "identity": [
                version,
                int(pid),
                start_time,
                int(controller),
                controller_start,
            ],
            "secure": (
                metadata.st_uid == os.geteuid()
                and metadata.st_gid == os.getegid()
                and (metadata.st_mode & 0o777) == 0o444
                and metadata.st_nlink == 1
                and lock_metadata.st_uid == os.geteuid()
                and lock_metadata.st_gid == os.getegid()
                and (lock_metadata.st_mode & 0o777) == 0o600
                and lock_metadata.st_nlink == 1
            ),
        })
    def replace_gateway(_reader, identity):
        assert identity.pid == 41
        observe_expected_exit_lease(identity, "restart")
        remove_process(proc_root, 41)
        write_process(
            proc_root,
            namespace_path,
            43,
            555,
            40,
            1000,
            b"/usr/local/bin/hermes.real\0gateway\0run\0",
            listener_inode="77777",
        )

    active_lease = control._publish_expected_exit_lease(
        expected_gateway,
        controller_identity,
    )
    try:
        control._publish_expected_exit_lease(expected_gateway, controller_identity)
        active_controller_lock = "replaced"
    except control.ControlError as error:
        active_controller_lock = error.code
    control._clear_expected_exit_lease(active_lease)

    orphaned_lease = control._publish_expected_exit_lease(
        expected_gateway,
        controller_identity,
    )
    orphaned_inode = os.stat(lease_path, follow_symlinks=False).st_ino
    os.close(orphaned_lease.marker_fd)
    os.close(orphaned_lease.lock_fd)
    os.close(orphaned_lease.directory_fd)
    untrusted_marker_fd = os.open(lease_path, os.O_RDONLY)
    control.fcntl.flock(untrusted_marker_fd, control.fcntl.LOCK_SH)
    recovered_lease = control._publish_expected_exit_lease(
        expected_gateway,
        controller_identity,
    )
    marker_flock_cannot_pin = (
        os.stat(lease_path, follow_symlinks=False).st_ino != orphaned_inode
    )
    control.fcntl.flock(untrusted_marker_fd, control.fcntl.LOCK_UN)
    os.close(untrusted_marker_fd)
    control._clear_expected_exit_lease(recovered_lease)

    original_lease = control._publish_expected_exit_lease(
        expected_gateway,
        controller_identity,
    )
    os.unlink(lease_path)
    with open(lease_path, "w", encoding="ascii") as stream:
        stream.write(f"v1 41 333 {controller_pid} {controller_start_time}\n")
    os.chmod(lease_path, 0o444)
    replacement_inode = os.stat(lease_path, follow_symlinks=False).st_ino
    control._clear_expected_exit_lease(original_lease)
    inode_safe_cleanup = (
        os.path.exists(lease_path)
        and os.stat(lease_path, follow_symlinks=False).st_ino == replacement_inode
    )
    os.unlink(lease_path)

    os.unlink(lock_path)
    original_umask = os.umask(0o777)
    try:
        restrictive_umask_lease = control._publish_expected_exit_lease(
            expected_gateway,
            controller_identity,
        )
    finally:
        os.umask(original_umask)
    restrictive_umask_modes = [
        os.stat(lease_path, follow_symlinks=False).st_mode & 0o777,
        os.stat(lock_path, follow_symlinks=False).st_mode & 0o777,
    ]
    control._clear_expected_exit_lease(restrictive_umask_lease)

    control._terminate_gateway = replace_gateway
    try:
        restarted = control._control("restart", "a" * 64)
        restart_lease_cleared = not os.path.exists(lease_path)
        recovered = control._control("recover", "b" * 64)
        probed = control._control("probe", "e" * 64)

        real_detect_agent = control._detect_agent
        real_agent_spec = control._agent_spec
        real_gateway_candidates = control._gateway_candidates
        real_wait_for_healthy = control._wait_for_healthy_gateway
        control._detect_agent = lambda: "openclaw"
        control._agent_spec = lambda *_args: control.AgentSpec("openclaw", 18642)
        control._gateway_candidates = lambda reader, *_args: [reader.capture(43)]
        control._wait_for_healthy_gateway = lambda reader, *_args: reader.capture(43)
        control._terminate_gateway = lambda _reader, identity: observe_expected_exit_lease(
            identity, "openclaw-restart"
        )
        try:
            openclaw_restart = control._control("restart", "f" * 64)
            openclaw_lease_cleared = not os.path.exists(lease_path)
        finally:
            control._detect_agent = real_detect_agent
            control._agent_spec = real_agent_spec
            control._gateway_candidates = real_gateway_candidates
            control._wait_for_healthy_gateway = real_wait_for_healthy
            control._terminate_gateway = replace_gateway

        real_wait_for_healthy = control._wait_for_healthy_gateway
        timeout_refresh_waits = []
        timeout_refresh_signals = []
        def timeout_refresh_wait(
            reader,
            _supervisor,
            _spec,
            old_identity,
            timeout_seconds=control.RECOVERY_TIMEOUT_SECONDS,
            require_auxiliary_health=False,
        ):
            timeout_refresh_waits.append([
                old_identity.pid if old_identity else 0,
                timeout_seconds,
                require_auxiliary_health,
            ])
            if len(timeout_refresh_waits) == 1:
                remove_process(proc_root, 43)
                write_process(
                    proc_root,
                    namespace_path,
                    44,
                    666,
                    40,
                    1000,
                    b"/usr/local/bin/hermes.real\0gateway\0run\0",
                    listener_inode="77777",
                )
                raise control.ControlError("GATEWAY_HEALTH_TIMEOUT")
            if len(timeout_refresh_waits) == 2:
                raise control.ControlError("GATEWAY_HEALTH_TIMEOUT")
            return reader.capture(45)
        def terminate_refreshed_gateway(_reader, identity):
            timeout_refresh_signals.append(identity.pid)
            assert identity.pid == 44
            observe_expected_exit_lease(identity, "unhealthy-recover")
            remove_process(proc_root, 44)
            write_process(
                proc_root,
                namespace_path,
                45,
                777,
                40,
                1000,
                b"/usr/local/bin/hermes.real\0gateway\0run\0",
                listener_inode="77777",
            )
        control._wait_for_healthy_gateway = timeout_refresh_wait
        control._terminate_gateway = terminate_refreshed_gateway
        try:
            timeout_refresh = control._control("recover", "d" * 64)
            timeout_lease_cleared = not os.path.exists(lease_path)
        finally:
            control._wait_for_healthy_gateway = real_wait_for_healthy
            control._terminate_gateway = replace_gateway
            remove_process(proc_root, 45)
            write_process(
                proc_root,
                namespace_path,
                43,
                555,
                40,
                1000,
                b"/usr/local/bin/hermes.real\0gateway\0run\0",
                listener_inode="77777",
            )

        real_gateway_healthy = control._gateway_healthy
        inflight_health_attempts = []
        def inflight_health(*_args):
            inflight_health_attempts.append("attempt")
            return len(inflight_health_attempts) >= 2
        control._gateway_healthy = inflight_health
        control._terminate_gateway = lambda *_args: (_ for _ in ()).throw(
            AssertionError("recover must not terminate an in-flight healthy replacement")
        )
        try:
            inflight_recovery = control._control("recover", "c" * 64)
        finally:
            control._gateway_healthy = real_gateway_healthy
            control._terminate_gateway = replace_gateway
        real_gateway_healthy = control._gateway_healthy
        health_attempts = []
        def transient_health(*_args):
            health_attempts.append("attempt")
            if len(health_attempts) == 1:
                raise FileNotFoundError("replacement exited")
            return True
        control._gateway_healthy = transient_health
        try:
            with control.ProcReader(proc_root) as retry_reader:
                retry_supervisor = control._discover_supervisor(retry_reader)
                retried_pid = control._wait_for_healthy_gateway(
                    retry_reader, retry_supervisor, control.AgentSpec("hermes", 18642), None
                ).pid
        finally:
            control._gateway_healthy = real_gateway_healthy

        real_http_health = control._http_healthy_in_gateway_namespace
        public_health_attempts = []
        def delayed_public_health(_reader, _identity, port, path):
            if (port, path) == (8642, "/health"):
                public_health_attempts.append("attempt")
                return len(public_health_attempts) >= 2
            return (port, path) == (18642, "/health")
        control._http_healthy_in_gateway_namespace = delayed_public_health
        try:
            with control.ProcReader(proc_root) as readiness_reader:
                readiness_supervisor = control._discover_supervisor(readiness_reader)
                readiness_pid = control._wait_for_healthy_gateway(
                    readiness_reader,
                    readiness_supervisor,
                    control.AgentSpec(
                        "hermes", 18642, readiness_checks=((8642, "/health"),)
                    ),
                    None,
                    1.0,
                    True,
                ).pid
        finally:
            control._http_healthy_in_gateway_namespace = real_http_health

        auxiliary_attempts = []
        real_auxiliary_health = control._gateway_auxiliaries_healthy
        def replace_during_auxiliary_check(_reader, identity, _spec):
            auxiliary_attempts.append(identity.pid)
            if identity.pid == 43:
                remove_process(proc_root, 43)
                write_process(
                    proc_root,
                    namespace_path,
                    44,
                    666,
                    40,
                    1000,
                    b"/usr/local/bin/hermes.real\0gateway\0run\0",
                    listener_inode="77777",
                )
                return False
            return True
        control._gateway_auxiliaries_healthy = replace_during_auxiliary_check
        try:
            with control.ProcReader(proc_root) as auxiliary_reader:
                auxiliary_supervisor = control._discover_supervisor(auxiliary_reader)
                auxiliary_replacement = control._wait_for_healthy_gateway(
                    auxiliary_reader,
                    auxiliary_supervisor,
                    control.AgentSpec("hermes", 18642),
                    None,
                    1.0,
                    True,
                ).pid
        finally:
            control._gateway_auxiliaries_healthy = real_auxiliary_health
    finally:
        control._terminate_gateway = real_terminate
        control._proc_root = real_proc_root

    os.environ["NEMOCLAW_MANAGED_CONTROL_PROC_ROOT"] = "/attacker/proc"
    os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = "/attacker/root"
    source_proc = control._proc_root()
    source_system = control._system_root()
    del os.environ["NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST"]
    disabled_source_proc = control._proc_root()
    disabled_source_system = control._system_root()
    control.__file__ = control.INSTALLED_HELPER_PATH
    installed_proc = control._proc_root()
    installed_system = control._system_root()

    control.__file__ = sys.argv[1]
    os.environ["NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST"] = "1"
    real_control = control._control
    control._control = lambda *_args: (_ for _ in ()).throw(
        control.ControlError("SUPERVISOR_UNAVAILABLE", stage="await-replacement")
    )
    staged_stderr = io.StringIO()
    try:
        with contextlib.redirect_stderr(staged_stderr):
            staged_status = control.main(["restart", "f" * 64])
    finally:
        control._control = real_control
    staged_diagnostic = [staged_status, staged_stderr.getvalue().splitlines()]

    print(json.dumps({
        "initial": initial_proof,
        "zombie_leader_with_live_sibling": zombie_leader_with_live_sibling,
        "state_key_behavior": state_key_behavior,
        "mixed_namespace_rejected": mixed_namespace_rejected,
        "transient_supervisor_retry": transient_supervisor_retry,
        "persistent_supervisor_churn": persistent_supervisor_churn,
        "transient_gateway_candidates": transient_gateway_candidates,
        "namespace_denied": namespace_denied,
        "preflight": verified_preflight_steps,
        "preflight_proof_retry": [
            transient_preflight_retry,
            persistent_preflight_retry,
            changed_preflight_identity,
        ],
        "runtime_validation": runtime_validation,
        "missing_supervisor": missing_supervisor,
        "appearing_supervisor": appearing_supervisor,
        "unreadable_process": unreadable_process,
        "empty_live_process": empty_live_process,
        "duplicate_supervisor": duplicate_supervisor,
        "duplicate": duplicate,
        "signals": sent,
        "termination_proof_reads": termination_proof_reads,
        "pidfd_exit_races": [
            pidfd_recapture_exit,
            pidfd_open_exit,
            pidfd_signal_exit,
        ],
        "pidfd_helper_errors": [
            helper_pidfd_open_esrch,
            helper_pidfd_send_esrch,
            helper_pidfd_send_eperm,
            kill_timeout,
        ],
        "reused": reused,
        "restarted": restarted,
        "recovered": recovered,
        "probed": probed,
        "openclaw_restart": openclaw_restart,
        "lease_races": [
            active_controller_lock,
            marker_flock_cannot_pin,
            inode_safe_cleanup,
            restrictive_umask_modes,
        ],
        "expected_exit_leases": [
            lease_observations,
            restart_lease_cleared,
            timeout_lease_cleared,
            openclaw_lease_cleared,
        ],
        "timeout_refresh": [
            timeout_refresh,
            timeout_refresh_signals,
            timeout_refresh_waits,
        ],
        "inflight_recovery": [inflight_recovery, len(inflight_health_attempts)],
        "transient_retry": [retried_pid, len(health_attempts)],
        "public_readiness_retry": [readiness_pid, len(public_health_attempts)],
        "auxiliary_replacement": [auxiliary_replacement, auxiliary_attempts],
        "source_seams": [source_proc, source_system],
        "disabled_source_seams": [disabled_source_proc, disabled_source_system],
        "installed_seams": [installed_proc, installed_system],
        "staged_diagnostic": staged_diagnostic,
    }))
`;

describe("managed gateway root control", () => {
  it("pins the OpenShell process tree, rejects ambiguity/reuse, and proves restart/recover", () => {
    const result = spawnSync("python3", ["-c", PROCESS_HARNESS, HELPER, BOUNDARY_VALIDATOR], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      initial: {
        stable_zombie: ["Z", 0],
        supervisor: [40, "222", 1],
        gateway: [41, "333", 40],
        healthy: true,
      },
      zombie_leader_with_live_sibling: "SUPERVISOR_UNAVAILABLE",
      state_key_behavior: [true, false],
      mixed_namespace_rejected: true,
      transient_supervisor_retry: [40, 6],
      persistent_supervisor_churn: ["SUPERVISOR_UNAVAILABLE", expect.any(Number), 1],
      transient_gateway_candidates: [41, 5],
      namespace_denied: true,
      preflight: [
        {
          script: expect.stringContaining(
            "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
          ),
          arguments: ["env-file", expect.stringContaining("/sandbox/.hermes/.env")],
        },
        {
          script: expect.stringContaining(
            "/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
          ),
          arguments: ["runtime-env"],
          runtime_port: "18789",
        },
        { hash: "checked" },
      ],
      preflight_proof_retry: [
        [3, 0.1],
        ["SUPERVISOR_UNAVAILABLE", true, 1],
        ["SUPERVISOR_UNAVAILABLE", 0],
      ],
      runtime_validation: "in-process",
      missing_supervisor: "SUPERVISOR_NOT_RUNNING",
      appearing_supervisor: "SUPERVISOR_UNAVAILABLE",
      unreadable_process: "SUPERVISOR_UNAVAILABLE",
      empty_live_process: "SUPERVISOR_UNAVAILABLE",
      duplicate_supervisor: "SUPERVISOR_UNAVAILABLE",
      duplicate: "SUPERVISOR_UNAVAILABLE",
      signals: [15, 9],
      termination_proof_reads: 1,
      pidfd_exit_races: ["accepted", "accepted", "accepted"],
      pidfd_helper_errors: [null, false, "GATEWAY_FAILED", ["GATEWAY_FAILED", [15, 9]]],
      reused: "SUPERVISOR_UNAVAILABLE",
      restarted: ["ok", 41, 43],
      recovered: ["already-running", 43, 43],
      probed: ["already-running", 43, 43],
      openclaw_restart: ["ok", 43, 43],
      lease_races: ["SUPERVISOR_BUSY", true, true, [0o444, 0o600]],
      expected_exit_leases: [
        [
          {
            label: "restart",
            identity: ["v1", 41, "333", expect.any(Number), "777"],
            secure: true,
          },
          {
            label: "openclaw-restart",
            identity: ["v1", 43, "555", expect.any(Number), "777"],
            secure: true,
          },
          {
            label: "unhealthy-recover",
            identity: ["v1", 44, "666", expect.any(Number), "777"],
            secure: true,
          },
        ],
        true,
        true,
        true,
      ],
      timeout_refresh: [
        ["ok", 44, 45],
        [44],
        [
          [0, 10, false],
          [0, 10, false],
          [44, 150, true],
        ],
      ],
      inflight_recovery: [["already-running", 43, 43], 4],
      transient_retry: [43, 2],
      public_readiness_retry: [43, 2],
      auxiliary_replacement: [44, [43, 44]],
      source_seams: ["/attacker/proc", "/attacker/root"],
      disabled_source_seams: ["/proc", "/"],
      installed_seams: ["/proc", "/"],
      staged_diagnostic: [
        1,
        ["SUPERVISOR_UNAVAILABLE", "NEMOCLAW_CONTROL_STAGE=await-replacement"],
      ],
    });
  });

  it.each([
    ["replace", NONCE, "SUPERVISOR_INVALID_ACTION"],
    ["restart", "abcd", "SUPERVISOR_INVALID_NONCE"],
  ])("returns the existing marker for an invalid %s request", (action, nonce, marker) => {
    const result = spawnSync("python3", [HELPER, action, nonce], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(marker);
  });
});
