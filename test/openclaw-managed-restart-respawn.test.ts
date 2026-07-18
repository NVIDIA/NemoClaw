// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "..", "scripts", "managed-gateway-control.py");
const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const SUPERVISOR_LIB = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "gateway-supervisor.sh",
);
const NONCE = "a".repeat(64);

// openclaw exits 0 on SIGTERM, so a managed restart is indistinguishable from a
// self-requested shutdown unless the root controller leases the exit. Prove the
// controller publishes that lease for openclaw and that nemoclaw-start relaunches
// a leased exit instead of treating the clean status as an intentional stop.
const RESTART_HARNESS = String.raw`
import importlib.util
import json
import os
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
    fields = ["S", str(parent_pid)] + (["0"] * 15) + ["1", "0", str(start_time)]
    with open(os.path.join(process_root, "stat"), "w", encoding="ascii") as stream:
        stream.write(f"{pid} (managed) {' '.join(fields)}\n")
    with open(os.path.join(process_root, "status"), "w", encoding="ascii") as stream:
        stream.write(f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}\nNSpid:\t{pid}\n")
    with open(os.path.join(process_root, "cmdline"), "wb") as stream:
        stream.write(cmdline)
    with open(os.path.join(process_root, "environ"), "wb") as stream:
        stream.write(environ)
    os.link(namespace_path, os.path.join(process_root, "ns", "pid"))
    if listener_inode is not None:
        os.symlink(f"socket:[{listener_inode}]", os.path.join(process_root, "fd", "7"))

with tempfile.TemporaryDirectory() as root:
    proc_root = os.path.join(root, "proc")
    system_root = os.path.join(root, "system")
    os.makedirs(os.path.join(proc_root, "net"))
    os.makedirs(os.path.join(system_root, "run"))
    os.makedirs(os.path.join(system_root, "usr/local/lib/nemoclaw"))
    namespace_path = os.path.join(root, "pid-namespace")
    with open(namespace_path, "wb") as stream:
        stream.write(b"namespace")
    for table in ("tcp", "tcp6"):
        with open(os.path.join(proc_root, "net", table), "w", encoding="ascii") as stream:
            stream.write(
                "sl local_address rem_address st tx_queue rx_queue tr tm->when"
                " retrnsmt uid timeout inode\n"
            )
    with open(os.path.join(proc_root, "net", "tcp"), "a", encoding="ascii") as stream:
        stream.write("0: 0100007F:4965 00000000:0000 0A 0:0 00:0 0 1000 0 77777\n")

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
        # \x00 takes exactly two hex digits, so the port stays a separate argv
        # entry; \0 before a digit would parse as an octal escape instead.
        b"/usr/local/bin/openclaw\x00gateway\x00run\x00--port\x0018789\x00",
        listener_inode="77777",
    )
    controller_pid = os.getpid()
    write_process(
        proc_root,
        namespace_path,
        controller_pid,
        "777",
        1,
        os.geteuid(),
        b"python3\0-I\0/usr/local/lib/nemoclaw/managed-gateway-control.py\0restart\0"
        + (b"a" * 64)
        + b"\0",
    )

    # openclaw is the detected agent, and its preflight must not gate the lease.
    control._detect_agent = lambda: "openclaw"
    control._openclaw_preflight = lambda: None
    control._sandbox_uid = lambda: 1000
    control._http_healthy_in_gateway_namespace = lambda _reader, _identity, port, path: True
    os.environ["NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST"] = "1"
    os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = system_root
    os.environ["NEMOCLAW_MANAGED_CONTROL_PROC_ROOT"] = proc_root

    lease_path = os.path.join(system_root, "run/nemoclaw", control.EXPECTED_EXIT_MARKER_NAME)
    observed = {"lease_live_during_terminate": False, "payload": None}

    def fake_terminate(_reader, identity):
        # The entrypoint reads the lease while the controller waits, so it must
        # exist and name this exact gateway at signal time — not after the wait.
        observed["lease_live_during_terminate"] = os.path.exists(lease_path)
        if observed["lease_live_during_terminate"]:
            with open(lease_path, "r", encoding="ascii") as stream:
                version, pid, start_time, controller, _controller_start = stream.read().split()
            observed["payload"] = [version, int(pid), start_time, int(controller)]

    def fake_wait(_reader, _supervisor, _spec, old, _timeout=0, _aux=False):
        return replace(old, pid=43, start_time="555", namespace_pid=43)

    control._terminate_gateway = fake_terminate
    control._wait_for_healthy_gateway = fake_wait

    result, old_pid, new_pid = control._control("restart", "a" * 64)
    print(json.dumps({
        "result": result,
        "old_pid": old_pid,
        "new_pid": new_pid,
        "lease_live_during_terminate": observed["lease_live_during_terminate"],
        "payload": observed["payload"],
        "controller_pid": controller_pid,
        "lease_cleared_after_wait": not os.path.exists(lease_path),
    }))
`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunction(source: string, name: string, origin: string): string {
  const match = source.match(new RegExp(`${escapeRegExp(name)}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  assert(match, `Expected ${name} in ${origin}`);
  return `${name}() {${match[1]}\n}`;
}

// Run the entrypoint's real respawn guards rather than a copy of them, so the
// test exercises the shipped decision. nemoclaw-start.sh carries the guard in
// both the bootstrap loop and the top-level loop; each must respawn a leased
// exit, so every occurrence is exercised. Missing markers are a wiring error,
// not a behavior expectation, so resolve or throw rather than assert on source.
function extractRespawnGuards(source: string): string[] {
  const guards = (
    source.match(/^[ \t]*if \[ "\$RC" -eq 0 \] \\\n(?:[^\n]*\n){4}[ \t]*fi$/gm) ?? []
  ).map((guard) =>
    guard
      .split("\n")
      .map((line) => line.trim())
      .join("\n"),
  );
  assert.equal(guards.length, 2, "Expected both openclaw respawn guards in nemoclaw-start.sh");
  return guards;
}

function runBash(lines: string[]): { status: number | null; stdout: string; stderr: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-respawn-"));
  const script = path.join(directory, "run.sh");
  fs.writeFileSync(script, ["#!/usr/bin/env bash", "set -uo pipefail", ...lines].join("\n"), {
    mode: 0o700,
  });
  try {
    const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("openclaw managed restart respawn (#6868)", () => {
  it("leases the gateway exit before terminating so the entrypoint respawns it", () => {
    const result = spawnSync("python3", ["-c", RESTART_HARNESS, HELPER], {
      encoding: "utf-8",
      timeout: 30000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    // Before #6868 the lease was published only when spec.name === "hermes", so
    // openclaw's SIGTERM exit read as an intentional stop and never respawned.
    expect(observed.lease_live_during_terminate).toBe(true);
    expect(observed.payload).toEqual(["v1", 41, "333", observed.controller_pid]);
    expect(observed.result).toBe("ok");
    expect(observed.old_pid).toBe(41);
    expect(observed.new_pid).toBe(43);
    // The lease authorizes exactly one exit; it must not outlive the wait.
    expect(observed.lease_cleared_after_wait).toBe(true);
  });

  it("respawns a clean gateway exit that the root controller leased", () => {
    const guards = extractRespawnGuards(fs.readFileSync(START_SCRIPT, "utf-8"));
    const outcome = (guard: string, authorized: boolean, watchdogKilled = false) =>
      runBash([
        `consume_gateway_watchdog_kill() { return ${watchdogKilled ? 0 : 1}; }`,
        `gateway_control_exit_was_host_authorized() { return ${authorized ? 0 : 1}; }`,
        "RC=0",
        "EXITED_GATEWAY_PID=41",
        "EXITED_GATEWAY_START_IDENTITY=333",
        guard,
        'printf "respawned\\n"',
      ]).stdout;
    for (const guard of guards) {
      // A leased exit is a host-requested restart: relaunch it.
      expect(outcome(guard, true)).toContain("respawned");
      // An unleased clean exit is still an intentional shutdown: stop.
      expect(outcome(guard, false)).not.toContain("respawned");
      // The watchdog's own kill must keep respawning independently of the lease.
      expect(outcome(guard, false, true)).toContain("respawned");
    }
  });

  it("accepts only a lease for the exact gateway and a live root controller", () => {
    const supervisor = fs.readFileSync(SUPERVISOR_LIB, "utf-8");
    const check = (
      options: {
        payloadPid?: string;
        markerKind?: "regular" | "missing" | "symlink";
        includeController?: boolean;
        controllerStart?: string;
        controllerState?: string;
        controllerUids?: string;
        controllerAction?: string;
      } = {},
    ) => {
      const {
        payloadPid = "4242",
        markerKind = "regular",
        includeController = true,
        controllerStart = "888",
        controllerState = "S",
        controllerUids = "0\t0\t0\t0",
        controllerAction = "restart",
      } = options;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lease-"));
      const leaseDir = path.join(directory, "run", "nemoclaw");
      fs.mkdirSync(leaseDir, { recursive: true, mode: 0o711 });
      const marker = path.join(leaseDir, "managed-gateway-expected-exit");
      const markerWriters = {
        regular: () => fs.writeFileSync(marker, `v1 ${payloadPid} 333 7331 888\n`, { mode: 0o444 }),
        missing: () => undefined,
        symlink: () => {
          const attackerMarker = path.join(directory, "attacker-marker");
          fs.writeFileSync(attackerMarker, `v1 ${payloadPid} 333 7331 888\n`, { mode: 0o444 });
          fs.symlinkSync(attackerMarker, marker);
        },
      } satisfies Record<"regular" | "missing" | "symlink", () => unknown>;
      markerWriters[markerKind]();
      const procRoot = path.join(directory, "proc");
      const controllerRoot = path.join(procRoot, "7331");
      const writeController = includeController
        ? () => {
            fs.mkdirSync(controllerRoot, { recursive: true });
            fs.writeFileSync(
              path.join(controllerRoot, "stat"),
              `7331 (python3) ${[controllerState, "1", ...Array(17).fill("0"), controllerStart].join(" ")}\n`,
            );
            fs.writeFileSync(
              path.join(controllerRoot, "status"),
              `Uid:\t${controllerUids}\nNSpid:\t7331\n`,
            );
            fs.writeFileSync(
              path.join(controllerRoot, "cmdline"),
              `python3\0-I\0/usr/local/lib/nemoclaw/managed-gateway-control.py\0${controllerAction}\0${NONCE}\0`,
            );
          }
        : () => undefined;
      writeController();
      try {
        return runBash([
          'stat() { case "$3" in "$NEMOCLAW_MANAGED_EXPECTED_EXIT_DIR") printf "0:0 711\\n" ;; *) printf "0:0 444 1\\n" ;; esac; }',
          extractShellFunction(supervisor, "gateway_control_proc_root", SUPERVISOR_LIB),
          extractShellFunction(supervisor, "gateway_control_proc_root_is_explicit", SUPERVISOR_LIB),
          extractShellFunction(supervisor, "gateway_control_pid_start_identity", SUPERVISOR_LIB),
          extractShellFunction(supervisor, "gateway_control_pid_state", SUPERVISOR_LIB),
          extractShellFunction(
            supervisor,
            "gateway_control_managed_controller_argv_is_expected",
            SUPERVISOR_LIB,
          ),
          extractShellFunction(
            supervisor,
            "gateway_control_managed_controller_is_live",
            SUPERVISOR_LIB,
          ),
          extractShellFunction(
            supervisor,
            "gateway_control_exit_was_host_authorized",
            SUPERVISOR_LIB,
          ),
          `_NEMOCLAW_PROC_ROOT=${JSON.stringify(procRoot)}`,
          `NEMOCLAW_MANAGED_EXPECTED_EXIT_DIR=${JSON.stringify(leaseDir)}`,
          'NEMOCLAW_MANAGED_EXPECTED_EXIT_MARKER="managed-gateway-expected-exit"',
          'NEMOCLAW_MANAGED_CONTROLLER_PATH="/usr/local/lib/nemoclaw/managed-gateway-control.py"',
          'if gateway_control_exit_was_host_authorized 4242 333; then printf "authorized\\n"; else printf "refused\\n"; fi',
        ]).stdout;
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    };
    expect(check()).toContain("authorized");
    // A lease naming a different pid must never authorize this exit.
    expect(check({ payloadPid: "4243" })).toContain("refused");
    // Missing, linked, orphaned, replaced, non-root, or unexpected controllers
    // must all fail closed as ordinary gateway exits.
    expect(check({ markerKind: "missing" })).toContain("refused");
    expect(check({ markerKind: "symlink" })).toContain("refused");
    expect(check({ includeController: false })).toContain("refused");
    expect(check({ controllerStart: "889" })).toContain("refused");
    expect(check({ controllerState: "Z" })).toContain("refused");
    expect(check({ controllerUids: "1000\t1000\t1000\t1000" })).toContain("refused");
    expect(check({ controllerAction: "probe" })).toContain("refused");
  });
});
