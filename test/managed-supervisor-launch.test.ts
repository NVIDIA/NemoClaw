// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "..", "scripts", "managed-gateway-control.py");
const NONCE = "a".repeat(64);

const SUPERVISOR_LAUNCH_ENV_HARNESS = String.raw`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("managed_control_launch", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

os.environ.update({
    "LD_PRELOAD": "/attacker/preload.so",
    "NODE_OPTIONS": "--require=/attacker/hook.js",
    "NEMOCLAW_TEST_ESCAPE": "attacker",
    "NVIDIA_INFERENCE_API_KEY": "container-owned-placeholder",
})
action, nonce, runtime = control._validate_request([
    "launch-supervisor",
    "a" * 64,
    "CHAT_UI_URL=http://127.0.0.1:18789",
    "NEMOCLAW_DASHBOARD_PORT=18789",
    "HTTPS_PROXY=https://proxy.example/path?token=a=b",
])
environment = control._supervisor_launch_environment(runtime)
print(json.dumps({
    "action": action,
    "nonce": nonce,
    "runtime": runtime,
    "identity": {
        key: environment.get(key)
        for key in ("HOME", "LOGNAME", "PATH", "SHELL", "USER")
    },
    "python_no_user_site": environment.get("PYTHONNOUSERSITE"),
    "stripped": {
        key: key in environment
        for key in ("LD_PRELOAD", "NODE_OPTIONS", "NEMOCLAW_TEST_ESCAPE")
    },
    "container_environment": environment.get("NVIDIA_INFERENCE_API_KEY"),
}, sort_keys=True))
`;

const SUPERVISOR_ADOPTION_HARNESS = String.raw`
import importlib.util
import json
import os
import sys
import tempfile

spec = importlib.util.spec_from_file_location("managed_control_adoption", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

def write_process(proc_root, namespace_path, pid, start_time, parent_pid, uid, cmdline):
    process_root = os.path.join(proc_root, str(pid))
    os.makedirs(os.path.join(process_root, "ns"))
    fields = ["S", str(parent_pid)] + (["0"] * 15) + ["1", "0", str(start_time)]
    with open(os.path.join(process_root, "stat"), "w", encoding="ascii") as stream:
        stream.write(f"{pid} (managed) {' '.join(fields)}\n")
    with open(os.path.join(process_root, "status"), "w", encoding="ascii") as stream:
        stream.write(f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}\nNSpid:\t{pid}\n")
    with open(os.path.join(process_root, "cmdline"), "wb") as stream:
        stream.write(cmdline)
    os.link(namespace_path, os.path.join(process_root, "ns", "pid"))

def run_case(supervisor_parent_pid):
    with tempfile.TemporaryDirectory() as root:
        proc_root = os.path.join(root, "proc")
        system_root = os.path.join(root, "system")
        os.makedirs(proc_root)
        os.makedirs(os.path.join(system_root, "run"))
        namespace_path = os.path.join(root, "pid-namespace")
        with open(namespace_path, "wb") as stream:
            stream.write(b"namespace")
        write_process(
            proc_root,
            namespace_path,
            1,
            111,
            0,
            0,
            b"/opt/openshell/bin/openshell-sandbox\0--managed\0",
        )

        os.environ["NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST"] = "1"
        os.environ["NEMOCLAW_MANAGED_CONTROL_PROC_ROOT"] = proc_root
        os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = system_root
        control._detect_agent = lambda: "openclaw"
        control._validate_trusted_regular = lambda _path: None
        control._sandbox_uid = lambda: 1000

        read_fd, write_fd = os.pipe()
        spawned_pidfd = [-1]
        signals = []
        clock = [0.0]

        def spawn_supervisor(_environment):
            write_process(
                proc_root,
                namespace_path,
                42,
                222,
                supervisor_parent_pid,
                1000,
                b"bash\0/usr/local/bin/nemoclaw-start\0",
            )
            spawned_pidfd[0] = os.dup(read_fd)
            return 42, spawned_pidfd[0]

        def send_pidfd(pidfd, signum):
            os.fstat(pidfd)
            signals.append({
                "signum": int(signum),
                "used_spawned_pidfd": pidfd == spawned_pidfd[0],
            })
            return True

        control._spawn_supervisor_as_orphan = spawn_supervisor
        control._send_pidfd = send_pidfd
        control.SUPERVISOR_LAUNCH_PROOF_SECONDS = 0.4
        control.time.monotonic = lambda: clock[0]
        control.time.sleep = lambda seconds: clock.__setitem__(0, clock[0] + seconds)

        result = None
        error = None
        try:
            result = control._launch_managed_supervisor({})
        except control.ControlError as caught:
            error = caught.code

        try:
            os.fstat(spawned_pidfd[0])
            pidfd_closed = False
        except OSError:
            pidfd_closed = True
        os.close(read_fd)
        os.close(write_fd)
        return {
            "result": result,
            "error": error,
            "signals": signals,
            "pidfd_closed": pidfd_closed,
        }

print(json.dumps({
    "adopted": run_case(1),
    "not_adopted": run_case(2),
}, sort_keys=True))
`;

function runSupervisorAdoptionHarness() {
  const result = spawnSync("python3", ["-c", SUPERVISOR_ADOPTION_HARNESS, HELPER], {
    encoding: "utf-8",
    timeout: 5000,
  });

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("managed supervisor launch", () => {
  it("allowlists launch inputs and strips loader hooks before sandbox UID launch", () => {
    const result = spawnSync("python3", ["-c", SUPERVISOR_LAUNCH_ENV_HARNESS, HELPER], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "launch-supervisor",
      nonce: NONCE,
      runtime: {
        CHAT_UI_URL: "http://127.0.0.1:18789",
        HTTPS_PROXY: "https://proxy.example/path?token=a=b",
        NEMOCLAW_DASHBOARD_PORT: "18789",
      },
      identity: {
        HOME: "/sandbox",
        LOGNAME: "sandbox",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        SHELL: "/bin/bash",
        USER: "sandbox",
      },
      python_no_user_site: "1",
      stripped: {
        LD_PRELOAD: false,
        NEMOCLAW_TEST_ESCAPE: false,
        NODE_OPTIONS: false,
      },
      container_environment: "container-owned-placeholder",
    });
  });

  it.each([
    [["launch-supervisor", NONCE, "UNREVIEWED=value"], "SUPERVISOR_INVALID_REQUEST"],
    [
      [
        "launch-supervisor",
        NONCE,
        "CHAT_UI_URL=http://127.0.0.1:18789",
        "CHAT_UI_URL=http://127.0.0.1:18790",
      ],
      "SUPERVISOR_INVALID_REQUEST",
    ],
    [["restart", NONCE, "CHAT_UI_URL=http://127.0.0.1:18789"], "SUPERVISOR_INVALID_REQUEST"],
  ])("rejects disallowed or duplicate request arguments before privilege use", (args, marker) => {
    const result = spawnSync("python3", [HELPER, ...args], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(marker);
  });

  it("accepts the spawned supervisor after stable OpenShell PID 1 adopts it", () => {
    const observed = runSupervisorAdoptionHarness();

    expect(observed.adopted).toEqual({
      result: 42,
      error: null,
      signals: [],
      pidfd_closed: true,
    });
  });

  it("terminates the pidfd-pinned child when OpenShell does not adopt it", () => {
    const observed = runSupervisorAdoptionHarness();

    expect(observed.not_adopted).toEqual({
      result: null,
      error: "SUPERVISOR_UNAVAILABLE",
      signals: [{ signum: 9, used_spawned_pidfd: true }],
      pidfd_closed: true,
    });
  });
});
