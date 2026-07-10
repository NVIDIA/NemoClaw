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

function psStub(pidStr: string, opts: { exited: Set<number>; cmdline?: string; owner?: string }) {
  return (args: readonly string[]): RunResult | null => {
    if (args[0] !== "-p" || args[1] !== pidStr || args[2] !== "-o") return null;
    const pid = Number(pidStr);
    if (args[3] === "pid=") {
      return opts.exited.has(pid) ? notFound() : ok(`${pidStr}\n`);
    }
    if (args[3] === "user=") return ok(`${opts.owner ?? "testuser"}\n`);
    if (args[3] === "args=") return ok(opts.cmdline ?? OPENROUTER_RUNTIME_ADAPTER_CMDLINE);
    return null;
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
          run: (command, args) => {
            if (command === "ps") {
              const result = stub(args);
              if (result) return result;
            }
            if (command === "lsof") return ok("");
            if (args[0] === "-c") return ok("/fake/bin/tool\n");
            if (args[0] === "-f") return ok("");
            return ok();
          },
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
        run: (command, args) => {
          if (command === "lsof" && args[0] === "-ti") {
            lsofPorts.push(args[1] ?? "");
            if (args[1] === ":12037") return ok("33334\n");
            return ok("");
          }
          if (command === "ps") {
            const result = stub(args);
            if (result) return result;
          }
          if (args[0] === "-c") return ok("/fake/bin/tool\n");
          if (args[0] === "-f") return ok("");
          return ok();
        },
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
        run: (command, args) => {
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11437") {
            return ok("99998\n");
          }
          if (command === "lsof") return ok("");
          if (command === "ps") {
            const result = stub(args);
            if (result) return result;
          }
          if (args[0] === "-c") return ok("/fake/bin/tool\n");
          if (args[0] === "-f") return ok("");
          return ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(killed).not.toContain(99998);
    expect(logs).toContain("No OpenRouter Runtime adapter processes found");
  });
});
