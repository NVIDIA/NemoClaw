// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const IDENTITY_HARNESS = String.raw`
import importlib.util
import json
import os
import sys
import tempfile

spec = importlib.util.spec_from_file_location("runtime_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)

def write_process(
    proc_root,
    pid,
    start_time,
    cmdline,
    namespace_path,
    effective_uid=0,
    inner_pid=1,
    parent_pid=0,
):
    process_dir = os.path.join(proc_root, str(pid))
    os.makedirs(os.path.join(process_dir, "ns"))
    fields = ["S", str(parent_pid)] + (["0"] * 17) + [str(start_time)]
    with open(os.path.join(process_dir, "stat"), "w", encoding="ascii") as stream:
        stream.write(f"{pid} (nemoclaw) {' '.join(fields)}\n")
    with open(os.path.join(process_dir, "cmdline"), "wb") as stream:
        stream.write(cmdline)
    with open(os.path.join(process_dir, "status"), "w", encoding="ascii") as stream:
        stream.write(
            f"Uid:\t{effective_uid}\t{effective_uid}\t{effective_uid}\t{effective_uid}\n"
            f"NSpid:\t{pid}\t{inner_pid}\n"
        )
    os.link(namespace_path, os.path.join(process_dir, "ns", "pid"))

def scenario(
    processes,
    expected_start="424242",
    expected_namespace="trusted",
    limit=32768,
    mode_selection=False,
):
    with tempfile.TemporaryDirectory() as root:
        proc_root = os.path.join(root, "proc")
        os.mkdir(proc_root)
        namespaces = {}
        for name in {"trusted", "other"}:
            namespace_path = os.path.join(root, name)
            with open(namespace_path, "wb") as stream:
                stream.write(name.encode("ascii"))
            namespaces[name] = namespace_path
        for process in processes:
            pid, start_time, cmdline, namespace, *identity = process
            write_process(
                proc_root,
                pid,
                start_time,
                cmdline,
                namespaces[namespace],
                *identity,
            )
        guard.PROC_ROOT = proc_root
        guard.MAX_PROC_ENTRIES = limit
        if mode_selection:
            guard._startup_markers_absent = lambda identity: True
            return guard.mutable_config_modes(guard.Identity(0, 0, 1000, 1000))
        return guard._startup_process_identity_is_live(
            expected_start,
            os.stat(namespaces[expected_namespace]).st_ino,
        )

def supervised_scenario(
    processes,
    supervisor_cmdline=b"/opt/openshell/bin/openshell-sandbox\0",
    limit=32768,
    required_pid=None,
    namespace_access=True,
    mode_selection=False,
    markers_absent=True,
):
    with tempfile.TemporaryDirectory() as root:
        proc_root = os.path.join(root, "proc")
        os.mkdir(proc_root)
        namespace_path = os.path.join(root, "shared")
        with open(namespace_path, "wb") as stream:
            stream.write(b"shared")
        nested_namespace_path = os.path.join(root, "nested")
        with open(nested_namespace_path, "wb") as stream:
            stream.write(b"nested")
        write_process(
            proc_root,
            1,
            "111111",
            supervisor_cmdline,
            namespace_path,
            effective_uid=0,
            inner_pid=1,
            parent_pid=0,
        )
        for process in processes:
            pid, start_time, cmdline, effective_uid, inner_pid, parent_pid, *namespace = process
            if namespace not in ([], ["nested"]):
                raise AssertionError(f"unsupported namespace selector: {namespace!r}")
            write_process(
                proc_root,
                pid,
                start_time,
                cmdline,
                nested_namespace_path if namespace == ["nested"] else namespace_path,
                effective_uid=effective_uid,
                inner_pid=inner_pid,
                parent_pid=parent_pid,
            )
        guard.PROC_ROOT = proc_root
        guard.MAX_PROC_ENTRIES = limit
        original_namespace_reader = guard._proc_pid_namespace_inode
        if not namespace_access:
            guard._proc_pid_namespace_inode = lambda _proc_pid_fd: None
        elif namespace_access == "child_only":
            supervisor_stat = os.stat(os.path.join(proc_root, "1"))
            def child_only_namespace_reader(proc_pid_fd):
                proc_pid_stat = os.fstat(proc_pid_fd)
                if (
                    proc_pid_stat.st_dev == supervisor_stat.st_dev
                    and proc_pid_stat.st_ino == supervisor_stat.st_ino
                ):
                    return None
                return original_namespace_reader(proc_pid_fd)
            guard._proc_pid_namespace_inode = child_only_namespace_reader
        try:
            if mode_selection:
                guard._startup_markers_absent = lambda identity: markers_absent
                return guard.mutable_config_modes(guard.Identity(0, 0, 1000, 1000))
            return guard._openshell_supervised_nonroot_start_is_live(
                0,
                1000,
                required_pid,
            )
        finally:
            guard._proc_pid_namespace_inode = original_namespace_reader

entrypoint = b"bash\0/usr/local/bin/nemoclaw-start\0"
direct_entrypoint = b"/usr/local/bin/nemoclaw-start\0"
entrypoint_with_command = b"bash\0/usr/local/bin/nemoclaw-start\0true\0"
direct_entrypoint_with_command = b"/usr/local/bin/nemoclaw-start\0true\0"
spoof = b"bash\0/tmp/nemoclaw-start-spoof\0"
argv_spoof = b"python3\0/tmp/evil.py\0/usr/local/bin/nemoclaw-start\0"
noncanonical_bash = b"/tmp/bash\0/usr/local/bin/nemoclaw-start\0"
misplaced_start = b"bash\0/tmp/evil.sh\0/usr/local/bin/nemoclaw-start\0"
empty_argument_spoof = b"bash\0\0/usr/local/bin/nemoclaw-start\0"
proof = {
    "remapped": scenario([(412, "424242", entrypoint, "trusted")]),
    "remapped_command": scenario([(412, "424242", entrypoint_with_command, "trusted")]),
    "stale": scenario([(412, "999999", entrypoint, "trusted")]),
    "spoof": scenario([(412, "424242", spoof, "trusted")]),
    "nonroot": scenario([(412, "424242", entrypoint, "trusted", 1000)]),
    "noninit": scenario([(412, "424242", entrypoint, "trusted", 0, 2)]),
    "wrong_namespace": scenario([(412, "424242", entrypoint, "other")]),
    "duplicate": scenario([
        (412, "424242", entrypoint, "trusted"),
        (413, "424242", entrypoint, "trusted"),
    ]),
    "bounded": scenario([
        (412, "424242", entrypoint, "trusted"),
        (413, "999999", spoof, "other"),
    ], limit=1),
}
proof.update({
    "openshell_supervised": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1),
    ]),
    "openshell_supervised_direct": supervised_scenario([
        (412, "424242", direct_entrypoint, 1000, 412, 1),
    ]),
    "openshell_supervised_command": supervised_scenario([
        (412, "424242", entrypoint_with_command, 1000, 412, 1),
    ]),
    "openshell_supervised_direct_command": supervised_scenario([
        (412, "424242", direct_entrypoint_with_command, 1000, 412, 1),
    ]),
    "openshell_supervisor_with_retained_command": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1),
        (413, "525252", b"bash\0/usr/local/bin/nemoclaw-start\0node\0-e\0retained-probe\0", 1000, 413, 1),
    ]),
    "openshell_supervisor_with_retained_direct_command": supervised_scenario([
        (412, "424242", direct_entrypoint, 1000, 412, 1),
        (413, "525252", b"/usr/local/bin/nemoclaw-start\0node\0-e\0retained-probe\0", 1000, 413, 1),
    ]),
    "openshell_noncanonical_bash": supervised_scenario([
        (412, "424242", noncanonical_bash, 1000, 412, 1),
    ]),
    "openshell_misplaced_start": supervised_scenario([
        (412, "424242", misplaced_start, 1000, 412, 1),
    ]),
    "openshell_empty_argument_spoof": supervised_scenario([
        (412, "424242", empty_argument_spoof, 1000, 412, 1),
    ]),
    "openshell_landlock_all_namespaces_denied": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1),
    ], namespace_access=False),
    "openshell_landlock_supervisor_namespace_denied": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1),
    ], namespace_access="child_only"),
    "openshell_wrong_supervisor": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1),
    ], supervisor_cmdline=b"/usr/bin/foreign-supervisor\0"),
    "openshell_root_child": supervised_scenario([
        (412, "424242", entrypoint, 0, 412, 1),
    ]),
    "openshell_nested_child": supervised_scenario([
        (412, "424242", entrypoint, 1000, 1, 1),
    ]),
    "openshell_nested_pid_namespace": supervised_scenario([
        (412, "424242", entrypoint, 1000, 1, 1, "nested"),
    ]),
    "openshell_cross_namespace_outer_pid": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1, "nested"),
    ]),
    "openshell_nested_landlock_all_namespaces_denied": supervised_scenario([
        (412, "424242", entrypoint, 1000, 1, 1, "nested"),
    ], namespace_access=False),
    "openshell_nested_landlock_supervisor_namespace_denied": supervised_scenario([
        (412, "424242", entrypoint, 1000, 1, 1, "nested"),
    ], namespace_access="child_only"),
    "openshell_non_direct_child": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 77),
    ]),
    "openshell_spoof": supervised_scenario([
        (412, "424242", spoof, 1000, 412, 1),
    ]),
    "openshell_argv_spoof": supervised_scenario([
        (412, "424242", argv_spoof, 1000, 412, 1),
    ]),
    "openshell_nested_argv_spoof": supervised_scenario([
        (412, "424242", argv_spoof, 1000, 1, 1, "nested"),
    ]),
    "openshell_duplicate": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1),
        (413, "525252", entrypoint, 1000, 413, 1),
    ]),
    "openshell_required_child": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1),
    ], required_pid=412),
    "openshell_wrong_required_child": supervised_scenario([
        (412, "424242", entrypoint, 1000, 412, 1),
    ], required_pid=413),
    "openshell_nested_required_child": supervised_scenario([
        (412, "424242", entrypoint, 1000, 1, 1, "nested"),
    ], required_pid=412),
    "openshell_nested_wrong_required_child": supervised_scenario([
        (412, "424242", entrypoint, 1000, 1, 1, "nested"),
    ], required_pid=413),
})
if len(sys.argv) > 2:
    child = (412, "424242", entrypoint, 1000, 412, 1)
    proof = {
        "same_user": supervised_scenario([child], mode_selection=True),
        "root_child": supervised_scenario([
            (412, "424242", entrypoint, 0, 412, 1),
        ], mode_selection=True),
        "root_marker": supervised_scenario([child], mode_selection=True, markers_absent=False),
        "direct_same_user": scenario([(1, "424242", entrypoint, "trusted", 1000)], mode_selection=True),
        "direct_root": scenario([(1, "424242", entrypoint, "trusted", 0)], mode_selection=True),
        "direct_foreign_user": scenario([(1, "424242", entrypoint, "trusted", 1001)], mode_selection=True),
        "direct_spoof": scenario([(1, "424242", spoof, "trusted", 1000)], mode_selection=True),
    }
print(json.dumps(proof))
`;

const GUARDS = [["Hermes", path.resolve("agents/hermes/runtime-config-guard.py")]] as const;

function runIdentityHarness(guardPath: string, ...args: string[]) {
  const result = spawnSync("python3", ["-c", IDENTITY_HARNESS, guardPath, ...args], {
    encoding: "utf-8",
    timeout: 5000,
  });

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe.each(GUARDS)("%s startup process identity", (name, guardPath) => {
  it("authenticates exactly one root namespace init and rejects stale or spoofed identities (#2426)", () => {
    const {
      openshell_argv_spoof: _openshellArgvSpoof,
      openshell_nested_argv_spoof: _openshellNestedArgvSpoof,
      openshell_supervised_command: _openshellSupervisedCommand,
      openshell_supervised_direct_command: _openshellSupervisedDirectCommand,
      openshell_noncanonical_bash: _openshellNoncanonicalBash,
      openshell_misplaced_start: _openshellMisplacedStart,
      openshell_empty_argument_spoof: _openshellEmptyArgumentSpoof,
      ...proof
    } = runIdentityHarness(guardPath);
    expect(proof).toEqual({
      remapped: true,
      remapped_command: true,
      stale: false,
      spoof: false,
      nonroot: false,
      noninit: false,
      wrong_namespace: false,
      duplicate: false,
      bounded: false,
      openshell_supervised: true,
      openshell_supervised_direct: true,
      openshell_supervisor_with_retained_command: false,
      openshell_supervisor_with_retained_direct_command: false,
      openshell_landlock_all_namespaces_denied: true,
      openshell_landlock_supervisor_namespace_denied: true,
      openshell_wrong_supervisor: false,
      openshell_root_child: false,
      openshell_nested_child: false,
      // #6565 reproduces nested PID namespaces only for OpenClaw. Hermes keeps
      // its independently tested same-namespace topology until it has a
      // Hermes-specific reproduction or acceptance requirement.
      openshell_nested_pid_namespace: false,
      openshell_cross_namespace_outer_pid: false,
      openshell_nested_landlock_all_namespaces_denied: false,
      openshell_nested_landlock_supervisor_namespace_denied: false,
      openshell_non_direct_child: false,
      openshell_spoof: false,
      openshell_duplicate: false,
      openshell_required_child: true,
      openshell_wrong_required_child: false,
      openshell_nested_required_child: false,
      openshell_nested_wrong_required_child: false,
    });
  });
});

describe.each(GUARDS)("%s exact startup argv", (name, guardPath) => {
  it("rejects a trusted script path smuggled in an unrelated argv (#6565)", () => {
    const proof = runIdentityHarness(guardPath);

    expect(proof.openshell_argv_spoof).toBe(false);
    expect(proof.openshell_nested_argv_spoof).toBe(false);
    expect(proof.openshell_supervised_command).toBe(name === "Hermes");
    expect(proof.openshell_supervised_direct_command).toBe(name === "Hermes");
    expect(proof.openshell_noncanonical_bash).toBe(false);
    expect(proof.openshell_misplaced_start).toBe(false);
    expect(proof.openshell_empty_argument_spoof).toBe(false);
  });
});

const CAPABILITY_FREE_IDENTITY_HARNESS = String.raw`
import importlib.util
import json
import os
import sys
import tempfile
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
case = sys.argv[2]
driver, separator, variant = case.partition(":")
if separator: case = variant
uid, gid = 998, 999
guard.pwd.getpwnam = lambda _name: SimpleNamespace(pw_uid=uid, pw_gid=gid)
kernel_metadata = None
if case in ("linux-nondumpable", "linux-dumpable"):
    import ctypes
    # This subprocess changes only its own credentials/dumpability, never the
    # test runner or host configuration. Root CI containers use nobody here.
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
    assert os.geteuid() > 0 and os.getegid() > 0
    libc = ctypes.CDLL(None, use_errno=True)
    dumpable = 0 if case == "linux-nondumpable" else 1
    assert libc.prctl(4, dumpable, 0, 0, 0) == 0
    directory = os.stat("/proc/self")
    kernel_metadata = os.stat("/proc/self/status")
    assert (directory.st_uid, directory.st_gid) == (os.geteuid(), os.getegid())
    expected_owner = (0, 0) if dumpable == 0 else (os.geteuid(), os.getegid())
    assert (kernel_metadata.st_uid, kernel_metadata.st_gid) == expected_owner

with tempfile.TemporaryDirectory() as root:
    guard.PROC_ROOT = root
    namespace = os.path.join(root, "namespace")
    with open(namespace, "wb") as stream:
        stream.write(b"fixture")
    argv = [b"/opt/openshell/bin/openshell-sandbox", b"launch-capability-free",
            b"998", b"999", b"/.openshell/channel/sandbox/bootstrap.json", b"/sandbox"]
    if case == "foreign-executable": argv[0] = b"/tmp/openshell-sandbox"
    if case == "foreign-mode": argv[1] = b"--bootstrap"
    if case == "wrong-argv-uid": argv[2] = b"999"
    if case == "wrong-argv-gid": argv[3] = b"998"
    if case == "foreign-bootstrap": argv[4] = b"/tmp/bootstrap.json"
    if case == "foreign-workspace": argv[5] = b"/tmp"
    if case == "extra-argv": argv.append(b"nemoclaw-start")
    if driver in ("docker", "rootful-podman"):
        executable = (b"/.openshell/runtime/openshell-sandbox" if driver == "docker"
                      else b"/opt/openshell/bin/openshell-sandbox")
        argv = [executable, b"--bootstrap", b"/.openshell/channel/sandbox/bootstrap.json"]
        if case == "foreign-bootstrap": argv[2] = b"/tmp/bootstrap.json"
        if case == "extra-argv": argv.append(b"nemoclaw-start")
        if case == "foreign-executable": argv[0] = b"/tmp/openshell-sandbox"
    status = {
        "Uid": "998 998 998 998", "Gid": "999 999 999 999", "Groups": "",
        "NSpid": "1", "NoNewPrivs": "1",
        "CapInh": "0000000000000000", "CapPrm": "0000000000000000",
        "CapEff": "0000000000000000", "CapBnd": "0000000000000000",
        "CapAmb": "0000000000000000",
    }
    if case == "saved-root": status["Uid"] = "998 998 0 998"
    if case == "wrong-uid": status["Uid"] = "999 999 999 999"
    if case == "wrong-gid": status["Gid"] = "998 998 998 998"
    if case == "supplementary-groups": status["Groups"] = "0"
    if case == "can-gain-privileges": status["NoNewPrivs"] = "0"
    if case.startswith("retained-"): status[case.removeprefix("retained-")] = "1"
    if case == "missing-capability": del status["CapEff"]
    if case == "non-init": status["NSpid"] = "2"

    def write_process(pid, parent, command, process_status):
        directory = os.path.join(root, str(pid))
        os.makedirs(os.path.join(directory, "ns"))
        fields = ["S", str(parent)] + ["0"] * 17 + [str(111111 + pid)]
        with open(os.path.join(directory, "stat"), "w") as stream:
            stream.write(str(pid) + " (fixture) " + " ".join(fields))
        with open(os.path.join(directory, "cmdline"), "wb") as stream:
            stream.write(b"\0".join(command) + b"\0")
        with open(os.path.join(directory, "status"), "w") as stream:
            stream.write("".join(key + ":\t" + value + "\n" for key, value in process_status.items()))
            if pid == 1 and case == "duplicate-field": stream.write("CapEff:\t0\n")
        os.link(namespace, os.path.join(directory, "ns", "pid"))
    write_process(1, 2 if case == "foreign-parent" else 0, argv, status)
    child_status = {"Uid": "998 998 998 998", "NSpid": "412"}
    if case == "root-child": child_status["Uid"] = "0 0 0 0"
    child_argv = [b"bash", b"/usr/local/bin/nemoclaw-start"]
    if case == "spoofed-child": child_argv = [b"python3", b"/usr/local/bin/nemoclaw-start"]
    write_process(412, 77 if case == "indirect-child" else 1, child_argv, child_status)
    if case == "duplicate-child":
        write_process(413, 1, child_argv, {"Uid": "998 998 998 998", "NSpid": "413"})
    if case == "missing-child": os.unlink(os.path.join(root, "412", "cmdline"))
    # Model Linux's distinct directory/status ownership on macOS. Linux cases
    # use actual kernel status metadata after toggling this process's dumpability.
    # Parse fixture bytes and exercise identity/uniqueness/parent checks unchanged.
    original_fstat = os.fstat
    original_stat = os.stat
    init_stat = os.stat(os.path.join(root, "1"))
    def fixture_fstat(fd):
        value = original_fstat(fd)
        if (value.st_dev, value.st_ino) == (init_stat.st_dev, init_stat.st_ino):
            return SimpleNamespace(st_dev=value.st_dev, st_ino=value.st_ino,
                                   st_uid=uid, st_gid=gid)
        return value
    metadata_reads = 0
    def fixture_stat(name, *args, **kwargs):
        global metadata_reads
        value = original_stat(name, *args, **kwargs)
        fd = kwargs.get("dir_fd")
        if name == "status" and fd is not None and original_fstat(fd).st_ino == init_stat.st_ino:
            assert kwargs.get("follow_symlinks") is False
            metadata_reads += 1
            dumpable = case == "dumpable-owner" or (case == "raced-owner" and metadata_reads >= 4)
            owner = kernel_metadata or SimpleNamespace(st_uid=uid if dumpable else 0,
                                                      st_gid=gid if dumpable else 0)
            return SimpleNamespace(st_dev=value.st_dev, st_ino=value.st_ino,
                                   st_mode=value.st_mode, st_uid=owner.st_uid, st_gid=owner.st_gid)
        return value
    guard.os.fstat = fixture_fstat
    guard.os.stat = fixture_stat
    if case == "namespace-inaccessible": guard._proc_pid_namespace_inode = lambda _fd: None
    original_read = guard._read_proc_pid_file
    reads = 0
    def read_process(fd, name, display):
        global reads
        value = original_read(fd, name, display)
        if display == root + "/1/status":
            reads += 1
            if ((case == "raced-status" and reads >= 4)
                or (case == "raced-final-status" and reads >= 5)):
                return value.replace(b"NoNewPrivs:\t1", b"NoNewPrivs:\t0")
        return value
    guard._read_proc_pid_file = read_process
    try:
        if case.startswith(("startup-", "host-", "reconciliation-")):
            guard.__file__ = guard.INSTALLED_RUNTIME_CONFIG_GUARD
            guard.HERMES_STARTUP_READY_FILE = os.path.join(root, "ready")
            guard.os.getppid = lambda: 413 if case == "startup-wrong-parent" else 412
            if case.endswith("stale-marker"):
                with open(guard.HERMES_STARTUP_READY_FILE, "w") as stream:
                    stream.write("invalid\n")
            if case.startswith("reconciliation-"):
                accepted = guard._managed_nonroot_reconciliation_is_allowed()
            else:
                try:
                    guard._validate_action_readiness(
                        "ensure-api-key" if case.startswith("startup-") else "seal-restart",
                        case.startswith("startup-") and case != "startup-missing-owner",
                    )
                    accepted = True
                except guard.UnsafePathError:
                    accepted = False
            print(json.dumps(accepted))
        else:
            print(json.dumps(guard._openshell_supervised_nonroot_start_is_live(
                0, uid, 413 if case == "wrong-required-parent" else 412)))
    finally:
        guard.os.fstat = original_fstat
        guard.os.stat = original_stat
`;

describe("Hermes capability-free OpenShell startup identity", () => {
  it.each([
    "valid",
    "namespace-inaccessible",
    "startup-authorized",
    "host-authorized",
    "reconciliation-authorized",
    "docker:valid",
    "docker:startup-authorized",
    "docker:host-authorized",
    "docker:reconciliation-authorized",
    "rootful-podman:valid",
  ])("accepts the pinned boundary: %s", (scenario) => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        CAPABILITY_FREE_IDENTITY_HARNESS,
        path.resolve("agents/hermes/runtime-config-guard.py"),
        scenario,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(true);
  });

  it.each([
    "foreign-executable",
    "foreign-mode",
    "wrong-argv-uid",
    "wrong-argv-gid",
    "foreign-bootstrap",
    "foreign-workspace",
    "extra-argv",
    "saved-root",
    "wrong-uid",
    "wrong-gid",
    "supplementary-groups",
    "can-gain-privileges",
    "retained-CapInh",
    "retained-CapPrm",
    "retained-CapEff",
    "retained-CapBnd",
    "retained-CapAmb",
    "missing-capability",
    "duplicate-field",
    "non-init",
    "foreign-parent",
    "dumpable-owner",
    "raced-owner",
    "root-child",
    "spoofed-child",
    "indirect-child",
    "duplicate-child",
    "missing-child",
    "wrong-required-parent",
    "raced-status",
    "raced-final-status",
    "startup-missing-owner",
    "startup-wrong-parent",
    "startup-stale-marker",
    "host-stale-marker",
    "reconciliation-stale-marker",
    "docker:foreign-executable",
    "docker:foreign-bootstrap",
    "docker:extra-argv",
    "docker:saved-root",
    "docker:retained-CapEff",
    "docker:dumpable-owner",
    "docker:startup-wrong-parent",
    "rootful-podman:extra-argv",
    "rootful-podman:saved-root",
    "rootful-podman:can-gain-privileges",
  ])("rejects an untrusted boundary without mutation: %s", (scenario) => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        CAPABILITY_FREE_IDENTITY_HARNESS,
        path.resolve("agents/hermes/runtime-config-guard.py"),
        scenario,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(false);
  });

  it.runIf(process.platform === "linux").each([
    ["linux-nondumpable", true],
    ["linux-dumpable", false],
  ] as const)("uses actual Linux proc ownership: %s", (scenario, accepted) => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        CAPABILITY_FREE_IDENTITY_HARNESS,
        path.resolve("agents/hermes/runtime-config-guard.py"),
        scenario,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(accepted);
  });
});
