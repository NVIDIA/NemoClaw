// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  stopHostGatewayProcesses,
  type HostGatewayProcessDeps,
  type RunResult,
} from "./host-gateway-process";

interface RunArgs {
  args: string[];
  command: string;
}

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

function makeRun(responses: Map<string, RunResult | ((args: string[]) => RunResult)>): {
  calls: RunArgs[];
  run: HostGatewayProcessDeps["run"];
} {
  const calls: RunArgs[] = [];
  const run: HostGatewayProcessDeps["run"] = (command, args) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    const exact = responses.get(key);
    if (exact !== undefined) {
      return typeof exact === "function" ? exact(args) : exact;
    }
    if (command === "pgrep") return notFound();
    if (command === "ps") return notFound();
    return ok();
  };
  return { calls, run };
}

function psResponses(
  pid: number,
  opts: {
    cmdline?: string;
    exited: Set<number>;
    owner?: string;
  },
): [string, RunResult | ((args: string[]) => RunResult)][] {
  return [
    [`ps -p ${pid} -o pid=`, () => (opts.exited.has(pid) ? notFound() : ok(`${pid}\n`))],
    [`ps -p ${pid} -o user=`, ok(`${opts.owner ?? "tester"}\n`)],
    [
      `ps -p ${pid} -o args=`,
      ok(opts.cmdline ?? `/home/test/.local/bin/openshell-gateway --port 8080\n`),
    ],
  ];
}

describe("stopHostGatewayProcesses", () => {
  it("uses pgrep fallback when the Docker-driver gateway PID file is missing", () => {
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["pgrep -f ^(/[^ ]*/)?openshell-gateway( |$)", ok("9999887\n")],
      ...psResponses(9999887, { exited }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
      if (signal === "SIGTERM") exited.add(pid);
      return true;
    });
    const log = vi.fn();

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log },
      { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")) },
    );

    expect(result.stopped).toEqual([9999887]);
    expect(kill).toHaveBeenCalledWith(9999887, "SIGTERM");
    expect(log).toHaveBeenCalledWith("Stopped host openshell-gateway process 9999887");
  });

  it("accepts the docker-compat parent PID whose argv0 is docker", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999551\n");
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["pgrep -f ^(/[^ ]*/)?openshell-gateway( |$)", notFound()],
      ...psResponses(9999551, {
        cmdline:
          "/usr/bin/docker run --rm --name nemoclaw-openshell-gateway --network host /opt/nemoclaw/openshell-gateway\n",
        exited,
      }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
      if (signal === "SIGTERM") exited.add(pid);
      return true;
    });

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir },
    );

    expect(result.stopped).toEqual([9999551]);
    expect(kill).toHaveBeenCalledWith(9999551, "SIGTERM");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("rejects a PID whose argv0 is not docker even if it touches the mount path", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999662\n");
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["pgrep -f ^(/[^ ]*/)?openshell-gateway( |$)", notFound()],
      ...psResponses(9999662, {
        cmdline: "/usr/bin/vim /opt/nemoclaw/openshell-gateway\n",
        exited: new Set(),
      }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>(() => true);

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir },
    );

    expect(result.skippedNonMatchingPids).toEqual([9999662]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("warns instead of claiming success when pgrep is unavailable", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const { run } = makeRun(new Map());
    const warn = vi.fn();
    const log = vi.fn();

    const result = stopHostGatewayProcesses(
      {
        run,
        kill: () => true,
        env: { USER: "tester" },
        commandExists: (cmd) => cmd !== "pgrep",
        warn,
        log,
      },
      { logNoProcesses: true, stateDir },
    );

    expect(result.stopped).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "pgrep not found; could not scan for orphan host openshell-gateway processes. " +
        "If port 8080 is still bound, run: sudo pkill -f openshell-gateway",
    );
    expect(log).not.toHaveBeenCalledWith("No host openshell-gateway processes found");
  });

  it("ignores unrelated command lines that merely mention openshell-gateway", () => {
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["pgrep -f ^(/[^ ]*/)?openshell-gateway( |$)", ok("9999111\n9999222\n")],
      ...psResponses(9999111, { exited }),
      ...psResponses(9999222, {
        cmdline: "node /home/test/.npm-global/bin/codex issue text mentions openshell-gateway\n",
        exited,
      }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
      if (pid === 9999111 && signal === "SIGTERM") exited.add(pid);
      return true;
    });

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")) },
    );

    expect(result.stopped).toEqual([9999111]);
    expect(result.skippedNonMatchingPids).toEqual([9999222]);
    expect(kill).not.toHaveBeenCalledWith(9999222, expect.anything());
  });

  it("prints sudo remediation when a privileged host gateway cannot be killed", () => {
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["pgrep -f ^(/[^ ]*/)?openshell-gateway( |$)", ok("9999042\n")],
      ...psResponses(9999042, { exited: new Set(), owner: "root" }),
    ]);
    const { run } = makeRun(responses);
    const warn = vi.fn();

    const result = stopHostGatewayProcesses(
      {
        run,
        kill: () => false,
        env: { USER: "tester" },
        commandExists: () => true,
        warn,
      },
      {
        killWaitMs: 0,
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")),
        termWaitMs: 0,
      },
    );

    expect(result.failed).toEqual([9999042]);
    expect(result.sudoRemediationPids).toEqual([9999042]);
    expect(warn).toHaveBeenCalledWith(
      "Cannot stop root-owned host openshell-gateway process 9999042. Run: sudo pkill -f openshell-gateway",
    );
  });

  it("skips pgrep sweep when explicit PIDs are passed (drift restart)", () => {
    // Use a PID above the Linux kernel pid_max default (4194304) so that the
    // production code's `/proc/<pid>/cmdline` probe always misses and the
    // mocked `ps -o args=` response wins. Without this guard a real process
    // happening to hold the chosen PID on a busy CI runner makes the
    // cmdline-matcher reject the candidate and the test flakes.
    const driftPid = 9999777;
    const exited = new Set<number>();
    const pgrepCalls: string[][] = [];
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ...psResponses(driftPid, { exited }),
    ]);
    const { run } = makeRun(responses);
    // Wrap run so we can detect any pgrep invocation: pgrep MUST NOT run when
    // an explicit drift PID is supplied.
    const tracedRun: HostGatewayProcessDeps["run"] = (command, args) => {
      if (command === "pgrep") pgrepCalls.push(args);
      return run(command, args);
    };
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
      if (signal === "SIGTERM") exited.add(pid);
      return true;
    });

    const result = stopHostGatewayProcesses(
      { run: tracedRun, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      {
        pids: [driftPid],
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")),
      },
    );

    expect(result.stopped).toEqual([driftPid]);
    expect(pgrepCalls).toEqual([]);
  });

  it("clears stale PID files and still scans for orphaned host gateways", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999123\n");
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["pgrep -f ^(/[^ ]*/)?openshell-gateway( |$)", ok("9999456\n")],
      ...(psResponses(9999123, { exited: new Set() }).map(([key, value]) =>
        key === "ps -p 9999123 -o pid=" ? [key, notFound()] : [key, value],
      ) as [string, RunResult | ((args: string[]) => RunResult)][]),
      ...psResponses(9999456, { exited }),
    ]);
    const { run } = makeRun(responses);
    const kill: HostGatewayProcessDeps["kill"] = (pid, signal) => {
      if (pid === 9999456 && signal === "SIGTERM") exited.add(pid);
      return true;
    };

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir },
    );

    expect(result.skippedDeadPids).toEqual([9999123]);
    expect(result.stopped).toEqual([9999456]);
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
