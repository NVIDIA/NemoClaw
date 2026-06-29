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
):
    process_root = os.path.join(proc_root, str(pid))
    os.makedirs(os.path.join(process_root, "ns"))
    os.makedirs(os.path.join(process_root, "fd"))
    os.symlink("../net", os.path.join(process_root, "net"))
    fields = ["S", str(parent_pid)] + (["0"] * 17) + [str(start_time)]
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

    control._sandbox_uid = lambda: 1000
    control._http_healthy_in_gateway_namespace = (
        lambda _reader, _identity, port, path: port == 18642 and path == "/health"
    )
    os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = system_root
    boundary_path = os.path.join(
        system_root,
        "usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
    )
    with open(boundary_path, "w", encoding="utf-8") as stream:
        stream.write("# trusted validator fixture\n")
    os.chmod(boundary_path, 0o755)

    with control.ProcReader(proc_root) as reader:
        supervisor = control._discover_supervisor(reader)
        hermes = control.AgentSpec("hermes", 18642)
        candidates = control._gateway_candidates(reader, supervisor, hermes)
        initial_proof = {
            "supervisor": [supervisor.pid, supervisor.start_time, supervisor.parent_pid],
            "gateway": [candidates[0].pid, candidates[0].start_time, candidates[0].parent_pid],
            "healthy": control._gateway_healthy(reader, candidates[0], hermes),
        }
        state_key_behavior = [
            replace(candidates[0], state="R").stable_key()
            == candidates[0].stable_key(),
            replace(candidates[0], state="Z").stable_key()
            == candidates[0].stable_key(),
        ]
        mixed_namespace_rejected = not control._gateway_matches(
            candidates[0], replace(supervisor, namespace_inode=None), hermes
        )

        real_namespace_inode = control._namespace_inode
        control._namespace_inode = lambda _pid_fd: None
        try:
            namespace_denied_supervisor = control._discover_supervisor(reader)
            namespace_denied = len(
                control._gateway_candidates(reader, namespace_denied_supervisor, hermes)
            ) == 1
        finally:
            control._namespace_inode = real_namespace_inode

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

        expected_gateway = candidates[0]
        sent = []
        real_pidfd_open = control._pidfd_open
        real_pidfd_exited = control._pidfd_exited
        real_send = control._send_pidfd
        read_fd, write_fd = os.pipe()
        try:
            control._pidfd_open = lambda _pid: os.dup(read_fd)
            exit_checks = iter((False, True))
            control._pidfd_exited = lambda _pidfd, _timeout: next(exit_checks)
            control._send_pidfd = lambda _pidfd, signum: sent.append(int(signum))
            control._terminate_gateway(reader, expected_gateway)

            with open(os.path.join(proc_root, "41", "stat"), "w", encoding="ascii") as stream:
                fields = ["S", "40"] + (["0"] * 17) + ["999"]
                stream.write(f"41 (managed) {' '.join(fields)}\n")
            try:
                control._terminate_gateway(reader, expected_gateway)
                reused = "signalled"
            except control.ControlError as error:
                reused = error.code
        finally:
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
    def replace_gateway(_reader, identity):
        assert identity.pid == 41
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
    control._terminate_gateway = replace_gateway
    try:
        restarted = control._control("restart", "a" * 64)
        recovered = control._control("recover", "b" * 64)
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
    finally:
        control._terminate_gateway = real_terminate
        control._proc_root = real_proc_root

    os.environ["NEMOCLAW_MANAGED_CONTROL_PROC_ROOT"] = "/attacker/proc"
    os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = "/attacker/root"
    source_proc = control._proc_root()
    source_system = control._system_root()
    control.__file__ = control.INSTALLED_HELPER_PATH
    installed_proc = control._proc_root()
    installed_system = control._system_root()

    print(json.dumps({
        "initial": initial_proof,
        "state_key_behavior": state_key_behavior,
        "mixed_namespace_rejected": mixed_namespace_rejected,
        "namespace_denied": namespace_denied,
        "preflight": preflight_steps,
        "runtime_validation": runtime_validation,
        "duplicate": duplicate,
        "signals": sent,
        "reused": reused,
        "restarted": restarted,
        "recovered": recovered,
        "transient_retry": [retried_pid, len(health_attempts)],
        "source_seams": [source_proc, source_system],
        "installed_seams": [installed_proc, installed_system],
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
        supervisor: [40, "222", 1],
        gateway: [41, "333", 40],
        healthy: true,
      },
      state_key_behavior: [true, false],
      mixed_namespace_rejected: true,
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
      runtime_validation: "in-process",
      duplicate: "SUPERVISOR_UNAVAILABLE",
      signals: [15, 9],
      reused: "SUPERVISOR_UNAVAILABLE",
      restarted: ["ok", 41, 43],
      recovered: ["already-running", 43, 43],
      transient_retry: [43, 2],
      source_seams: ["/attacker/proc", "/attacker/root"],
      installed_seams: ["/proc", "/"],
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
