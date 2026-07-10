// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

const OPENROUTER_RUNTIME_ADAPTER_CMDLINE =
  "/usr/bin/node /home/test/NemoClaw/dist/lib/inference/openrouter-runtime-adapter-entry.js\n";

type RunStub = (args: readonly string[]) => RunResult | null;

function psStub(pidStr: string, opts: { exited: Set<number>; cmdline?: string; owner?: string }) {
  const pid = Number(pidStr);
  const responses = new Map<string, () => RunResult>([
    [
      ["-p", pidStr, "-o", "pid="].join("\0"),
      () => (opts.exited.has(pid) ? notFound() : ok(`${pidStr}\n`)),
    ],
    [["-p", pidStr, "-o", "user="].join("\0"), () => ok(`${opts.owner ?? "testuser"}\n`)],
    [
      ["-p", pidStr, "-o", "args="].join("\0"),
      () => ok(opts.cmdline ?? OPENROUTER_RUNTIME_ADAPTER_CMDLINE),
    ],
  ]);

  return (args: readonly string[]): RunResult | null => {
    return responses.get(args.join("\0"))?.() ?? null;
  };
}

function defaultRun(command: string, args: readonly string[]): RunResult {
  switch (command) {
    case "lsof":
      return ok("");
    default:
      switch (args[0]) {
        case "-c":
          return ok("/fake/bin/tool\n");
        case "-f":
          return ok("");
        default:
          return ok();
      }
  }
}

function runStub(routes: Record<string, RunStub> = {}) {
  return (command: string, args: readonly string[]): RunResult => {
    return routes[command]?.(args) ?? defaultRun(command, args);
  };
}

function lsofPortStub(ports: string[], portPids: Map<string, RunResult>) {
  return (args: readonly string[]): RunResult => {
    const port = args[1] ?? "";
    ports.push(port);
    return portPids.get(port) ?? ok("");
  };
}

describe("OpenRouter Runtime adapter uninstall cleanup", () => {
  it("kills the adapter via the persisted PID file (#5826)", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    const tmpHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-uninstall-test-openrouter-pidfile-"),
    );
    const pidFile = path.join(tmpHome, ".nemoclaw", "openrouter-runtime-adapter.pid");
    fs.mkdirSync(path.join(tmpHome, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(pidFile, "44323\n");

    try {
      const stub = psStub("44323", { exited });
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
          existsSync: (target) => target === pidFile,
          isTty: false,
          kill: (pid, _signal) => {
            killed.push(pid);
            exited.add(pid);
            return true;
          },
          log: (line) => logs.push(line),
          rmSync: vi.fn(),
          run: runStub({ ps: stub }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(killed).toContain(44323);
      expect(logs).toContain("Stopped OpenRouter Runtime adapter 44323");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("scans the custom adapter port for orphan adapters (#5826)", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    const lsofPorts: string[] = [];
    const stub = psStub("33334", { exited });
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-openrouter-custom-port",
          LOGNAME: "testuser",
          NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT: "12037",
        } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: (pid, _signal) => {
          killed.push(pid);
          exited.add(pid);
          return true;
        },
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: runStub({
          lsof: lsofPortStub(lsofPorts, new Map([[":12037", ok("33334\n")]])),
          ps: stub,
        }),
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(lsofPorts).toContain(":12037");
    expect(lsofPorts).not.toContain(":11437");
    expect(killed).toContain(33334);
    expect(logs).toContain("Stopped OpenRouter Runtime adapter 33334");
  });

  it("never kills a process on the adapter port whose cmdline does not match (#5826)", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const stub = psStub("99998", {
      exited: new Set(),
      cmdline: "/usr/sbin/nginx -g daemon off;\n",
    });
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-openrouter-foreign",
          LOGNAME: "testuser",
        } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: (pid) => {
          killed.push(pid);
          return true;
        },
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: runStub({
          lsof: lsofPortStub([], new Map([[":11437", ok("99998\n")]])),
          ps: stub,
        }),
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(killed).not.toContain(99998);
    expect(logs).toContain("No OpenRouter Runtime adapter processes found");
  });
});
