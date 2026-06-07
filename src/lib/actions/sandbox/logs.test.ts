// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { LogProbeResult } from "../../domain/sandbox/logs";
import { showSandboxLogsWithDeps } from "./logs";

vi.mock("../../runner", () => ({ ROOT: process.cwd() }));

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

type CapturedLogsRun = {
  calls: { args: string[]; options: Record<string, unknown> }[];
  errors: string[];
  exitCode: number | null;
  spawns: { command: string; args: string[]; options: Record<string, unknown> }[];
  stdout: string;
};

type SandboxLogsDeps = NonNullable<Parameters<typeof showSandboxLogsWithDeps>[2]>;
type SpawnFn = NonNullable<SandboxLogsDeps["spawn"]>;

function createExitedChild(): ReturnType<SpawnFn> {
  const child = new EventEmitter() as ReturnType<SpawnFn>;
  Object.assign(child, {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  const originalOn = child.on.bind(child);
  child.on = ((eventName: string, listener: (...args: unknown[]) => void) => {
    originalOn(eventName, listener);
    if (eventName === "exit") {
      listener(0, null);
    }
    return child;
  }) as typeof child.on;
  return child;
}

function restoreProcessSignalListeners(
  signal: NodeJS.Signals,
  before: NodeJS.SignalsListener[],
): void {
  for (const listener of process.listeners(signal)) {
    if (!before.includes(listener as NodeJS.SignalsListener)) {
      process.removeListener(signal, listener);
    }
  }
}

function captureLogsRun(
  options: Parameters<typeof showSandboxLogsWithDeps>[1],
  results: Record<string, LogProbeResult>,
  overrides: Partial<Parameters<typeof showSandboxLogsWithDeps>[2]> = {},
): CapturedLogsRun {
  const calls: CapturedLogsRun["calls"] = [];
  const spawns: CapturedLogsRun["spawns"] = [];
  const stdout: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  const sigintListeners = process.listeners("SIGINT") as NodeJS.SignalsListener[];
  const sigtermListeners = process.listeners("SIGTERM") as NodeJS.SignalsListener[];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });

  const runOpenshell = vi.fn((args: string[], callOptions = {}) => {
    calls.push({ args, options: callOptions as Record<string, unknown> });
    return results[args[0]] ?? { status: 0 };
  });
  const spawn = ((command: string, args: readonly string[], callOptions = {}) => {
    spawns.push({
      command,
      args: [...args],
      options: callOptions as Record<string, unknown>,
    });
    return createExitedChild();
  }) as unknown as SpawnFn;

  try {
    showSandboxLogsWithDeps("alpha", options, {
      exit: (code) => {
        exitCode = code;
        throw new ExitError(code);
      },
      isDockerRuntimeDown: () => false,
      getOpenshellBinary: () => "openshell",
      runOpenshell,
      spawn,
      writeStdout: (chunk) => stdout.push(chunk),
      ...overrides,
    });
  } catch (error) {
    if (!(error instanceof ExitError)) throw error;
  } finally {
    errorSpy.mockRestore();
    restoreProcessSignalListeners("SIGINT", sigintListeners);
    restoreProcessSignalListeners("SIGTERM", sigtermListeners);
  }

  return { calls, errors, exitCode, spawns, stdout: stdout.join("") };
}

describe("showSandboxLogsWithDeps", () => {
  it("enables audit logs, reads both log sources, and writes merged output", () => {
    const result = captureLogsRun(
      { follow: false, lines: "50", since: null },
      {
        settings: { status: 0 },
        sandbox: { status: 0, stdout: "[1] gateway\n" },
        logs: { status: 0, stdout: "[2] openshell\n" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[1] gateway\n[2] openshell\n");
    expect(result.calls.map((call) => call.args)).toEqual([
      ["settings", "set", "alpha", "--key", "ocsf_json_enabled", "--value", "true"],
      ["sandbox", "exec", "-n", "alpha", "--", "tail", "-n", "50", "/tmp/gateway.log"],
      ["logs", "alpha", "-n", "50", "--source", "all"],
    ]);
  });

  it("skips the OpenClaw gateway tail when --since targets OpenShell logs", () => {
    const result = captureLogsRun(
      { follow: false, lines: "200", since: "5m" },
      {
        settings: { status: 0 },
        logs: { status: 0, stdout: "[3] openshell only\n" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[3] openshell only\n");
    expect(result.calls.map((call) => call.args)).toEqual([
      ["settings", "set", "alpha", "--key", "ocsf_json_enabled", "--value", "true"],
      ["logs", "alpha", "-n", "200", "--source", "all", "--since", "5m"],
    ]);
  });

  it("streams follow logs with the requested tail count", () => {
    const result = captureLogsRun(
      { follow: true, lines: "50", since: null },
      {
        settings: { status: 0 },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call.args)).toEqual([
      ["settings", "set", "alpha", "--key", "ocsf_json_enabled", "--value", "true"],
    ]);
    expect(result.spawns.map((call) => call.command)).toEqual(["openshell", "openshell"]);
    expect(result.spawns.map((call) => call.args)).toEqual([
      ["sandbox", "exec", "-n", "alpha", "--", "tail", "-n", "50", "-f", "/tmp/gateway.log"],
      ["logs", "alpha", "-n", "50", "--source", "all", "--tail"],
    ]);
  });

  it("streams follow logs with --since through OpenShell without an unfiltered gateway tail", () => {
    const result = captureLogsRun(
      { follow: true, lines: "200", since: "5m" },
      {
        settings: { status: 0 },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call.args)).toEqual([
      ["settings", "set", "alpha", "--key", "ocsf_json_enabled", "--value", "true"],
    ]);
    expect(result.spawns.map((call) => call.args)).toEqual([
      ["logs", "alpha", "-n", "200", "--source", "all", "--since", "5m", "--tail"],
    ]);
  });

  it("warns about degraded audit and OpenClaw sources while continuing to OpenShell logs", () => {
    const timeout = new Error("spawn openshell ETIMEDOUT");
    const result = captureLogsRun(
      { follow: false, lines: "200", since: null },
      {
        settings: { status: 7, stderr: "settings unavailable\n" },
        sandbox: { status: null, error: timeout },
        logs: { status: 0, stdout: "[4] openshell fallback\n" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[4] openshell fallback\n");
    expect(result.errors.join("\n")).toContain(
      "failed to enable OpenShell audit logs for sandbox 'alpha' (exit 7)",
    );
    expect(result.errors.join("\n")).toContain("settings unavailable");
    expect(result.errors.join("\n")).toContain("Policy denial events may be missing");
    expect(result.errors.join("\n")).toContain(
      "OpenClaw log source unavailable (spawn openshell ETIMEDOUT)",
    );
  });

  it("prints Docker outage guidance and exits before OpenShell log probes", () => {
    const guidance = vi.fn();
    const result = captureLogsRun(
      { follow: false, lines: "200", since: null },
      {},
      {
        isDockerRuntimeDown: () => true,
        printDockerRuntimeDownGuidance: guidance,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(guidance).toHaveBeenCalledWith("alpha", { retryCommand: "logs" });
    expect(result.calls).toEqual([]);
  });
});
