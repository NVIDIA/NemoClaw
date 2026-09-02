// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const RUNTIME_STATE_MUTATION_CONTROL_HARNESS = String.raw`
import importlib.util
import fcntl
import json
import os
import select
import signal
import stat
import subprocess
import sys
import tempfile
import time
import types

spec = importlib.util.spec_from_file_location("runtime_state_control", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)
control.ROOT_UID = os.getuid()
control.ROOT_GID = os.getgid()
control.POLL_SECONDS = 0
control.STABLE_SCANS = 3

real_apply_plan_posture = control._apply_plan_posture
real_assert_private_procfs = control._assert_private_procfs
real_discover_fence = control._discover_fence
real_exclude_writers = control._exclude_writers
real_hold_exact_processes = control._hold_exact_processes
real_activate_exact = control._activate_exact
real_start_activation_guard = control._start_activation_guard
real_kernel_pid_namespace_stop = control._kernel_pid_namespace_stop
real_activation_attempt_pending = control._activation_attempt_pending
real_cleanup_activation_protocol = control._cleanup_activation_protocol
real_unlink_control_file = control._unlink_control_file
real_publish_activation_receipt = control._publish_activation_receipt
real_verify_activation_receipt = control._verify_activation_receipt
real_health_status = control._health_status
real_release_activation_hold = control._release_activation_hold
real_parse_proc_uids = control._parse_proc_uids
real_recapture_reference = control._recapture_reference
real_capture_process = control._capture_process
real_signal_exact_process = control._signal_exact_process
real_signal_reference = control._signal_reference
real_wait_for_reference_running = control._wait_for_reference_running
real_prove_fence_shape = control._prove_fence_shape
real_resume_reference = control._resume_reference
real_prove_released_activation = control._prove_released_activation
real_prove_parent_acknowledged_activation = control._prove_parent_acknowledged_activation
real_resume_acknowledged_parent = control._resume_acknowledged_parent
real_transport_broker_reference = control._transport_broker_reference
control._assert_private_procfs = lambda: None
control._open_activation_guard_pidfd = lambda _reference: os.open(
    os.devnull, os.O_RDONLY
)
control._open_activation_guard_current_pidfd = lambda: os.open(
    os.devnull, os.O_RDONLY
)

def code(call):
    try:
        call()
    except control.ControlError as error:
        return error.code
    return "ok"

def plan(projection, intent="protection-transition"):
    if intent != "protection-transition":
        return {
            "schemaVersion": 2,
            "intent": intent,
            "stateRoot": "/sandbox/.hermes",
            "selectors": [{"kind": "path", "path": "config.yaml"}],
            "projectionSha256": projection,
        }
    return {
        "schemaVersion": 2,
        "intent": "protection-transition",
        "target": "locked",
        "rollback": "mutable",
        "stateLockPlan": {
            "version": 1,
            "readOnlyRoots": ["cron"],
            "confidentialRoots": ["credentials"],
            "readOnlyPrefixes": ["workspace-"],
            "confidentialPrefixes": [],
            "writableSubpaths": ["cron/scratch"],
        },
        "stateRoot": "/sandbox/.hermes",
        "selectors": [
            {"kind": "path", "path": ".config-hash"},
            {"kind": "path", "path": ".env"},
            {"kind": "path", "path": "config.yaml"},
            {"kind": "path", "path": "credentials"},
            {"kind": "path", "path": "cron"},
            {"kind": "prefix", "prefix": "workspace-"},
        ],
        "projectionSha256": projection,
    }

def acquire_value(nonce="d" * 64, selected_plan=None, lifecycle_generation="generation:7", provider_id="docker"):
    projection = "b" * 64
    selected = plan(projection) if selected_plan is None else selected_plan
    serialized = control._json_bytes(selected).decode()
    request = control.AcquireRequest(
        "0" * 64,
        provider_id,
        "alpha",
        lifecycle_generation,
        "3" * 64,
        "1" * 64,
        4812,
        "4" * 64,
        "5" * 64,
        "/sandbox/.hermes",
        "6" * 64,
        control._sha256(serialized.encode()),
        projection,
        nonce,
        selected,
        serialized,
        "locked",
        "mutable",
    )
    transaction = control._expected_transaction_id(request)
    return {
        "schemaVersion": 1,
        "action": "acquire",
        "transactionId": transaction,
        "providerId": provider_id,
        "sandboxName": "alpha",
        "lifecycleGeneration": lifecycle_generation,
        "engineBindingSha256": "3" * 64,
        "runtimeId": "1" * 64,
        "runtimePid": 4812,
        "sandboxIdentitySha256": "4" * 64,
        "containerMountsSha256": "5" * 64,
        "stateRoot": "/sandbox/.hermes",
        "stateRootMountsSha256": "6" * 64,
        "plan": serialized,
        "planSha256": request.plan_sha256,
        "projectionSha256": projection,
        "nonce": nonce,
        "target": "locked",
        "rollback": "mutable",
    }

def status_value(action, acquire, provider_handle=None, activation_handle=None, completed=None):
    value = {
        "schemaVersion": 1,
        "action": action,
        "transactionId": acquire["transactionId"],
        "providerId": acquire["providerId"],
        "sandboxName": "alpha",
        "lifecycleGeneration": "generation:7",
        "engineBindingSha256": "3" * 64,
        "runtimeId": "1" * 64,
        "runtimePid": 4812,
        "sandboxIdentitySha256": "4" * 64,
        "containerMountsSha256": "5" * 64,
    }
    if action != "recover":
        value["providerHandle"] = provider_handle
    if action == "release":
        value["activationProviderHandle"] = activation_handle
        value["completedLedgerSha256"] = completed
    return value

def parse(action, value):
    return control._parse_request(action, control._json_bytes(value) + b"\n")

def process(
    pid,
    state,
    parent,
    start,
    uid,
    command,
    inode,
    executable_inode=None,
    executable_device=81,
):
    if executable_inode is None:
        executable_inode = 10_000 + inode
    return control.ProcessIdentity(
        pid,
        state,
        parent,
        start,
        (uid, uid, uid, uid),
        command,
        91,
        inode,
        executable_device,
        executable_inode,
    )

fixed_transport_broker = process(
    88,
    "S",
    1,
    "788",
    control.ROOT_UID,
    (
        b"/opt/hermes/.venv/bin/python3",
        b"-I",
        control.TRANSPORT_BROKER_PATH,
        b"a" * 64,
    ),
    188,
)
forged_transport_broker = process(
    89,
    "S",
    1,
    "789",
    control.ROOT_UID,
    (
        control.TRANSPORT_BROKER_PYTHON,
        b"-I",
        control.TRANSPORT_BROKER_PATH,
        b"a" * 64,
    ),
    189,
    fixed_transport_broker.executable_inode + 1,
)
wrong_device_transport_broker = process(
    92,
    "S",
    1,
    "792",
    control.ROOT_UID,
    fixed_transport_broker.command,
    192,
    fixed_transport_broker.executable_inode,
    fixed_transport_broker.executable_device + 1,
)
wrong_argv_transport_broker = process(
    90,
    "S",
    1,
    "790",
    control.ROOT_UID,
    (
        b"/tmp/forged-python",
        b"-I",
        control.TRANSPORT_BROKER_PATH,
        b"a" * 64,
    ),
    190,
    fixed_transport_broker.executable_inode,
)
dynamic_transport_broker = process(
    91,
    "S",
    1,
    "791",
    control.ROOT_UID,
    (
        b"/opt/hermes/.venv/bin/python3",
        b"-I",
        b"-c",
        b"dynamic-source",
        b"encoded-source",
        b"/usr/local/lib/nemoclaw/runtime-state-mutation-control.py",
        b"a" * 64,
    ),
    191,
)
real_os_stat = control.os.stat
transport_broker_executable = types.SimpleNamespace(
    st_mode=stat.S_IFREG | 0o755,
    st_uid=control.ROOT_UID,
    st_gid=control.ROOT_GID,
    st_dev=fixed_transport_broker.executable_device,
    st_ino=fixed_transport_broker.executable_inode,
)
control.os.stat = lambda path, *args, **kwargs: (
    transport_broker_executable
    if path == control.TRANSPORT_BROKER_PYTHON
    else real_os_stat(path, *args, **kwargs)
)
control._capture_process = lambda _pid: fixed_transport_broker
fixed_transport_broker_reference = real_transport_broker_reference()
results = {"fixed_transport_broker": fixed_transport_broker_reference.pid}
control._capture_process = lambda _pid: forged_transport_broker
results["forged_transport_broker_rejected"] = real_transport_broker_reference() is None
control._capture_process = lambda _pid: wrong_device_transport_broker
results["wrong_device_transport_broker_rejected"] = (
    real_transport_broker_reference() is None
)
control._capture_process = lambda _pid: wrong_argv_transport_broker
results["wrong_argv_transport_broker_rejected"] = (
    real_transport_broker_reference() is None
)
control._capture_process = lambda _pid: dynamic_transport_broker
results["dynamic_transport_broker_rejected"] = real_transport_broker_reference() is None
control._capture_process = real_capture_process
control.os.stat = real_os_stat

root_uid = control.ROOT_UID
pid1 = process(1, "S", 0, "100", root_uid, (control.OPENSHELL_ARGV0,), 101)
stopped_pid1 = process(1, "T", 0, "100", root_uid, (control.OPENSHELL_ARGV0,), 101)
def start_process(pid, command):
    return process(pid, "S", 1, str(190 + pid), 1001, command, 100 + pid)
start = start_process(10, (b"/bin/bash", control.NEMOCLAW_START_PATH, b"/bin/bash"))
prefixed_start = start_process(11, (b"/bin/bash", b"--noprofile", control.NEMOCLAW_START_PATH))
reordered_start = start_process(12, (b"/bin/bash", b"/bin/bash", control.NEMOCLAW_START_PATH))
bare_direct_start = start_process(13, (b"nemoclaw-start", b"/bin/bash"))
bare_interpreted_start = start_process(14, (b"/bin/bash", b"nemoclaw-start", b"/bin/bash"))
gateway = process(
    77,
    "S",
    10,
    "707",
    1000,
    (b"/usr/local/bin/hermes", b"gateway", b"run"),
    177,
)
auxiliary = process(78, "S", 10, "708", 1001, (b"tail", b"-F"), 178)
stdout_drain = process(
    75,
    "S",
    10,
    "705",
    1001,
    (b"tee", b"-a", control.START_LOG_PATH),
    175,
)
stderr_drain = process(
    76,
    "S",
    10,
    "706",
    1001,
    (b"tee", b"-a", control.START_LOG_PATH),
    176,
)
fence = control.FenceProof(
    control._process_reference(pid1),
    control._process_reference(start),
    (
        control._process_reference(stdout_drain),
        control._process_reference(stderr_drain),
    ),
    (1000, 1001),
)
activation = control.ActivationProof(
    gateway.pid,
    gateway.start_identity,
    1000,
    "sha256:" + "a" * 64,
    "tcp:18642:991",
    "f" * 64,
    "c" * 64,
    (gateway.pid,),
    (
        control._process_reference(stdout_drain),
        control._process_reference(stderr_drain),
        control._process_reference(gateway),
        control._process_reference(auxiliary),
    ),
)

with tempfile.TemporaryDirectory() as process_probe:
    process_metadata = os.stat(process_probe, follow_symlinks=False)
    real_os_stat = control.os.stat
    real_read_proc_file = control._read_proc_file
    control.os.stat = lambda _path, follow_symlinks=False: process_metadata
    try:
        control._read_proc_file = lambda _path, _maximum=control.MAX_PROC_FILE_BYTES: (
            _ for _ in ()
        ).throw(ProcessLookupError())
        results["vanished_process"] = real_capture_process(42) is None
        control._read_proc_file = lambda _path, _maximum=control.MAX_PROC_FILE_BYTES: (
            _ for _ in ()
        ).throw(OSError())
        results["unreadable_process_io"] = code(lambda: real_capture_process(42))
    finally:
        control.os.stat = real_os_stat
        control._read_proc_file = real_read_proc_file
same_task_after_exec = process(
    start.pid,
    start.state,
    start.parent_pid + 1,
    start.start_identity,
    1000,
    (b"/usr/local/bin/hermes", b"gateway"),
    start.proc_inode,
)
replacement_task = process(
    start.pid,
    start.state,
    start.parent_pid,
    str(int(start.start_identity) + 1),
    1001,
    start.command,
    start.proc_inode + 1,
)
same_task_executable_replacement = process(
    start.pid,
    start.state,
    start.parent_pid,
    start.start_identity,
    1001,
    start.command,
    start.proc_inode,
    start.executable_inode + 1,
)
real_pidfd_open = getattr(control.os, "pidfd_open", None)
real_pidfd_send_signal = getattr(control.signal, "pidfd_send_signal", None)
real_os_close = control.os.close
pidfd_signal_events = []
control.os.pidfd_open = lambda pid, flags: (
    pidfd_signal_events.append(["open", pid, flags]) or 91
)
control.signal.pidfd_send_signal = lambda pidfd, requested: pidfd_signal_events.append(
    ["signal", pidfd, requested]
)
control.os.close = lambda pidfd: pidfd_signal_events.append(["close", pidfd])
try:
    control._capture_process = lambda _pid: same_task_after_exec
    results["same_task_signal"] = code(
        lambda: real_signal_exact_process(start, signal.SIGSTOP)
    )
    results["same_task_signal_events"] = list(pidfd_signal_events)
    pidfd_signal_events.clear()
    control._capture_process = lambda _pid: replacement_task
    results["replacement_task_signal"] = code(
        lambda: real_signal_exact_process(start, signal.SIGSTOP)
    )
    results["replacement_task_signal_events"] = list(pidfd_signal_events)
    pidfd_signal_events.clear()
    control._capture_process = lambda _pid: same_task_executable_replacement
    results["same_task_executable_replacement_signal"] = code(
        lambda: real_signal_exact_process(start, signal.SIGSTOP)
    )
    results["same_task_executable_replacement_signal_events"] = list(
        pidfd_signal_events
    )
finally:
    control._capture_process = real_capture_process
    if real_pidfd_open is None:
        del control.os.pidfd_open
    else:
        control.os.pidfd_open = real_pidfd_open
    if real_pidfd_send_signal is None:
        del control.signal.pidfd_send_signal
    else:
        control.signal.pidfd_send_signal = real_pidfd_send_signal
    control.os.close = real_os_close
reference_signal_attempts = []
control._recapture_reference = lambda _reference, _code="fenced-process-drift": start
def signal_reference_after_rescan(selected, requested):
    reference_signal_attempts.append([selected.pid, requested])
    if len(reference_signal_attempts) < 4:
        raise control.ControlError("writer-pid-reused")
control._signal_exact_process = signal_reference_after_rescan
real_signal_reference(control._process_reference(start), signal.SIGSTOP)
results["reference_signal_attempts"] = reference_signal_attempts
replacement_recaptures = [start]
control._recapture_reference = lambda _reference, _code="fenced-process-drift": (
    replacement_recaptures.pop(0)
    if replacement_recaptures
    else (_ for _ in ()).throw(control.ControlError(_code))
)
control._signal_exact_process = lambda _selected, _requested: (_ for _ in ()).throw(
    control.ControlError("writer-pid-reused")
)
results["replaced_reference_signal"] = code(
    lambda: real_signal_reference(control._process_reference(start), signal.SIGSTOP)
)
control._recapture_reference = lambda _reference, _code="fenced-process-drift": start
control.PROCESS_STATE_SECONDS = 0
results["reference_signal_timeout"] = code(
    lambda: real_signal_reference(control._process_reference(start), signal.SIGSTOP)
)
control.PROCESS_STATE_SECONDS = 5
control._recapture_reference = real_recapture_reference
control._signal_exact_process = real_signal_exact_process
with tempfile.TemporaryDirectory() as atomic_root:
    atomic_root_fd = os.open(atomic_root, os.O_RDONLY | os.O_DIRECTORY)
    atomic_creation_modes = []
    real_os_open = control.os.open
    def recording_os_open(path, flags, mode=0o777, *, dir_fd=None):
        atomic_creation_modes.append(mode)
        return real_os_open(path, flags, mode, dir_fd=dir_fd)
    control.os.open = recording_os_open
    try:
        control._atomic_write(
            atomic_root_fd,
            "public-receipt.json",
            b"{}\n",
            mode=0o444,
        )
        atomic_final_mode = stat.S_IMODE(
            os.stat(
                "public-receipt.json",
                dir_fd=atomic_root_fd,
                follow_symlinks=False,
            ).st_mode
        )
    finally:
        control.os.open = real_os_open
        os.close(atomic_root_fd)
results["atomic_write_modes"] = [atomic_creation_modes, atomic_final_mode]
results["sigcont"] = int(signal.SIGCONT)
results["sigstop"] = int(signal.SIGSTOP)
hold_command_read, hold_command_write = os.pipe()
hold_ack_read, hold_ack_write = os.pipe()
hold_child = os.fork()
if hold_child == 0:
    try:
        os.close(hold_command_write)
        os.close(hold_ack_read)
        command = os.read(hold_command_read, 1)
        os.write(hold_ack_write, command)
    finally:
        os._exit(0)
os.close(hold_command_read)
os.close(hold_ack_write)
hold_guard = control.ActivationGuard(
    hold_child,
    hold_command_write,
    hold_ack_read,
    fence,
    "mnt:[401]",
)
hold_guard.fail_closed()
results["live_guard_hold_command"] = True
kernel_stop_calls = []
real_os_kill = os.kill
os.kill = lambda pid, requested: kernel_stop_calls.append([pid, requested])
try:
    real_kernel_pid_namespace_stop()
finally:
    os.kill = real_os_kill
results["kernel_namespace_broadcast"] = kernel_stop_calls
live_hold_events = []
real_stop_pid_namespace_fail_closed = control._stop_pid_namespace_fail_closed
real_resume_activation_guard_pidfd = control._resume_activation_guard_pidfd
control._stop_pid_namespace_fail_closed = lambda pidfds: live_hold_events.append(
    ["stop", list(pidfds)]
)
control._resume_activation_guard_pidfd = lambda pidfd: live_hold_events.append(
    ["resume", pidfd]
)
try:
    control._hold_pid_namespace_for_live_controller((11, 12), (13, 14))
finally:
    control._stop_pid_namespace_fail_closed = real_stop_pid_namespace_fail_closed
    control._resume_activation_guard_pidfd = real_resume_activation_guard_pidfd
results["live_controller_hold_events"] = live_hold_events
stopped_gateway = process(
    gateway.pid,
    "T",
    gateway.parent_pid,
    gateway.start_identity,
    1000,
    gateway.command,
    gateway.proc_inode,
)
results["state_transition_preserves_identity"] = (
    gateway.identity_key() == stopped_gateway.identity_key()
)
canonical_value = acquire_value()
results["canonical"] = parse("acquire", canonical_value).plan_sha256
podman_value = acquire_value(provider_id="podman")
results["podman_provider"] = parse("acquire", podman_value).provider_id
podman_handle = "podman-state-mutation-v1:" + podman_value["transactionId"] + ":" + "f" * 64
results["podman_handle"] = parse(
    "assert", status_value("assert", podman_value, podman_handle)
).provider_handle
docker_handle = "docker-state-mutation-v1:" + podman_value["transactionId"] + ":" + "f" * 64
results["cross_provider_handle"] = code(
    lambda: parse("assert", status_value("assert", podman_value, docker_handle))
)
results["noncanonical"] = code(
    lambda: control._parse_request(
        "acquire",
        json.dumps(canonical_value, sort_keys=True, separators=(",", ":")).encode() + b"\n",
    )
)
duplicate = control._json_bytes(canonical_value).replace(
    b'{"schemaVersion":1,', b'{"schemaVersion":1,"schemaVersion":1,', 1
)
results["duplicate"] = code(lambda: control._parse_request("acquire", duplicate + b"\n"))
boolean_version = dict(canonical_value)
boolean_version["schemaVersion"] = True
results["boolean_version"] = code(lambda: parse("acquire", boolean_version))
wrong_transaction = dict(canonical_value)
wrong_transaction["transactionId"] = "9" * 64
results["transaction"] = code(lambda: parse("acquire", wrong_transaction))
restore = acquire_value(selected_plan=plan("b" * 64, "restore"))
results["restore"] = code(lambda: parse("acquire", restore))
unsorted_plan = plan("b" * 64)
unsorted_plan["selectors"] = list(reversed(unsorted_plan["selectors"]))
unsorted = acquire_value(selected_plan=unsorted_plan)
results["unsorted_selectors"] = code(lambda: parse("acquire", unsorted))
plus_generation = acquire_value(lifecycle_generation="generation+7")
results["plus_generation"] = parse("acquire", plus_generation).lifecycle_generation
punctuation_generation = acquire_value(lifecycle_generation=":generation")
results["punctuation_generation"] = code(lambda: parse("acquire", punctuation_generation))

with tempfile.TemporaryDirectory() as root:
    durable = os.path.join(root, "durable")
    runtime = os.path.join(root, "runtime")
    os.mkdir(durable, 0o700)
    os.mkdir(runtime, 0o700)
    durable_fd = os.open(durable, os.O_RDONLY | os.O_DIRECTORY)
    runtime_fd = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY)
    events = []
    control._capture_runtime_binding = lambda _root: (
        events.append(["capture"]) or ("mnt:[401]", "402", "403")
    )
    control._discover_fence = lambda mount: events.append(["discover", mount]) or fence
    control._hold_exact_processes = lambda selected, mount, proof: events.append(
        ["hold", mount, selected.start.pid, None if proof is None else proof.service_pid]
    )
    control._assert_active_state = lambda marker, _runtime_fd: events.append(
        ["assert", marker["phase"], marker["activation"] is not None]
    )
    control._apply_plan_posture = lambda _marker, posture: events.append(["posture", posture])
    control._activate_exact = lambda _durable_fd, _marker, _fence: events.append(["activate-exact"]) or activation
    control._publish_activation_receipt = lambda _runtime_fd, marker: events.append(
        ["activation-receipt", marker["phase"]]
    )
    control._retire_activation_tree = lambda _marker, _runtime_fd, _proof: events.append(
        [
            "retire",
            control._load_marker(durable_fd)["phase"],
            control._load_marker(durable_fd)["activation"] is not None,
        ]
    )
    control._cleanup_activation_protocol = lambda _durable_fd, marker: events.append(
        ["protocol-cleanup", marker["phase"]]
    )
    def release_hold(_durable_fd, _marker):
        receipt = control._load_released_receipt(durable_fd)
        events.append(["release-hold", receipt["releaseState"]])
    control._release_activation_hold = release_hold
    def resume_acknowledged_parent(_marker):
        receipt = control._load_released_receipt(durable_fd)
        events.append(["release-parent-resume", receipt["releaseState"]])
    control._resume_acknowledged_parent = resume_acknowledged_parent
    try:
        active_value = acquire_value()
        active = parse("acquire", active_value)
        marker = control._run_locked("acquire", active, durable_fd, runtime_fd)
        results["acquire"] = marker["phase"]
        results["acquire_fence"] = marker["fence"]
        handle = control._provider_handle(marker)
        results["assert"] = control._run_locked(
            "assert",
            parse("assert", status_value("assert", active_value, handle)),
            durable_fd,
            runtime_fd,
        )["phase"]
        publish = parse("publish", status_value("publish", active_value, handle))
        results["publish"] = control._run_locked(
            "publish", publish, durable_fd, runtime_fd
        )["phase"]
        activate = parse("activate", status_value("activate", active_value, handle))
        activated = control._run_locked("activate", activate, durable_fd, runtime_fd)
        results["activate"] = activated["phase"]
        rollback = parse("rollback", status_value("rollback", active_value, handle))
        rolled_back = control._run_locked("rollback", rollback, durable_fd, runtime_fd)
        results["rollback_after_activation"] = rolled_back["phase"]
        results["rollback_retired"] = rolled_back["activation"] is None
        activated = control._run_locked("activate", activate, durable_fd, runtime_fd)
        activation_handle = control._activation_provider_handle(activated)
        release = parse(
            "release",
            status_value("release", active_value, handle, activation_handle, "e" * 64),
        )
        results["release"] = control._run_locked(
            "release", release, durable_fd, runtime_fd
        )["phase"]
        results["released_marker"] = control._load_marker(durable_fd) is None
        results["released_sentinel"] = (
            control._read_private_file(runtime_fd, control.SENTINEL_NAME, 1024) is None
        )
        results["released_state"] = control._load_released_receipt(durable_fd)["releaseState"]
        results["release_retry"] = control._run_locked(
            "release", release, durable_fd, runtime_fd
        )["phase"]
        recover_released = parse("recover", status_value("recover", active_value))
        results["recover_released"] = control._run_locked(
            "recover", recover_released, durable_fd, runtime_fd
        )["phase"]
        released_receipt = control._load_released_receipt(durable_fd)
        results["released_reacquire"] = code(
            lambda: control._run_locked("acquire", active, durable_fd, runtime_fd)
        )

        next_value = acquire_value(nonce="8" * 64)
        next_request = parse("acquire", next_value)
        next_marker = control._run_locked("acquire", next_request, durable_fd, runtime_fd)
        next_handle = control._provider_handle(next_marker)
        next_publish = parse("publish", status_value("publish", next_value, next_handle))
        control._run_locked("publish", next_publish, durable_fd, runtime_fd)
        next_activate = parse("activate", status_value("activate", next_value, next_handle))
        next_activated = control._run_locked("activate", next_activate, durable_fd, runtime_fd)
        control._atomic_write(
            durable_fd,
            control.RELEASED_RECEIPT_NAME,
            control._json_bytes(released_receipt) + b"\n",
        )
        control._run_locked("release", release, durable_fd, runtime_fd)
        results["stale_release_preserves_active"] = (
            control._load_marker(durable_fd)["transactionId"] == next_request.transaction_id
        )
        control._unlink_private(runtime_fd, control.SENTINEL_NAME)
        recover = parse("recover", status_value("recover", next_value))
        recovered = control._run_locked("recover", recover, durable_fd, runtime_fd)
        results["recover_activation"] = recovered["phase"]
        wrong = status_value("recover", next_value)
        wrong["sandboxIdentitySha256"] = "9" * 64
        results["wrong_binding"] = code(
            lambda: control._run_locked(
                "recover", parse("recover", wrong), durable_fd, runtime_fd
            )
        )
        results["state_events"] = events
        marker_for_helpers = next_activated
    finally:
        os.close(runtime_fd)
        os.close(durable_fd)

class PublisherError(RuntimeError):
    def __init__(self, error_code):
        super().__init__(error_code)
        self.code = error_code

publisher_calls = []
def publisher_apply(marker, posture):
    publisher_calls.append([marker["transactionId"], posture])
    return {
        "schemaVersion": 1,
        "protocol": control.PUBLISHER_PROTOCOL,
        "transactionId": marker["transactionId"],
        "nonce": marker["nonce"],
        "planSha256": marker["planSha256"],
        "projectionSha256": marker["projectionSha256"],
        "posture": posture,
        "verificationSha256": "9" * 64,
    }
publisher_module = types.SimpleNamespace(
    PublisherError=PublisherError,
    apply_plan_posture=publisher_apply,
)
control._load_publisher_module = lambda: publisher_module
results["publisher_valid"] = code(
    lambda: real_apply_plan_posture(marker_for_helpers, "locked")
)
results["publisher_calls"] = publisher_calls
publisher_module.apply_plan_posture = lambda _marker, _posture: {
    "schemaVersion": 1,
    "protocol": "wrong",
    "transactionId": marker_for_helpers["transactionId"],
    "nonce": marker_for_helpers["nonce"],
    "planSha256": marker_for_helpers["planSha256"],
    "projectionSha256": marker_for_helpers["projectionSha256"],
    "posture": "locked",
    "verificationSha256": "9" * 64,
}
results["publisher_bad_receipt"] = code(
    lambda: real_apply_plan_posture(marker_for_helpers, "locked")
)
def publisher_refuse(_marker, _posture):
    raise PublisherError("publisher-posture-refused")
publisher_module.apply_plan_posture = publisher_refuse
results["publisher_error"] = code(
    lambda: real_apply_plan_posture(marker_for_helpers, "locked")
)

control._supported_writer_uids = lambda: (1000, 1001)
control._sandbox_uid = lambda: 1001
control._capture_process = lambda pid: {
    1: pid1,
    10: start,
    75: stdout_drain,
    76: stderr_drain,
}.get(pid)
control._capture_writer_processes = lambda _uids: (
    start,
    stdout_drain,
    stderr_drain,
    gateway,
)
results["managed_start_with_cmd"] = control._is_nemoclaw_start(start, 1001)
results["prefixed_start"] = control._is_nemoclaw_start(prefixed_start, 1001)
results["reordered_start"] = control._is_nemoclaw_start(reordered_start, 1001)
results["bare_direct_start"] = control._is_nemoclaw_start(bare_direct_start, 1001)
results["bare_interpreted_start"] = control._is_nemoclaw_start(bare_interpreted_start, 1001)
real_readlink = os.readlink
os.readlink = lambda selected: "mnt:[401]" if selected == control.MOUNT_NAMESPACE_PATH else real_readlink(selected)
try:
    discovered = real_discover_fence("mnt:[401]")
    results["discovered_pid1"] = discovered.supervisor.pid
    results["discovered_start"] = discovered.start.pid
    wrong_pid1 = process(1, "S", 0, "100", root_uid, (b"/bin/sh",), 101)
    control._capture_process = lambda pid: {1: wrong_pid1, 10: start}.get(pid)
    results["wrong_pid1"] = code(lambda: real_discover_fence("mnt:[401]"))
finally:
    os.readlink = real_readlink

def fence_drift(missing_pid):
    control._capture_process = lambda pid: {
        1: pid1,
        10: start,
        75: stdout_drain,
        76: stderr_drain,
    }.get(pid) if pid != missing_pid else None
    control.os.readlink = lambda selected: (
        "mnt:[401]"
        if selected == control.MOUNT_NAMESPACE_PATH
        else real_readlink(selected)
    )
    try:
        return code(lambda: real_prove_fence_shape(fence, "mnt:[401]"))
    finally:
        control.os.readlink = real_readlink

results["supervisor_identity_drift"] = fence_drift(1)
results["start_identity_drift"] = fence_drift(10)
results["startup_support_identity_drift"] = fence_drift(75)

def supervisor_refresh(selected):
    control._capture_process = lambda pid: {
        1: selected,
        10: start,
        75: stdout_drain,
        76: stderr_drain,
    }.get(pid)
    control.os.readlink = lambda path: (
        "mnt:[401]"
        if path == control.MOUNT_NAMESPACE_PATH
        else real_readlink(path)
    )
    try:
        return code(lambda: real_prove_fence_shape(fence, "mnt:[401]"))
    finally:
        control.os.readlink = real_readlink

refreshed_pid1 = process(
    1,
    "T",
    0,
    pid1.start_identity,
    root_uid,
    (control.OPENSHELL_ARGV0, b"--refreshed-status"),
    pid1.proc_inode,
)
replaced_pid1 = process(
    1,
    "T",
    0,
    "101",
    root_uid,
    (control.OPENSHELL_ARGV0,),
    102,
)
exec_replaced_pid1 = process(
    1,
    "T",
    0,
    pid1.start_identity,
    root_uid,
    (control.OPENSHELL_ARGV0, b"--forged-status"),
    pid1.proc_inode,
    pid1.executable_inode + 1,
)
results["refreshed_supervisor"] = supervisor_refresh(refreshed_pid1)
results["replaced_supervisor"] = supervisor_refresh(replaced_pid1)
results["exec_replaced_supervisor"] = supervisor_refresh(exec_replaced_pid1)

hold_events = []
control._prove_fence_shape = lambda _fence, _mount: (pid1, start)
control._stop_reference = lambda reference: hold_events.append(["stop", reference.pid])
control._exclude_writers = lambda _uids, allowed: hold_events.append(
    ["exclude", [reference.pid for reference in allowed]]
)
control._assert_writer_exclusion = lambda _uids, allowed: hold_events.append(
    ["assert-writers", [reference.pid for reference in allowed]]
)
control._capture_process = lambda pid: {
    1: pid1,
    10: start,
    75: stdout_drain,
    76: stderr_drain,
    77: gateway,
    78: auxiliary,
}.get(pid)
control.PROCESS_STATE_SECONDS = 0
results["running_supervisor_hold"] = code(lambda: real_hold_exact_processes(fence, "mnt:[401]", activation))
control.PROCESS_STATE_SECONDS = 5
control._prove_fence_shape = lambda _fence, _mount: (stopped_pid1, start)
control._capture_process = lambda pid: stopped_pid1 if pid == 1 else {
    10: start,
    75: stdout_drain,
    76: stderr_drain,
    77: gateway,
    78: auxiliary,
}.get(pid)
control._recapture_reference = lambda reference, _code="fenced-process-drift": stopped_pid1 if reference.pid == 1 else {
    10: start,
    75: stdout_drain,
    76: stderr_drain,
    77: gateway,
    78: auxiliary,
}[reference.pid]
real_hold_exact_processes(fence, "mnt:[401]", activation)
results["hold_events"] = hold_events

stopped_start = process(
    start.pid,
    "T",
    start.parent_pid,
    start.start_identity,
    1001,
    start.command,
    start.proc_inode,
)
intruder = process(42, "S", 1, "222", 1000, (b"writer",), 142)
scans = [(stopped_start, intruder), (stopped_start,), (stopped_start,), (stopped_start,)]
writer_signals = []
control._capture_writer_processes = lambda _uids: scans.pop(0)
control._signal_exact_process = lambda selected, requested: (
    writer_signals.append([selected.pid, requested]) or True
)
control.TERM_SECONDS = 5
control.KILL_SECONDS = 5
real_exclude_writers((1000, 1001), (control._process_reference(stopped_start),))
results["writer_signals"] = writer_signals
results["writer_scans_remaining"] = len(scans)
# A pidfd check may establish that the observed process has already gone
# away. That stale observation must be ignored and the writer census rescanned.
pid_reuse_scans = [
    (stopped_start, intruder),
    (stopped_start,),
    (stopped_start,),
    (stopped_start,),
]
pid_reuse_signals = []
control._capture_writer_processes = lambda _uids: pid_reuse_scans.pop(0)
def reject_replaced_writer(selected, requested):
    pid_reuse_signals.append([selected.pid, requested])
    raise control.ControlError("writer-pid-reused")
control._signal_exact_process = reject_replaced_writer
real_exclude_writers((1000, 1001), (control._process_reference(stopped_start),))
results["writer_pid_reuse_signals"] = pid_reuse_signals
results["writer_pid_reuse_scans_remaining"] = len(pid_reuse_scans)

# If the PID was reused, the next census observes and signals the replacement
# under its own full process identity.
replacement = process(42, "S", 1, "333", 1000, (b"replacement",), 143)
replacement_scans = [
    (stopped_start, intruder),
    (stopped_start, replacement),
    (stopped_start,),
    (stopped_start,),
    (stopped_start,),
]
replacement_signals = []
control._capture_writer_processes = lambda _uids: replacement_scans.pop(0)
def signal_replaced_writer(selected, requested):
    replacement_signals.append([selected.start_identity, requested])
    if selected.start_identity == intruder.start_identity:
        control._fail("writer-pid-reused")
    return True
control._signal_exact_process = signal_replaced_writer
real_exclude_writers((1000, 1001), (control._process_reference(stopped_start),))
results["replacement_writer_signals"] = replacement_signals
results["replacement_writer_scans_remaining"] = len(replacement_scans)
control._capture_writer_processes = lambda _uids: (intruder,)
control.TERM_SECONDS = 0
control.KILL_SECONDS = 0
results["unstoppable_writer"] = code(
    lambda: real_exclude_writers((1000, 1001), (control._process_reference(stopped_start),))
)
results["unknown_writer"] = code(lambda: real_parse_proc_uids(b"Name:\tunknown\n"))

class InjectedCleanupCrash(RuntimeError):
    pass

cleanup_faults = {}
original_handoff_directory = control.STARTUP_HANDOFF_DIRECTORY
original_sandbox_account = control._sandbox_account
original_cleanup_activation_protocol = control._cleanup_activation_protocol
control._cleanup_activation_protocol = real_cleanup_activation_protocol
real_os_unlink = os.unlink
real_os_rmdir = os.rmdir
with tempfile.TemporaryDirectory() as cleanup_root:
    cleanup_root = os.path.realpath(cleanup_root)
    for boundary in (
        control.ACTIVATION_PERMIT_NAME,
        control.ACTIVATION_RELEASE_NAME,
        control.ACTIVATION_RETRY_NAME,
        control.STARTUP_CANDIDATE_NAME,
        control.STARTUP_RETRY_ACK_NAME,
        "candidate-directory",
        control.ACTIVATION_CLEANUP_NAME,
    ):
        case_root = os.path.join(cleanup_root, boundary)
        os.mkdir(case_root, 0o755)
        durable_path = os.path.join(case_root, "durable")
        os.mkdir(durable_path, 0o700)
        control.STARTUP_HANDOFF_DIRECTORY = os.path.join(case_root, "handoff")
        control._sandbox_account = lambda: (os.geteuid(), os.getegid())
        durable_fd = os.open(durable_path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            opened = control._open_startup_candidate_directory(
                marker_for_helpers, create=True
            )
            assert opened is not None
            handoff_fd, candidate_fd = opened
            try:
                candidate_payload = (
                    control._canonical_protocol_payload(
                        control._startup_candidate_payload(marker_for_helpers, fence)
                    )
                )
                permit_payload = control._canonical_protocol_payload(
                    control._activation_permit_payload(marker_for_helpers, fence)
                )
                retry_payload = control._canonical_protocol_payload(
                    control._activation_retry_payload(
                        marker_for_helpers,
                        fence,
                        permit_payload,
                        candidate_payload,
                    )
                )
                ack_payload = control._canonical_protocol_payload(
                    control._startup_retry_ack_payload(
                        marker_for_helpers, fence, retry_payload
                    )
                )
                for name, payload in (
                    (control.STARTUP_CANDIDATE_NAME, candidate_payload),
                    (control.STARTUP_RETRY_ACK_NAME, ack_payload),
                ):
                    fd = os.open(
                        name,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                        dir_fd=candidate_fd,
                    )
                    os.write(fd, payload)
                    os.close(fd)
            finally:
                os.close(candidate_fd)
                os.close(handoff_fd)
            control._atomic_write(
                durable_fd,
                control.ACTIVATION_PERMIT_NAME,
                permit_payload,
                mode=0o444,
            )
            control._atomic_write(
                durable_fd,
                control.ACTIVATION_RELEASE_NAME,
                control._canonical_protocol_payload(
                    control._activation_release_payload(
                        marker_for_helpers, fence, activation
                    )
                ),
                mode=0o444,
            )
            control._atomic_write(
                durable_fd,
                control.ACTIVATION_RETRY_NAME,
                retry_payload,
                mode=0o444,
            )

            faulted = False
            def injected_unlink_control(directory_fd, name, *, mode):
                real_unlink_control_file(directory_fd, name, mode=mode)
                if name == boundary:
                    raise InjectedCleanupCrash(boundary)
            def injected_os_unlink(name, *args, **kwargs):
                real_os_unlink(name, *args, **kwargs)
                if name == boundary:
                    raise InjectedCleanupCrash(boundary)
            def injected_os_rmdir(name, *args, **kwargs):
                real_os_rmdir(name, *args, **kwargs)
                if boundary == "candidate-directory":
                    raise InjectedCleanupCrash(boundary)
            control._unlink_control_file = injected_unlink_control
            os.unlink = injected_os_unlink
            os.rmdir = injected_os_rmdir
            try:
                real_cleanup_activation_protocol(durable_fd, marker_for_helpers)
            except InjectedCleanupCrash:
                faulted = True
            finally:
                control._unlink_control_file = real_unlink_control_file
                os.unlink = real_os_unlink
                os.rmdir = real_os_rmdir

            cleanup_progress = control._read_private_file(
                durable_fd, control.ACTIVATION_CLEANUP_NAME, control.MAX_MARKER_BYTES
            )
            pending = real_activation_attempt_pending(
                durable_fd, marker_for_helpers, fence
            )
            candidate_directory = control._startup_candidate_directory(
                marker_for_helpers
            )
            clean = (
                control._read_control_file(
                    durable_fd,
                    control.ACTIVATION_PERMIT_NAME,
                    control.MAX_MARKER_BYTES,
                    mode=0o444,
                )
                is None
                and control._read_control_file(
                    durable_fd,
                    control.ACTIVATION_RELEASE_NAME,
                    control.MAX_MARKER_BYTES,
                    mode=0o444,
                )
                is None
                and control._read_control_file(
                    durable_fd,
                    control.ACTIVATION_RETRY_NAME,
                    control.MAX_MARKER_BYTES,
                    mode=0o444,
                )
                is None
                and control._read_private_file(
                    durable_fd,
                    control.ACTIVATION_CLEANUP_NAME,
                    control.MAX_MARKER_BYTES,
                )
                is None
                and not os.path.exists(candidate_directory)
            )
            cleanup_faults[boundary] = {
                "faulted": faulted,
                "progressRecorded": (
                    cleanup_progress is not None
                    if boundary != control.ACTIVATION_CLEANUP_NAME
                    else cleanup_progress is None
                ),
                "pending": pending,
                "clean": clean,
            }
        finally:
            os.close(durable_fd)
control.STARTUP_HANDOFF_DIRECTORY = original_handoff_directory
control._sandbox_account = original_sandbox_account
control._cleanup_activation_protocol = original_cleanup_activation_protocol
results["cleanup_faults"] = cleanup_faults

activation_events = []
class FakeActivationGuard:
    def disarm(self):
        activation_events.append(["guard-disarm"])
    def fail_closed(self):
        activation_events.append(["guard-hold"])
control._activation_attempt_pending = lambda _fd, _marker, _fence: False
control._start_activation_guard = lambda _fence, _mount, _lock=None, transport_broker_required=False: (
    activation_events.append(["guard-start", transport_broker_required]) or FakeActivationGuard()
)
control._assert_exact_process_fence = lambda *_args: activation_events.append(["assert-fence"])
control._signal_reference = lambda reference, requested: activation_events.append(
    ["signal", reference.pid, requested]
)
live_activation = control.ActivationProof(
    gateway.pid,
    gateway.start_identity,
    1000,
    activation.configuration_generation,
    activation.listener_identity,
    activation.health_sha256,
    activation.startup_checkpoint_sha256,
    activation.persistent_pids,
    (control._process_reference(gateway),),
)
control._publish_activation_permit = lambda _fd, _marker, _fence: activation_events.append(["permit"])
control._wait_for_startup_checkpoint = lambda _marker, _fence: (
    activation_events.append(["checkpoint"]) or activation.startup_checkpoint_sha256
)
control._wait_for_activation = lambda _marker, _fence, _checkpoint: activation_events.append(["wait-gateway"]) or live_activation
control._freeze_activation = lambda _marker, _fence, _proof: activation_events.append(["freeze-tree"]) or activation
control._verify_activation_checkpoint = lambda _marker, _fence, _proof: activation_events.append(["verify-checkpoint"])
control._cleanup_activation_protocol = lambda _fd, _marker: activation_events.append(["protocol-cleanup"])
with tempfile.TemporaryDirectory() as root:
    durable_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        real_activate_exact(durable_fd, marker_for_helpers, fence)
        results["activation_events"] = list(activation_events)
        activation_events.clear()
        control._wait_for_activation = lambda _marker, _fence, _checkpoint: control._fail("activation-timeout")
        control._hold_exact_processes = lambda *_args: activation_events.append(["restore-hold"])
        results["activation_failure"] = code(
            lambda: real_activate_exact(durable_fd, marker_for_helpers, fence)
        )
        results["activation_failure_events"] = list(activation_events)

        activation_events.clear()
        control._activation_attempt_pending = lambda _fd, _marker, _fence: True
        control._hold_exact_processes = lambda *_args: activation_events.append(["restore-hold"])
        control._reset_activation_attempt = lambda _fd, _marker, _fence: activation_events.append(["retry-exec-ack"])
        control._wait_for_activation = lambda _marker, _fence, _checkpoint: activation_events.append(["wait-gateway"]) or live_activation
        real_activate_exact(durable_fd, marker_for_helpers, fence)
        results["activation_retry_events"] = list(activation_events)
    finally:
        os.close(durable_fd)

network_events = []
network_state = {"identity": "net:[401]"}
current_namespace_path = os.path.join(control.PROC_ROOT, "self", "ns", "net")
target_namespace_path = os.path.join(control.PROC_ROOT, str(gateway.pid), "ns", "net")
current_namespace_fd = 901
target_namespace_fd = 902
real_os_open = control.os.open
real_os_close = control.os.close
real_os_readlink = control.os.readlink
had_os_setns = hasattr(control.os, "setns")
real_os_setns = getattr(control.os, "setns", None)
real_http_connection = control.http.client.HTTPConnection
previous_recapture_reference = control._recapture_reference

def fake_namespace_open(path, flags):
    network_events.append(["open", path])
    if path == current_namespace_path:
        return current_namespace_fd
    if path == target_namespace_path:
        return target_namespace_fd
    raise AssertionError(path)

def fake_namespace_close(descriptor):
    network_events.append(["close", descriptor])

def fake_namespace_readlink(path):
    if path == current_namespace_path:
        return network_state["identity"]
    if path == target_namespace_path:
        return "net:[402]"
    raise AssertionError(path)

def fake_setns(descriptor, namespace_type):
    network_events.append(["setns", descriptor, namespace_type])
    if descriptor == target_namespace_fd:
        network_state["identity"] = "net:[402]"
    elif descriptor == current_namespace_fd:
        network_state["identity"] = "net:[401]"
    else:
        raise AssertionError(descriptor)

class FakeHealthResponse:
    status = 200
    def read(self, maximum):
        network_events.append(["read-health", maximum, network_state["identity"]])
        return b"{}"
    def close(self):
        network_events.append(["close-health-response"])

class FakeHealthConnection:
    def __init__(self, host, port, timeout):
        network_events.append(["connect", host, port, timeout, network_state["identity"]])
    def request(self, method, path):
        network_events.append(["request", method, path])
    def getresponse(self):
        return FakeHealthResponse()
    def close(self):
        network_events.append(["close-health-connection"])

try:
    control.os.open = fake_namespace_open
    control.os.close = fake_namespace_close
    control.os.readlink = fake_namespace_readlink
    control.os.setns = fake_setns
    control.http.client.HTTPConnection = FakeHealthConnection
    control._recapture_reference = lambda _reference, _code="fenced-process-drift": gateway
    results["network_namespace_health"] = {
        "status": real_health_status(gateway),
        "finalNamespace": network_state["identity"],
        "events": list(network_events),
    }
finally:
    control.os.open = real_os_open
    control.os.close = real_os_close
    control.os.readlink = real_os_readlink
    if had_os_setns:
        control.os.setns = real_os_setns
    else:
        del control.os.setns
    control.http.client.HTTPConnection = real_http_connection
    control._recapture_reference = previous_recapture_reference

control._configuration_generation = lambda: activation.configuration_generation
control._listener_identity = lambda _process: activation.listener_identity
control._health_status = lambda _process: 200
control._recapture_reference = lambda _reference, _code="fenced-process-drift": gateway
live_proof = control._prove_live_activation(
    marker_for_helpers,
    fence,
    gateway,
    checkpoint_sha256=activation.startup_checkpoint_sha256,
)
results["live_proof"] = {
    "service": live_proof.service_pid,
    "generation": live_proof.configuration_generation,
    "listener": live_proof.listener_identity,
    "health": live_proof.health_sha256,
    "checkpoint": live_proof.startup_checkpoint_sha256,
}

with tempfile.TemporaryDirectory() as root:
    runtime_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        real_publish_activation_receipt(runtime_fd, marker_for_helpers)
        results["activation_receipt"] = code(
            lambda: real_verify_activation_receipt(runtime_fd, marker_for_helpers)
        )
        control._atomic_write(runtime_fd, control.ACTIVATION_RECEIPT_NAME, b"{}\n")
        results["activation_receipt_tamper"] = code(
            lambda: real_verify_activation_receipt(runtime_fd, marker_for_helpers)
        )
    finally:
        os.close(runtime_fd)

release_states = {1: "T", 10: "T", 75: "T", 76: "T", 77: "T", 78: "T"}
release_events = []
release_ack_exists = {"value": False}
control._read_startup_release_ack = lambda *_args: (
    {"acknowledged": True} if release_ack_exists["value"] else None
)
def wait_for_startup_release_ack(*_args):
    release_events.append(["release-ack"])
    release_ack_exists["value"] = True
    release_states[10] = "T"
control._wait_for_startup_release_ack = wait_for_startup_release_ack
def state_process(original):
    return control.ProcessIdentity(
        original.pid,
        release_states[original.pid],
        original.parent_pid,
        original.start_identity,
        original.uids,
        original.command,
        original.proc_device,
        original.proc_inode,
        original.executable_device,
        original.executable_inode,
    )
by_release_pid = {
    1: refreshed_pid1,
    10: start,
    75: stdout_drain,
    76: stderr_drain,
    77: gateway,
    78: auxiliary,
}
control._prove_fence_shape = lambda _fence, _mount: (
    state_process(pid1),
    state_process(start),
)
control._recapture_reference = lambda reference, _code="fenced-process-drift": state_process(
    by_release_pid[reference.pid]
)
control._recapture_supervisor = lambda reference: state_process(
    by_release_pid[reference.pid]
)
def resume_reference(reference):
    if release_states[reference.pid] in ("T", "t"):
        release_events.append(["resume", reference.pid])
        release_states[reference.pid] = "S"
    return state_process(by_release_pid[reference.pid])
control._resume_reference = resume_reference
control._prove_released_activation = lambda *_args: release_events.append(["health"])
control._prove_parent_acknowledged_activation = lambda *_args: release_events.append(
    ["parent-ack-health"]
)
control._verify_activation_checkpoint = lambda *_args: release_events.append(["verify-checkpoint"])
control._publish_activation_release = lambda *_args: release_events.append(["release-receipt"])
terminated_release_pids = set()
control._reference_is_terminated = lambda reference: reference.pid in terminated_release_pids
def signal_process(selected, requested):
    release_events.append(["signal", selected.pid, requested])
    if requested == signal.SIGCONT:
        release_states[selected.pid] = "S"
control._signal_exact_process = signal_process
control._wait_for_reference_running = lambda reference: state_process(by_release_pid[reference.pid])
results["release_state_before"] = control._prove_fence_shape(fence, "mnt:[401]")[0].state
with tempfile.TemporaryDirectory() as root:
    durable_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        real_release_activation_hold(durable_fd, marker_for_helpers)
        results["release_events"] = list(release_events)
        release_events.clear()
        real_release_activation_hold(durable_fd, marker_for_helpers)
        results["release_retry_events"] = list(release_events)

        release_events.clear()
        release_states.update({1: "T", 10: "T", 75: "T", 76: "T", 77: "T", 78: "T"})
        release_ack_exists["value"] = False
        terminated_release_pids.add(78)
        real_release_activation_hold(durable_fd, marker_for_helpers)
        results["transient_exit_release_events"] = list(release_events)

        release_events.clear()
        release_states.update({1: "T", 10: "T", 75: "T", 76: "T", 77: "T", 78: "T"})
        release_ack_exists["value"] = False
        terminated_release_pids.clear()
        terminated_release_pids.add(77)
        results["persistent_exit_release"] = code(
            lambda: real_release_activation_hold(durable_fd, marker_for_helpers)
        )
    finally:
        os.close(durable_fd)

with tempfile.TemporaryDirectory() as root:
    mutation_path = os.path.join(root, "writer-mutations")
    held_path = os.path.join(root, "guardian-held")
    lock_path = os.path.join(root, "controller.lock")
    lock_seed_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.close(lock_seed_fd)
    ready_read, ready_write = os.pipe()
    writer_pid = os.fork()
    if writer_pid == 0:
        try:
            os.close(ready_read)
            os.close(ready_write)
            while True:
                fd = os.open(mutation_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                os.write(fd, b"x")
                os.close(fd)
                time.sleep(0.01)
        finally:
            os._exit(0)
    controller_pid = os.fork()
    if controller_pid == 0:
        try:
            os.close(ready_read)
            lock_fd = os.open(lock_path, os.O_RDWR)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            def guardian_hold(_fence, _mount, _activation):
                os.kill(writer_pid, signal.SIGSTOP)
                fd = os.open(held_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.write(fd, b"held")
                os.close(fd)
                time.sleep(0.25)
            control._hold_exact_processes = guardian_hold
            _guard = real_start_activation_guard(fence, "mnt:[401]", lock_fd)
            os.write(ready_write, b"R")
            while True:
                signal.pause()
        finally:
            os._exit(0)
    os.close(ready_write)
    try:
        results["guardian_controller_ready"] = os.read(ready_read, 1) == b"R"
        deadline = time.monotonic() + 2
        while not os.path.exists(mutation_path) and time.monotonic() < deadline:
            time.sleep(0.01)
        os.kill(controller_pid, signal.SIGKILL)
        os.waitpid(controller_pid, 0)
        readable, _writable, _exceptional = select.select([ready_read], [], [], 2)
        results["guardian_client_eof"] = bool(readable) and os.read(ready_read, 1) == b""
        deadline = time.monotonic() + 2
        while not os.path.exists(held_path) and time.monotonic() < deadline:
            time.sleep(0.01)
        results["guardian_held_after_sigkill"] = os.path.exists(held_path)
        contender_fd = os.open(lock_path, os.O_RDWR)
        try:
            try:
                fcntl.flock(contender_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                results["guardian_retains_controller_lock"] = False
            except BlockingIOError:
                results["guardian_retains_controller_lock"] = True
            deadline = time.monotonic() + 2
            while True:
                try:
                    fcntl.flock(contender_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    results["guardian_releases_controller_lock"] = True
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        results["guardian_releases_controller_lock"] = False
                        break
                    time.sleep(0.01)
        finally:
            os.close(contender_fd)
        before = os.path.getsize(mutation_path)
        time.sleep(0.15)
        after = os.path.getsize(mutation_path)
        results["guardian_blocks_mutation"] = before == after
        selected = 0
        status = 0
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            selected, status = os.waitpid(writer_pid, os.WUNTRACED | os.WNOHANG)
            if selected == writer_pid and os.WIFSTOPPED(status):
                break
            time.sleep(0.01)
        results["guardian_writer_stopped"] = selected == writer_pid and os.WIFSTOPPED(status)
    finally:
        os.close(ready_read)
        try:
            os.kill(writer_pid, signal.SIGCONT)
            os.kill(writer_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(writer_pid, 0)
        except ChildProcessError:
            pass

required_broker_hold_events = []
previous_transport_broker_reference = control._transport_broker_reference
previous_hold_exact_processes = control._hold_exact_processes
control._transport_broker_reference = lambda: None
control._hold_exact_processes = lambda *_args: required_broker_hold_events.append(
    "held"
)
try:
    results["required_transport_broker"] = code(
        lambda: real_start_activation_guard(
            fence,
            "mnt:[401]",
            None,
            transport_broker_required=True,
        )
    )
finally:
    control._transport_broker_reference = previous_transport_broker_reference
    control._hold_exact_processes = previous_hold_exact_processes
results["required_transport_broker_hold"] = required_broker_hold_events

with tempfile.TemporaryDirectory() as root:
    mutation_path = os.path.join(root, "broker-writer-mutations")
    heartbeat_path = os.path.join(root, "broker-heartbeat")
    resumed_path = os.path.join(root, "guard-resumed-pids")
    lock_path = os.path.join(root, "broker-controller.lock")
    lock_seed_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.close(lock_seed_fd)
    ready_read, ready_write = os.pipe()
    writer_pid = os.fork()
    if writer_pid == 0:
        try:
            os.close(ready_read)
            os.close(ready_write)
            while True:
                fd = os.open(mutation_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                os.write(fd, b"x")
                os.close(fd)
                time.sleep(0.01)
        finally:
            os._exit(0)
    broker_pid = os.fork()
    if broker_pid == 0:
        try:
            os.close(ready_read)
            os.close(ready_write)
            while True:
                fd = os.open(heartbeat_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                os.write(fd, b"b")
                os.close(fd)
                time.sleep(0.01)
        finally:
            os._exit(0)
    deadline = time.monotonic() + 2
    while (
        not os.path.exists(mutation_path)
        or not os.path.exists(heartbeat_path)
    ) and time.monotonic() < deadline:
        time.sleep(0.01)
    controller_pid = os.fork()
    if controller_pid == 0:
        try:
            os.close(ready_read)
            controller_process_pid = os.getpid()
            lock_fd = os.open(lock_path, os.O_RDWR)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            broker_reference = control._process_reference(
                process(
                    broker_pid,
                    "S",
                    os.getppid(),
                    "broker-start",
                    root_uid,
                    fixed_transport_broker.command,
                    288,
                )
            )
            pidfd_targets = {}
            def broker_guard_pidfd(reference):
                descriptor = os.open(os.devnull, os.O_RDONLY)
                pidfd_targets[descriptor] = reference.pid
                return descriptor
            def broker_guard_controller_pidfd():
                descriptor = os.open(os.devnull, os.O_RDONLY)
                pidfd_targets[descriptor] = controller_process_pid
                return descriptor
            def fail_guardian_hold(_fence, _mount, _activation):
                raise RuntimeError("injected brokered hold failure")
            def stop_brokered_namespace(_pidfds):
                os.kill(writer_pid, signal.SIGSTOP)
                os.kill(broker_pid, signal.SIGSTOP)
                os.kill(controller_process_pid, signal.SIGSTOP)
            def resume_brokered_process(pidfd):
                selected_pid = pidfd_targets[pidfd]
                fd = os.open(resumed_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                os.write(fd, (str(selected_pid) + "\n").encode("ascii"))
                os.close(fd)
                os.kill(selected_pid, signal.SIGCONT)
            control._transport_broker_reference = lambda: broker_reference
            control._open_activation_guard_pidfd = broker_guard_pidfd
            control._open_activation_guard_current_pidfd = broker_guard_controller_pidfd
            control._hold_exact_processes = fail_guardian_hold
            control._stop_pid_namespace_fail_closed = stop_brokered_namespace
            control._resume_activation_guard_pidfd = resume_brokered_process
            guard = real_start_activation_guard(
                fence,
                "mnt:[401]",
                lock_fd,
                transport_broker_required=True,
            )
            guard.fail_closed()
            os.write(ready_write, b"R")
        finally:
            os._exit(0)
    os.close(ready_write)
    controller_waited = False
    try:
        readable, _writable, _exceptional = select.select([ready_read], [], [], 2)
        results["broker_guard_response"] = (
            bool(readable) and os.read(ready_read, 1) == b"R"
        )
        os.waitpid(controller_pid, 0)
        controller_waited = True
        with open(resumed_path, "r", encoding="ascii") as stream:
            resumed_pids = [int(value, 10) for value in stream.read().splitlines()]
        results["broker_guard_resumed_broker"] = broker_pid in resumed_pids
        results["broker_guard_resumed_controller"] = controller_pid in resumed_pids
        results["broker_guard_resumed_only"] = sorted(set(resumed_pids)) == sorted(
            {broker_pid, controller_pid}
        )
        broker_before = os.path.getsize(heartbeat_path)
        writer_before = os.path.getsize(mutation_path)
        time.sleep(0.15)
        results["broker_guard_broker_running"] = (
            os.path.getsize(heartbeat_path) > broker_before
        )
        results["broker_guard_writer_held"] = (
            os.path.getsize(mutation_path) == writer_before
        )
        selected = 0
        status = 0
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            selected, status = os.waitpid(writer_pid, os.WUNTRACED | os.WNOHANG)
            if selected == writer_pid and os.WIFSTOPPED(status):
                break
            time.sleep(0.01)
        results["broker_guard_writer_stopped"] = (
            selected == writer_pid and os.WIFSTOPPED(status)
        )
    finally:
        os.close(ready_read)
        if not controller_waited:
            try:
                os.kill(controller_pid, signal.SIGCONT)
                os.kill(controller_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(controller_pid, 0)
            except ChildProcessError:
                pass
        for selected_pid in (writer_pid, broker_pid):
            try:
                os.kill(selected_pid, signal.SIGCONT)
                os.kill(selected_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(selected_pid, 0)
            except ChildProcessError:
                pass

with tempfile.TemporaryDirectory() as root:
    mutation_path = os.path.join(root, "last-resort-writer-mutations")
    parked_path = os.path.join(root, "last-resort-parked")
    enumeration_path = os.path.join(root, "last-resort-enumeration")
    guardian_pid_path = os.path.join(root, "last-resort-guardian-pid")
    lock_path = os.path.join(root, "last-resort-controller.lock")
    lock_seed_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    os.close(lock_seed_fd)
    ready_read, ready_write = os.pipe()
    writer_pid = os.fork()
    if writer_pid == 0:
        try:
            os.close(ready_read)
            os.close(ready_write)
            while True:
                fd = os.open(mutation_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                os.write(fd, b"x")
                os.close(fd)
                time.sleep(0.01)
        finally:
            os._exit(0)
    controller_pid = os.fork()
    if controller_pid == 0:
        try:
            os.close(ready_read)
            lock_fd = os.open(lock_path, os.O_RDWR)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            def failed_guardian_hold(_fence, _mount, _activation):
                raise RuntimeError("injected hold failure")
            enumeration_calls = [0]
            def last_resort_pids():
                enumeration_calls[0] += 1
                fd = os.open(
                    enumeration_path,
                    os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                    0o600,
                )
                if enumeration_calls[0] % 2:
                    os.write(fd, b"E")
                    os.close(fd)
                    raise OSError("injected procfs failure")
                os.write(fd, b"0")
                os.close(fd)
                return ()
            def last_resort_broadcast():
                try:
                    fd = os.open(
                        parked_path,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                    )
                except FileExistsError:
                    pass
                else:
                    os.write(fd, b"parked")
                    os.close(fd)
                os.kill(writer_pid, signal.SIGSTOP)
            control._hold_exact_processes = failed_guardian_hold
            control._pid_namespace_process_ids = last_resort_pids
            control._kernel_pid_namespace_stop = last_resort_broadcast
            guard = real_start_activation_guard(fence, "mnt:[401]", lock_fd)
            fd = os.open(guardian_pid_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.write(fd, str(guard.pid).encode("ascii"))
            os.close(fd)
            os.write(ready_write, b"R")
            while True:
                signal.pause()
        finally:
            os._exit(0)
    os.close(ready_write)
    guardian_pid = None
    try:
        results["last_resort_controller_ready"] = os.read(ready_read, 1) == b"R"
        deadline = time.monotonic() + 2
        while (
            not os.path.exists(mutation_path)
            or not os.path.exists(guardian_pid_path)
        ) and time.monotonic() < deadline:
            time.sleep(0.01)
        with open(guardian_pid_path, "r", encoding="ascii") as stream:
            guardian_pid = int(stream.read(), 10)
        os.kill(controller_pid, signal.SIGKILL)
        os.waitpid(controller_pid, 0)
        readable, _writable, _exceptional = select.select([ready_read], [], [], 2)
        results["last_resort_client_eof"] = bool(readable) and os.read(ready_read, 1) == b""
        deadline = time.monotonic() + 2
        while not os.path.exists(parked_path) and time.monotonic() < deadline:
            time.sleep(0.01)
        selected = 0
        status = 0
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            selected, status = os.waitpid(writer_pid, os.WUNTRACED | os.WNOHANG)
            if selected == writer_pid and os.WIFSTOPPED(status):
                break
            time.sleep(0.01)
        results["last_resort_writer_stopped"] = (
            selected == writer_pid and os.WIFSTOPPED(status)
        )
        contender_fd = os.open(lock_path, os.O_RDWR)
        try:
            try:
                fcntl.flock(contender_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                results["last_resort_retains_controller_lock"] = False
            except BlockingIOError:
                results["last_resort_retains_controller_lock"] = True
            before = os.path.getsize(mutation_path)
            time.sleep(0.15)
            after = os.path.getsize(mutation_path)
            results["last_resort_blocks_mutation"] = before == after
            with open(enumeration_path, "rb") as stream:
                enumeration_evidence = stream.read()
            results["last_resort_procfs_independent"] = (
                b"E" in enumeration_evidence and b"0" in enumeration_evidence
            )
            os.kill(guardian_pid, signal.SIGKILL)
            deadline = time.monotonic() + 2
            while True:
                try:
                    fcntl.flock(contender_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    results["last_resort_external_recovery"] = True
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        results["last_resort_external_recovery"] = False
                        break
                    time.sleep(0.01)
        finally:
            os.close(contender_fd)
    finally:
        os.close(ready_read)
        if guardian_pid is not None:
            try:
                os.kill(guardian_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.kill(writer_pid, signal.SIGCONT)
            os.kill(writer_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(writer_pid, 0)
        except ChildProcessError:
            pass

with tempfile.TemporaryDirectory() as root:
    retry_script = os.path.join(root, "exact-retry.sh")
    retry_ready = os.path.join(root, "retry-ready")
    retry_ack = os.path.join(root, "retry-exec-ack")
    retry_trap = os.path.join(root, "retry-trap")
    retry_state = os.path.join(root, "retry-state")
    dollar = "$"
    with open(retry_script, "w", encoding="utf-8") as stream:
        stream.write(
            "#!/usr/bin/env bash\n"
            "set -eu\n"
            f"printf '%s\\n' \"{dollar}{{RETRIED:-unset}}\" >>\"{retry_state}\"\n"
            f"if [ \"{dollar}{{RETRIED:-0}}\" = 1 ]; then : >\"{retry_ack}\"; kill -STOP \"$$\"; while :; do sleep 1; done; fi\n"
            f"trap ': >\"{retry_trap}\"; export RETRIED=1; exec \"$0\"' USR2\n"
            f": >\"{retry_ready}\"\n"
            "kill -STOP \"$$\"\n"
            "while :; do sleep 1; done\n"
        )
    os.chmod(retry_script, 0o700)
    retry_process = subprocess.Popen(
        [retry_script],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    def process_start_token(pid):
        proc_stat = f"/proc/{pid}/stat"
        if os.path.exists(proc_stat):
            with open(proc_stat, "r", encoding="ascii") as stream:
                return stream.read().rsplit(") ", 1)[1].split()[19]
        return subprocess.check_output(
            ["ps", "-o", "lstart=", "-p", str(pid)], text=True
        ).strip()
    def process_command_token(pid):
        proc_command = f"/proc/{pid}/cmdline"
        if os.path.exists(proc_command):
            with open(proc_command, "rb") as stream:
                return stream.read().hex()
        return subprocess.check_output(
            ["ps", "-o", "command=", "-p", str(pid)], text=True
        ).strip()
    def process_state_token(pid):
        proc_stat = f"/proc/{pid}/stat"
        if os.path.exists(proc_stat):
            with open(proc_stat, "r", encoding="ascii") as stream:
                return stream.read().rsplit(") ", 1)[1].split()[0]
        return subprocess.check_output(
            ["ps", "-o", "state=", "-p", str(pid)], text=True
        ).strip()[:1]
    try:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if os.path.exists(retry_ready) and process_state_token(retry_process.pid) in ("T", "t"):
                break
            time.sleep(0.01)
        results["retry_stopped_before"] = (
            os.path.exists(retry_ready)
            and process_state_token(retry_process.pid) in ("T", "t")
        )
        retry_start_before = process_start_token(retry_process.pid)
        retry_command_before = process_command_token(retry_process.pid)
        os.kill(retry_process.pid, signal.SIGUSR2)
        os.kill(retry_process.pid, signal.SIGCONT)
        deadline = time.monotonic() + 2
        while not os.path.exists(retry_ack) and time.monotonic() < deadline:
            time.sleep(0.01)
        results["retry_trap_seen"] = os.path.exists(retry_trap)
        results["retry_exec_ack"] = os.path.exists(retry_ack)
        with open(retry_state, "r", encoding="utf-8") as stream:
            results["retry_exec_states"] = stream.read()
        results["retry_exec_pid_stable"] = retry_process.poll() is None
        results["retry_exec_start_stable"] = (
            retry_start_before == process_start_token(retry_process.pid)
        )
        results["retry_exec_command_stable"] = (
            retry_command_before == process_command_token(retry_process.pid)
        )
    finally:
        try:
            os.kill(retry_process.pid, signal.SIGCONT)
            os.kill(retry_process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            retry_process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            retry_process.kill()
            retry_process.wait(timeout=2)

class Metadata:
    def __init__(self, device, inode):
        self.st_dev = device
        self.st_ino = inode
        self.st_mode = stat.S_IFDIR | 0o555

real_lstat = os.lstat
real_stat = os.stat
real_readlink = os.readlink
real_proc_root = control.PROC_ROOT
fake_proc = "/trusted-proc"
container_root = Metadata(10, 1)
proc_root = Metadata(20, 2)
pid_root = container_root
metadata = {
    fake_proc: proc_root,
    "/": container_root,
    os.path.join(fake_proc, "1", "root"): pid_root,
    os.path.join(fake_proc, "self", "root"): pid_root,
}
namespaces = {
    os.path.join(fake_proc, "1", "ns", "pid"): "pid:[402]",
    os.path.join(fake_proc, "self", "ns", "pid"): "pid:[402]",
}
try:
    control.PROC_ROOT = fake_proc
    os.lstat = lambda selected: metadata[selected]
    os.stat = lambda selected: metadata[selected]
    os.readlink = lambda selected: namespaces[selected]
    results["private_proc"] = code(real_assert_private_procfs)
    metadata[os.path.join(fake_proc, "1", "root")] = Metadata(99, 1)
    results["host_proc"] = code(real_assert_private_procfs)
    metadata[os.path.join(fake_proc, "1", "root")] = container_root
    namespaces[os.path.join(fake_proc, "self", "ns", "pid")] = "pid:[999]"
    results["foreign_pid_namespace"] = code(real_assert_private_procfs)
finally:
    control.PROC_ROOT = real_proc_root
    os.lstat = real_lstat
    os.stat = real_stat
    os.readlink = real_readlink

print(json.dumps(results, sort_keys=True))
`;
