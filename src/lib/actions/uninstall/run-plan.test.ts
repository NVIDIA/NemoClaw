// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { buildRunPlan, runUninstallPlan, type RunResult } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

const PROXY_CMDLINE = "/usr/bin/node /opt/nemoclaw/scripts/ollama-auth-proxy.js\n";

function psStub(
  pidStr: string,
  opts: { exited: Set<number>; cmdline?: string; owner?: string },
) {
  return (args: readonly string[]): RunResult | null => {
    if (args[0] !== "-p" || args[1] !== pidStr || args[2] !== "-o") return null;
    const pid = Number(pidStr);
    if (args[3] === "pid=") {
      return opts.exited.has(pid) ? notFound() : ok(`${pidStr}\n`);
    }
    if (args[3] === "user=") return ok(`${opts.owner ?? "testuser"}\n`);
    if (args[3] === "args=") return ok(opts.cmdline ?? PROXY_CMDLINE);
    return null;
  };
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
    expect(logs).toContain("NemoClaw Uninstaller");
    expect(logs).toContain("This will remove all NemoClaw resources.");
    expect(logs).toContain("[3/6] NemoClaw CLI");
    expect(logs).toContain("Removed global NemoClaw CLI package");
    expect(logs).toContain("Claws retracted. Until next time.");
    expect(dockerCalls).toEqual(expect.arrayContaining([["rm", "-f", "abc"], ["rmi", "-f", "img1"]]));
    expect(dockerCalls.some((args) => args.join(" ") === "volume rm -f openshell-cluster-nemoclaw")).toBe(true);
  });

  it("uses NemoHermes uninstall copy when Hermes is the active agent", () => {
    const logs: string[] = [];
    const warnings: string[] = [];

    const result = runUninstallPlan(
      { assumeYes: false, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => false,
        env: {
          HOME: "/tmp/nemohermes-uninstall-test",
          NEMOCLAW_AGENT: "hermes",
          TMPDIR: "/tmp/nemohermes-uninstall-test",
        } as NodeJS.ProcessEnv,
        error: (line) => warnings.push(line),
        existsSync: () => false,
        isTty: true,
        log: (line) => logs.push(line),
        readLine: () => "yes",
        rmSync: vi.fn(),
        run: vi.fn(),
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("NemoHermes Uninstaller");
    expect(logs).toContain("This will remove all NemoHermes resources.");
    expect(logs).toContain("  · All OpenShell sandboxes, gateway, and NemoHermes providers");
    expect(logs).toContain("  · Global NemoHermes CLI (npm package: nemoclaw)");
    expect(logs).toContain("[3/6] NemoHermes CLI");
    expect(warnings).toContain("npm not found; skipping NemoHermes CLI uninstall.");
    expect(logs).toContain("NemoHermes");
    expect(logs).toContain("Hermes has left the tidepool.");
    expect(logs).not.toContain("NemoClaw Uninstaller");
    expect(logs).not.toContain("[3/6] NemoClaw CLI");
    expect(logs).not.toContain("Claws retracted. Until next time.");
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
    expect(logs).toContain("  · All OpenShell sandboxes, gateway, and NemoClaw providers");
    expect(logs).toContain("  · Global NemoClaw CLI (npm package: nemoclaw)");
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
      const stub = psStub("44321", { exited });
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
    const stub = psStub("55678", { exited });
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-2759-lsof",
          LOGNAME: "testuser",
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
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11435") {
            return ok("55678\n");
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
    expect(killed).toContain(55678);
    expect(logs).toContain("Stopped Ollama auth proxy 55678");
  });

  it("never stops a foreign-owned auth proxy on :11435 even if cmdline matches", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const stub = psStub("77777", { exited: new Set(), owner: "someone-else" });
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-2759-foreign-owner",
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
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11435") {
            return ok("77777\n");
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
    expect(killed).not.toContain(77777);
    expect(logs).toContain("No Ollama auth proxy processes found");
  });

  it("scans the custom NEMOCLAW_OLLAMA_PROXY_PORT for orphan auth proxies", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    const stub = psStub("33333", { exited });
    const lsofPorts: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-2759-custom-port",
          LOGNAME: "testuser",
          NEMOCLAW_OLLAMA_PROXY_PORT: "12000",
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
            // Only return a hit when the scan is asking about the custom port.
            if (args[1] === ":12000") return ok("33333\n");
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
    expect(lsofPorts).toContain(":12000");
    expect(lsofPorts).not.toContain(":11435");
    expect(killed).toContain(33333);
    expect(logs).toContain("Stopped Ollama auth proxy 33333");
  });

  it("never kills a process on :11435 whose cmdline is not the auth proxy", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    // Same owner, different cmdline — exercises the cmdline gate specifically.
    const stub = psStub("99999", {
      exited: new Set(),
      cmdline: "/usr/sbin/nginx -g daemon off;\n",
    });
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-2759-foreign",
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
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11435") {
            return ok("99999\n");
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
      // exited stays empty — pidExists() always reports alive, simulating a
      // process that ignores SIGTERM and survives SIGKILL.
      const stub = psStub("44322", { exited: new Set() });
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
          existsSync: (target) => target === pidFile,
          isTty: false,
          kill: (_pid, signal) => {
            if (typeof signal === "string") signals.push(signal);
            return true;
          },
          log: (line: string) => logs.push(line),
          error: (line: string) => warnings.push(line),
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
        log: (line: string) => logs.push(line),
        error: (line: string) => warnings.push(line),
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
