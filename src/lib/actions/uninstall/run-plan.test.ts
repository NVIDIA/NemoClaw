// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { buildRunPlan, runUninstallPlan, type RunResult } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

describe("uninstall run plan", () => {
  it("builds a plan using host paths and shim classification", () => {
    const { paths, plan } = buildRunPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: false },
      {
        env: { HOME: "/home/test", TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        fs: {
          lstatSync: (() => ({ isFile: () => false, isSymbolicLink: () => true })) as never,
        },
      },
    );

    expect(paths.nemoclawShimPath).toBe("/home/test/.local/bin/nemoclaw");
    expect(plan.steps.map((step) => step.name)).toContain("NemoClaw CLI");
    expect(plan.steps.flatMap((step) => step.actions)).toEqual(
      expect.arrayContaining([{ kind: "delete-shim", reason: "shim path is a symlink" }]),
    );
  });

  it("applies a non-destructive uninstall run with fake tools", () => {
    const logs: string[] = [];
    const run = vi.fn((_command: string, args: string[]) => {
      if (args[0] === "-c") return ok("/fake/bin/tool\n");
      if (args[0] === "-f") return ok("");
      return ok();
    });
    const dockerCalls: string[][] = [];
    const runDocker = vi.fn((args: string[]) => {
      dockerCalls.push(args);
      if (args[0] === "ps") return ok("abc openclaw:latest openshell-cluster-nemoclaw\n");
      if (args[0] === "images") return ok("img1 ghcr.io/nvidia/nemoclaw:test\n");
      return ok();
    });

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-uninstall-test", TMPDIR: "/tmp/nemoclaw-uninstall-test" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: () => true,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run,
        runDocker,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("Claws retracted. Until next time.");
    expect(dockerCalls).toEqual(expect.arrayContaining([["rm", "-f", "abc"], ["rmi", "-f", "img1"]]));
    expect(dockerCalls.some((args) => args.join(" ") === "volume rm -f openshell-cluster-nemoclaw")).toBe(true);
  });

  it("accepts typed interactive confirmation", () => {
    const logs: string[] = [];
    const run = vi.fn((_command: string, args: string[]) => {
      if (args[0] === "-c") return ok("/fake/bin/tool\n");
      if (args[0] === "-f") return ok("");
      return ok();
    });

    const result = runUninstallPlan(
      { assumeYes: false, deleteModels: false, keepOpenShell: true },
      {
        env: { HOME: "/tmp/nemoclaw-uninstall-test" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: true,
        log: (line) => logs.push(line),
        readLine: () => "yes",
        run,
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("Proceed? [y/N]");
    expect(logs).toContain("Claws retracted. Until next time.");
  });

  it("aborts without applying the plan when confirmation is declined", () => {
    const logs: string[] = [];
    const run = vi.fn();
    const result = runUninstallPlan(
      { assumeYes: false, deleteModels: false, keepOpenShell: true },
      {
        env: { HOME: "/tmp/nemoclaw-uninstall-test" } as NodeJS.ProcessEnv,
        log: (line) => logs.push(line),
        readLine: () => "no",
        run,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("Aborted.");
    expect(run).not.toHaveBeenCalled();
  });

  it("kills the Ollama auth proxy via the persisted PID file (#2759)", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    // Simulate the persisted PID file under ~/.nemoclaw/.
    const tmpHome = "/tmp/nemoclaw-uninstall-test-2759-pidfile";
    const pidFile = `${tmpHome}/.nemoclaw/ollama-auth-proxy.pid`;
    fs.mkdirSync(`${tmpHome}/.nemoclaw`, { recursive: true });
    fs.writeFileSync(pidFile, "44321\n");

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => target === pidFile,
          isTty: false,
          kill: (pid, signal) => {
            // Signal 0 is the existence probe; return false once SIGTERM has
            // been delivered to simulate the proxy exiting cleanly.
            if (signal === 0) return !exited.has(pid);
            killed.push(pid);
            exited.add(pid);
            return true;
          },
          log: (line) => logs.push(line),
          rmSync: vi.fn(),
          run: (command, args) => {
            // ps -p 44321 -o args= confirms the proxy cmdline.
            if (command === "ps" && args.includes("44321")) {
              return ok("/usr/bin/node /opt/nemoclaw/scripts/ollama-auth-proxy.js\n");
            }
            // lsof fallback returns nothing — PID-file branch should win.
            if (command === "lsof") return ok("");
            if (args[0] === "-c") return ok("/fake/bin/tool\n");
            if (args[0] === "-f") return ok("");
            return ok();
          },
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(killed).toContain(44321);
      expect(logs).toContain("Stopped Ollama auth proxy 44321");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("kills an orphan auth proxy via lsof :11435 when the PID file is gone", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-uninstall-test-2759-lsof" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: (pid, signal) => {
          if (signal === 0) return !exited.has(pid);
          killed.push(pid);
          exited.add(pid);
          return true;
        },
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (command, args) => {
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11435") {
            return ok("55678\n");
          }
          if (command === "ps" && args.includes("55678")) {
            return ok("/usr/bin/node /opt/nemoclaw/scripts/ollama-auth-proxy.js\n");
          }
          if (args[0] === "-c") return ok("/fake/bin/tool\n");
          if (args[0] === "-f") return ok("");
          return ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(killed).toContain(55678);
    expect(logs).toContain("Stopped Ollama auth proxy 55678");
  });

  it("never kills a process on :11435 whose cmdline is not the auth proxy", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-uninstall-test-2759-foreign" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: (pid) => {
          killed.push(pid);
          return true;
        },
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (command, args) => {
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11435") {
            return ok("99999\n");
          }
          // PID 99999 is some unrelated service the user happens to run.
          if (command === "ps" && args.includes("99999")) {
            return ok("/usr/sbin/nginx -g daemon off;\n");
          }
          if (args[0] === "-c") return ok("/fake/bin/tool\n");
          if (args[0] === "-f") return ok("");
          return ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(killed).not.toContain(99999);
    expect(logs).toContain("No Ollama auth proxy processes found");
  });

  it("escalates to SIGKILL and reports failure when SIGTERM is ignored", () => {
    const logs: string[] = [];
    const warnings: string[] = [];
    const signals: NodeJS.Signals[] = [];
    const tmpHome = "/tmp/nemoclaw-uninstall-test-2759-stuck";
    const pidFile = `${tmpHome}/.nemoclaw/ollama-auth-proxy.pid`;
    fs.mkdirSync(`${tmpHome}/.nemoclaw`, { recursive: true });
    fs.writeFileSync(pidFile, "44322\n");

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => target === pidFile,
          isTty: false,
          kill: (_pid, signal) => {
            if (signal === 0) return true;
            if (signal) signals.push(signal);
            return true;
          },
          log: (line) => logs.push(line),
          warn: (line) => warnings.push(line),
          error: (line) => warnings.push(line),
          rmSync: vi.fn(),
          run: (command, args) => {
            if (command === "ps" && args.includes("44322")) {
              return ok("/usr/bin/node /opt/nemoclaw/scripts/ollama-auth-proxy.js\n");
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
      expect(signals).toContain("SIGKILL");
      expect(warnings).toContain("Failed to stop Ollama auth proxy 44322");
      expect(logs).not.toContain("Stopped Ollama auth proxy 44322");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("warns instead of claiming success when lsof is unavailable for orphan scan", () => {
    const logs: string[] = [];
    const warnings: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "lsof",
        env: { HOME: "/tmp/nemoclaw-uninstall-test-2759-no-lsof" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: () => true,
        log: (line) => logs.push(line),
        warn: (line) => warnings.push(line),
        error: (line) => warnings.push(line),
        rmSync: vi.fn(),
        run: (_command, args) => {
          if (args[0] === "-c") return ok("/fake/bin/tool\n");
          if (args[0] === "-f") return ok("");
          return ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(warnings).toContain("lsof not found; skipping orphan Ollama auth proxy scan.");
    expect(logs).not.toContain("No Ollama auth proxy processes found");
  });

  it("logs and continues when no Ollama auth proxy is running", () => {
    const logs: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-uninstall-test-2759-empty" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: () => true,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (command, args) => {
          if (command === "lsof") return ok("");
          if (args[0] === "-c") return ok("/fake/bin/tool\n");
          if (args[0] === "-f") return ok("");
          return ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("No Ollama auth proxy processes found");
  });

  it("does not report swap cleanup success when swapoff fails", () => {
    const warnings: string[] = [];
    const logs: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: "/home/test", TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        error: (line) => warnings.push(line),
        existsSync: (target) => target === "/swapfile" || target === "/home/test/.nemoclaw/managed_swap",
        isTty: true,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (_command, args) => {
          if (args[0] === "swapoff") return { status: 1, stdout: "", stderr: "swapoff failed" };
          return ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(warnings).toContain("Failed to disable /swapfile; skipping swap cleanup.");
    expect(logs).not.toContain("Swap file removed");
  });
});
