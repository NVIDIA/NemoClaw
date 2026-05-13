// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getProtectedDashboardPortsForSandbox,
  stopStaleDashboardListeners,
  type RunResult,
  type StaleGatewayDeps,
} from "./stale-gateway-cleanup";

interface RunArgs {
  command: string;
  args: string[];
}

function emptyResult(): RunResult {
  return { status: 0, stdout: "", stderr: "" };
}

function makeRun(
  responses: Map<string, RunResult | ((args: string[]) => RunResult)>,
): {
  run: StaleGatewayDeps["run"];
  calls: RunArgs[];
} {
  const calls: RunArgs[] = [];
  const run: StaleGatewayDeps["run"] = (command, args) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    const exact = responses.get(key);
    if (exact !== undefined) {
      return typeof exact === "function" ? exact(args) : exact;
    }
    // Default lsof to empty (no listener) and ps to non-existent pid.
    if (command === "lsof") return { status: 1, stdout: "", stderr: "" };
    if (command === "ps") return { status: 1, stdout: "", stderr: "" };
    return emptyResult();
  };
  return { run, calls };
}

function baseDeps(overrides: Partial<StaleGatewayDeps> = {}): StaleGatewayDeps {
  return {
    run: overrides.run ?? (() => emptyResult()),
    kill: overrides.kill ?? vi.fn(() => true),
    env: overrides.env ?? { USER: "tester" },
    log: overrides.log ?? vi.fn(),
    warn: overrides.warn ?? vi.fn(),
    commandExists: overrides.commandExists ?? (() => true),
  };
}

describe("stopStaleDashboardListeners", () => {
  it("protects registered sandbox dashboard ports except the fresh target", () => {
    expect(
      getProtectedDashboardPortsForSandbox(
        [
          { name: "my-assistant", dashboardPort: 18789 },
          { name: "other", dashboardPort: 18790 },
          { name: "missing" },
        ],
        "my-assistant",
      ),
    ).toEqual([18790]);
  });

  it("returns without scanning when lsof is missing", () => {
    const run = vi.fn(() => emptyResult());
    const result = stopStaleDashboardListeners({
      ...baseDeps({ commandExists: () => false }),
      run,
    });
    expect(result).toEqual({ stopped: [], skippedForeignPids: [], skippedNonMatchingPids: [], skippedProtectedPorts: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns no work when lsof reports no listeners across the range", () => {
    const { run } = makeRun(new Map());
    const result = stopStaleDashboardListeners(baseDeps({ run }));
    expect(result).toEqual({ stopped: [], skippedForeignPids: [], skippedNonMatchingPids: [], skippedProtectedPorts: [] });
  });

  it("kills a user-owned openclaw-gateway process holding the dashboard port", () => {
    const kill = vi.fn<(pid: number, signal?: NodeJS.Signals | number) => boolean>(() => true);
    let pidGone = false;
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["lsof -ti :18789 -sTCP:LISTEN", { status: 0, stdout: "2522044\n", stderr: "" }],
      [
        "ps -p 2522044 -o user=",
        { status: 0, stdout: "tester\n", stderr: "" },
      ],
      [
        "ps -p 2522044 -o args=",
        { status: 0, stdout: "openclaw-gateway --port 18789\n", stderr: "" },
      ],
      [
        "ps -p 2522044 -o pid=",
        () => (pidGone ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: "2522044\n", stderr: "" }),
      ],
    ]);
    const { run } = makeRun(responses);
    const customKill: StaleGatewayDeps["kill"] = (pid, signal) => {
      kill(pid, signal);
      if (signal === "SIGTERM") pidGone = true;
      return true;
    };
    const log = vi.fn();
    const result = stopStaleDashboardListeners({
      ...baseDeps({ run, kill: customKill, log }),
    });
    expect(result.stopped).toEqual([2522044]);
    expect(kill).toHaveBeenCalledWith(2522044, "SIGTERM");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Stopped stale dashboard gateway listener 2522044"));
  });

  it("escalates to SIGKILL when SIGTERM does not free the process", () => {
    const sentSignals: NodeJS.Signals[] = [];
    let pidGone = false;
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["lsof -ti :18789 -sTCP:LISTEN", { status: 0, stdout: "999\n", stderr: "" }],
      ["ps -p 999 -o user=", { status: 0, stdout: "tester\n", stderr: "" }],
      [
        "ps -p 999 -o args=",
        { status: 0, stdout: "openclaw-gateway\n", stderr: "" },
      ],
      [
        "ps -p 999 -o pid=",
        () => (pidGone ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: "999\n", stderr: "" }),
      ],
    ]);
    const { run } = makeRun(responses);
    const kill: StaleGatewayDeps["kill"] = (_pid, signal) => {
      sentSignals.push(signal as NodeJS.Signals);
      if (signal === "SIGKILL") pidGone = true;
      return true;
    };
    const result = stopStaleDashboardListeners({
      ...baseDeps({ run, kill }),
    });
    expect(result.stopped).toEqual([999]);
    expect(sentSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("skips PIDs owned by another user", () => {
    const kill = vi.fn(() => true);
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["lsof -ti :18789 -sTCP:LISTEN", { status: 0, stdout: "42\n", stderr: "" }],
      ["ps -p 42 -o user=", { status: 0, stdout: "root\n", stderr: "" }],
    ]);
    const { run } = makeRun(responses);
    const result = stopStaleDashboardListeners({
      ...baseDeps({ run, kill, env: { USER: "tester" } }),
    });
    expect(result).toEqual({ stopped: [], skippedForeignPids: [42], skippedNonMatchingPids: [], skippedProtectedPorts: [] });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not kill listeners on ports protected by registered sandboxes (#3260)", () => {
    const kill = vi.fn(() => true);
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["lsof -ti :18789 -sTCP:LISTEN", { status: 0, stdout: "4242\n", stderr: "" }],
    ]);
    const { run, calls } = makeRun(responses);
    const result = stopStaleDashboardListeners(
      { ...baseDeps({ run, kill }) },
      { protectedPorts: [18789] },
    );
    expect(result.stopped).toEqual([]);
    expect(result.skippedProtectedPorts).toEqual([18789]);
    expect(kill).not.toHaveBeenCalled();
    expect(calls.some((c) => c.command === "ps" && c.args.includes("user="))).toBe(false);
    expect(calls.some((c) => c.command === "ps" && c.args.includes("args="))).toBe(false);
  });

  it("does not revisit a PID seen on a protected port when it also appears on an unprotected port", () => {
    const kill = vi.fn(() => true);
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["lsof -ti :18789 -sTCP:LISTEN", { status: 0, stdout: "777\n", stderr: "" }],
      ["lsof -ti :18790 -sTCP:LISTEN", { status: 0, stdout: "777\n", stderr: "" }],
    ]);
    const { run } = makeRun(responses);
    const result = stopStaleDashboardListeners(
      { ...baseDeps({ run, kill }) },
      { protectedPorts: [18789] },
    );
    expect(result.stopped).toEqual([]);
    expect(result.skippedProtectedPorts).toEqual([18789]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("skips PIDs whose cmdline does not match a gateway marker", () => {
    const kill = vi.fn(() => true);
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["lsof -ti :18789 -sTCP:LISTEN", { status: 0, stdout: "777\n", stderr: "" }],
      ["ps -p 777 -o user=", { status: 0, stdout: "tester\n", stderr: "" }],
      ["ps -p 777 -o args=", { status: 0, stdout: "python -m http.server 18789\n", stderr: "" }],
    ]);
    const { run } = makeRun(responses);
    const result = stopStaleDashboardListeners({
      ...baseDeps({ run, kill }),
    });
    expect(result).toEqual({ stopped: [], skippedForeignPids: [], skippedNonMatchingPids: [777], skippedProtectedPorts: [] });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not double-process a PID that appears on multiple ports in the range", () => {
    let pidGone = false;
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ["lsof -ti :18789 -sTCP:LISTEN", { status: 0, stdout: "501\n", stderr: "" }],
      ["lsof -ti :18790 -sTCP:LISTEN", { status: 0, stdout: "501\n", stderr: "" }],
      ["ps -p 501 -o user=", { status: 0, stdout: "tester\n", stderr: "" }],
      ["ps -p 501 -o args=", { status: 0, stdout: "openclaw-gateway\n", stderr: "" }],
      [
        "ps -p 501 -o pid=",
        () => (pidGone ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: "501\n", stderr: "" }),
      ],
    ]);
    const { run, calls } = makeRun(responses);
    const kill: StaleGatewayDeps["kill"] = (_pid, signal) => {
      if (signal === "SIGTERM") pidGone = true;
      return true;
    };
    const result = stopStaleDashboardListeners({
      ...baseDeps({ run, kill }),
    });
    expect(result.stopped).toEqual([501]);
    // user=/args= lookup must run exactly once per unique PID even when seen twice.
    expect(
      calls.filter(
        (c) =>
          c.command === "ps" && c.args[0] === "-p" && c.args[1] === "501" && c.args[3] === "user=",
      ),
    ).toHaveLength(1);
  });
});
