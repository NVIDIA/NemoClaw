// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildRunPlan, type RunResult, runUninstallPlan, type UninstallRunDeps } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

const PROXY_CMDLINE = "/usr/bin/node /opt/nemoclaw/scripts/ollama-auth-proxy.js\n";
// Real-world: model-router is a Python venv script so the OS interposes the
// interpreter — args[0]=python, args[1]=model-router (issue #5169).
const MODEL_ROUTER_CMDLINE =
  "/home/test/.nemoclaw/model-router-venv/bin/python /home/test/.nemoclaw/model-router-venv/bin/model-router proxy --port 4000\n";

function psStub(pidStr: string, opts: { exited: Set<number>; cmdline?: string; owner?: string }) {
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
          openSync: (() => {
            const error = new Error("symlink") as NodeJS.ErrnoException;
            error.code = "ELOOP";
            throw error;
          }) as never,
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
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test",
          NEMOCLAW_AGENT: "",
          TMPDIR: "/tmp/nemoclaw-uninstall-test",
        } as NodeJS.ProcessEnv,
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
    expect(dockerCalls).toEqual(
      expect.arrayContaining([
        ["rm", "-f", "abc"],
        ["rmi", "-f", "img1"],
      ]),
    );
    expect(
      dockerCalls.some((args) => args.join(" ") === "volume rm -f openshell-cluster-nemoclaw"),
    ).toBe(true);
  });

  it("removes all managed OpenShell helper binaries from the writable user bin", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-openshell-bins-"));
    const userBin = path.join(tmpHome, ".local", "bin");
    fs.mkdirSync(userBin, { recursive: true });

    const removed: string[] = [];
    const logs: string[] = [];
    const existing = new Set([
      path.join(userBin, "openshell"),
      path.join(userBin, "openshell-gateway"),
      path.join(userBin, "openshell-sandbox"),
      path.join(userBin, "openshell-driver-vm"),
    ]);

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) =>
            command !== "docker" &&
            command !== "lsof" &&
            command !== "openshell" &&
            command !== "pgrep",
          env: { HOME: tmpHome } as NodeJS.ProcessEnv,
          existsSync: (target) => existing.has(target),
          isTty: false,
          log: (line) => logs.push(line),
          rmSync: vi.fn((target: fs.PathLike) => {
            removed.push(String(target));
          }),
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(removed).toEqual(
        expect.arrayContaining([
          path.join(userBin, "openshell"),
          path.join(userBin, "openshell-gateway"),
          path.join(userBin, "openshell-sandbox"),
          path.join(userBin, "openshell-driver-vm"),
        ]),
      );
      expect(logs).toContain(`Removed ${path.join(userBin, "openshell-gateway")}`);
      expect(logs).toContain(`Removed ${path.join(userBin, "openshell-sandbox")}`);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
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
        env: { HOME: "/tmp/nemoclaw-uninstall-test", NEMOCLAW_AGENT: "" } as NodeJS.ProcessEnv,
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

  it("explains how to proceed when stdin yields no input at the confirm prompt", () => {
    const logs: string[] = [];
    const run = vi.fn();
    const result = runUninstallPlan(
      { assumeYes: false, deleteModels: false, keepOpenShell: true },
      {
        env: { HOME: "/tmp/nemoclaw-uninstall-test" } as NodeJS.ProcessEnv,
        log: (line) => logs.push(line),
        readLine: () => null,
        run,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain(
      "No input available on stdin (closed or non-interactive); re-run with --yes to skip this prompt.",
    );
    expect(logs).toContain("Aborted.");
    expect(run).not.toHaveBeenCalled();
  });

  it("builds the default runtime without touching process.stdin (#5188)", () => {
    const stdinGet = vi.spyOn(process, "stdin", "get");
    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => false,
          env: { HOME: "/tmp/nemoclaw-uninstall-test" } as NodeJS.ProcessEnv,
          existsSync: () => false,
          kill: () => true,
          log: () => {},
          rmSync: vi.fn(),
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
          // isTty/readLine intentionally not injected: the default
          // isStdinTty/readLineFromStdin pair must never instantiate
          // process.stdin, which would flip fd 0 non-blocking (#5188).
        },
      );
      expect(result.exitCode).toBe(0);
      expect(stdinGet).not.toHaveBeenCalled();
    } finally {
      stdinGet.mockRestore();
    }
  });

  it("kills the Ollama auth proxy via the persisted PID file (#2759)", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    // Simulate the persisted PID file under ~/.nemoclaw/.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-test-2759-pidfile-"));
    const pidFile = path.join(tmpHome, ".nemoclaw", "ollama-auth-proxy.pid");
    fs.mkdirSync(path.join(tmpHome, ".nemoclaw"), { recursive: true });
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

  it("kills the model router via onboard-session routerPid (#5169)", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-test-5169-session-"));
    const stateDir = path.join(tmpHome, ".nemoclaw");
    const sessionFile = path.join(stateDir, "onboard-session.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ routerPid: 55432 }));

    try {
      const stub = psStub("55432", { exited, cmdline: MODEL_ROUTER_CMDLINE });
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
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
      expect(killed).toContain(55432);
      expect(logs).toContain("Stopped model router 55432");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("kills an orphan model router via lsof :4000 when onboard-session is gone", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    const stub = psStub("55679", { exited, cmdline: MODEL_ROUTER_CMDLINE });
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-5169-lsof",
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
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":4000") {
            return ok("55679\n");
          }
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11435") {
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
    expect(killed).toContain(55679);
    expect(logs).toContain("Stopped model router 55679");
  });

  it("never stops a foreign-owned model router on :4000 even if cmdline matches", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const stub = psStub("77888", {
      exited: new Set(),
      owner: "someone-else",
      cmdline: MODEL_ROUTER_CMDLINE,
    });
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-5169-foreign-owner",
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
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":4000") {
            return ok("77888\n");
          }
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11435") {
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
    expect(killed).not.toContain(77888);
    expect(logs).toContain("No model router processes found");
  });

  it("never kills a process on :4000 whose cmdline is not the model router", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const stub = psStub("88888", {
      exited: new Set(),
      cmdline: "/usr/sbin/nginx -g daemon off;\n",
    });
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: "/tmp/nemoclaw-uninstall-test-5169-foreign-cmdline",
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
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":4000") {
            return ok("88888\n");
          }
          if (command === "lsof" && args[0] === "-ti" && args[1] === ":11435") {
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
    expect(killed).not.toContain(88888);
    expect(logs).toContain("No model router processes found");
  });

  it("escalates to SIGKILL and reports failure when SIGTERM is ignored", () => {
    const logs: string[] = [];
    const warnings: string[] = [];
    const signals: NodeJS.Signals[] = [];
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-test-2759-stuck-"));
    const pidFile = path.join(tmpHome, ".nemoclaw", "ollama-auth-proxy.pid");
    fs.mkdirSync(path.join(tmpHome, ".nemoclaw"), { recursive: true });
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
        // Neutralize NEMOCLAW_NON_INTERACTIVE: the runtime merges the real
        // process.env, so a developer shell exporting it would silently flip
        // this interactive scenario onto the non-interactive path.
        env: {
          HOME: "/home/test",
          NEMOCLAW_NON_INTERACTIVE: "",
          TMPDIR: "/tmp/test",
        } as NodeJS.ProcessEnv,
        error: (line) => warnings.push(line),
        existsSync: (target) =>
          target === "/swapfile" || target === "/home/test/.nemoclaw/managed_swap",
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

  it("uses the 'already removed' wording instead of 'Destroyed ... skipped' for gateway destroy no-ops, sub-bug 4 (#3456)", () => {
    // When `openshell gateway destroy -g nemoclaw` returns non-zero (gateway
    // already gone), the previous code printed `Destroyed gateway 'nemoclaw'
    // skipped` — self-contradictory. The fix routes this branch to an onSkip
    // message that describes the actual state.
    const warnings: string[] = [];
    const logs: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: "/home/test", TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        error: (line) => warnings.push(line),
        existsSync: () => false,
        isTty: false,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (command, args) => {
          if (command === "openshell" && args[0] === "gateway" && args[1] === "destroy") {
            return notFound();
          }
          if (args[0] === "-c") return ok("/fake/bin/tool\n");
          return ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(warnings.join("\n")).toContain("Gateway 'nemoclaw' already removed or unreachable");
    expect(`${warnings.join("\n")}\n${logs.join("\n")}`).not.toContain(
      "Destroyed gateway 'nemoclaw' skipped",
    );
  });

  describe("user-data preservation under ~/.nemoclaw/", () => {
    function setupStateDir(): { tmpHome: string; stateDir: string } {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-"));
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json"),
        "{}",
      );
      fs.mkdirSync(path.join(stateDir, "backups", "20260320-120000"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "backups", "20260320-120000", "USER.md"), "hello");
      fs.writeFileSync(path.join(stateDir, "sandboxes.json"), "[]");
      fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "1234");
      fs.mkdirSync(path.join(stateDir, "source"));
      return { tmpHome, stateDir };
    }

    function tempScopedExistsSync(tmpHome: string): (target: string) => boolean {
      return (target: string) => target.startsWith(tmpHome) && fs.existsSync(target);
    }

    function preserveCaseDeps(
      tmpHome: string,
      logs: string[],
      opts: {
        envOverrides?: Record<string, string>;
        isTty?: boolean;
        readLine?: UninstallRunDeps["readLine"];
      } = {},
    ): UninstallRunDeps {
      return {
        commandExists: () => false,
        env: {
          HOME: tmpHome,
          NEMOCLAW_NON_INTERACTIVE: "",
          NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "",
          ...(opts.envOverrides ?? {}),
        } as NodeJS.ProcessEnv,
        existsSync: tempScopedExistsSync(tmpHome),
        isTty: opts.isTty ?? false,
        log: (line) => logs.push(line),
        ...(opts.readLine ? { readLine: opts.readLine } : {}),
        run: vi.fn(() => ok()),
        runDocker: () => ok(""),
      };
    }

    function expectPreservedEntries(stateDir: string): void {
      expect(
        fs.existsSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json")),
      ).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "backups", "20260320-120000", "USER.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(true);
    }

    function expectNoPreserveSignals(logs: string[]): void {
      expect(logs.every((line) => !line.startsWith("Preserving "))).toBe(true);
      expect(logs.every((line) => !line.includes("preserved:"))).toBe(true);
    }

    it("preserves rebuild-backups/, backups/, and sandboxes.json by default in non-interactive runs", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs),
        );

        expect(result.exitCode).toBe(0);
        expectPreservedEntries(stateDir);
        expect(fs.existsSync(path.join(stateDir, "ollama-auth-proxy.pid"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "source"))).toBe(false);
        expect(logs).toContain(
          `Preserving rebuild-backups, backups, sandboxes.json under ${stateDir}.`,
        );
        expect(
          logs.some((line) => line.includes("preserved: rebuild-backups, backups, sandboxes.json")),
        ).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("purges the whole state dir when NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1 is set", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            envOverrides: { NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1" },
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(`Removed ${stateDir}`);
        expect(logs).toContain(
          "NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1 set; purging user data under ~/.nemoclaw/.",
        );
        expectNoPreserveSignals(logs);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("purges the whole state dir when destroyUserData is set, even with --yes on a non-TTY", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(`Removed ${stateDir}`);
        expect(logs).toContain("--destroy-user-data set; purging user data under ~/.nemoclaw/.");
        expectNoPreserveSignals(logs);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("destroyUserData purges on a TTY without prompting", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const readLine = vi.fn(() => "y");
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { isTty: true, readLine }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain("--destroy-user-data set; purging user data under ~/.nemoclaw/.");
        expect(logs.every((line) => line !== "Also remove them? [y/N]")).toBe(true);
        expect(readLine).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("destroyUserData without --yes renders a purge-aware global confirmation and skips the user-data prompt", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, destroyUserData: true, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { isTty: true, readLine: () => "y" }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(
          "  · ~/.nemoclaw (removes rebuild-backups/, backups/, sandboxes.json: --destroy-user-data set)",
        );
        expect(
          logs.every(
            (line) =>
              line !==
              "  · ~/.nemoclaw (preserves rebuild-backups/, backups/, sandboxes.json by default)",
          ),
        ).toBe(true);
        expect(logs.every((line) => line !== "Also remove them? [y/N]")).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("env var without --yes renders a purge-aware global confirmation", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            envOverrides: { NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1" },
            isTty: true,
            readLine: () => "y",
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(
          "  · ~/.nemoclaw (removes rebuild-backups/, backups/, sandboxes.json: NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1)",
        );
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("destroyUserData takes precedence over NEMOCLAW_UNINSTALL_DESTROY_USER_DATA env var", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            envOverrides: { NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1" },
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain("--destroy-user-data set; purging user data under ~/.nemoclaw/.");
        expect(
          logs.every(
            (line) =>
              line !==
              "NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1 set; purging user data under ~/.nemoclaw/.",
          ),
        ).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("non-interactive hint mentions --destroy-user-data alongside the env var on non-TTY without --yes", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { readLine: () => "y" }),
        );

        expect(result.exitCode).toBe(0);
        expectPreservedEntries(stateDir);
        expect(
          logs.some(
            (line) =>
              line.includes("--destroy-user-data") &&
              line.includes("NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1"),
          ),
        ).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("purges via interactive y/N prompt when user answers yes", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const replies = ["yes", "y"];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            isTty: true,
            readLine: () => replies.shift() ?? null,
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain("Also remove them? [y/N]");
        expect(logs).toContain("Acknowledged; purging user data.");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("keeps user data when interactive prompt is declined", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const replies = ["yes", ""];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            isTty: true,
            readLine: () => replies.shift() ?? null,
          }),
        );

        expect(result.exitCode).toBe(0);
        expectPreservedEntries(stateDir);
        expect(logs).toContain("Keeping user data.");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("preserves entries on a TTY when NEMOCLAW_NON_INTERACTIVE=1 is set instead of --yes", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const readLine = vi.fn(() => "yes");
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            envOverrides: { NEMOCLAW_NON_INTERACTIVE: "1" },
            isTty: true,
            readLine,
          }),
        );

        expect(result.exitCode).toBe(0);
        expectPreservedEntries(stateDir);
        expect(logs).toContain(
          `Preserving rebuild-backups, backups, sandboxes.json under ${stateDir}.`,
        );
        expect(logs.every((line) => line !== "Also remove them? [y/N]")).toBe(true);
        expect(readLine).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("exits non-zero and warns when lstat on ~/.nemoclaw fails with a non-ENOENT error", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const realLstat = fs.lstatSync;
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((p: fs.PathLike) => {
        if (String(p) === stateDir) {
          const err = new Error("permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realLstat(p);
      });
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            ...preserveCaseDeps(tmpHome, logs),
            error: (line) => warnings.push(line),
          },
        );

        expect(result.exitCode).toBe(1);
        expect(warnings.some((line) => line.startsWith(`Failed to inspect ${stateDir}: `))).toBe(
          true,
        );
        expect(warnings).toContain(
          "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
        );
        expect(logs).not.toContain("Claws retracted. Until next time.");
        expect(
          fs.existsSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json")),
        ).toBe(true);
      } finally {
        lstatSpy.mockRestore();
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("removes ~/.nemoclaw wholesale when it is a symlink rather than a real directory", () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-"));
      const realTarget = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-target-"),
      );
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.symlinkSync(realTarget, stateDir);
      // Symlink target intentionally non-empty so that following it would
      // tempt the selective-wipe path; lstat must short-circuit that.
      fs.writeFileSync(path.join(realTarget, "rebuild-backups"), "should not be followed");
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            commandExists: () => false,
            env: { HOME: tmpHome } as NodeJS.ProcessEnv,
            existsSync: (target: string) => target.startsWith(tmpHome) && fs.existsSync(target),
            isTty: false,
            log: (line) => logs.push(line),
            run: vi.fn(() => ok()),
            runDocker: () => ok(""),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(fs.existsSync(realTarget)).toBe(true);
        expect(logs).toContain(`Removed ${stateDir}`);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(realTarget, { recursive: true, force: true });
      }
    });

    it("skips the preservation notice when no protected entries exist on disk", () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-"));
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "1234");
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            commandExists: () => false,
            env: { HOME: tmpHome } as NodeJS.ProcessEnv,
            existsSync: tempScopedExistsSync(tmpHome),
            isTty: false,
            log: (line) => logs.push(line),
            run: vi.fn(() => ok()),
            runDocker: () => ok(""),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(`Removed ${stateDir}`);
        expect(logs.every((line) => !line.startsWith("Preserving "))).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });

  it("kills host openshell-gateway process during uninstall (#3516)", () => {
    const logs: string[] = [];
    const killed: number[] = [];
    const exited = new Set<number>();
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-uninstall-test-3516" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: (pid) => {
          killed.push(pid);
          exited.add(pid);
          return true;
        },
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (command, args) => {
          const psResult = psStub("9999887", {
            cmdline: "/home/test/.local/bin/openshell-gateway --port 8080\n",
            exited,
          })(args);
          if (psResult) return psResult;
          if (
            command === "pgrep" &&
            args[0] === "-f" &&
            String(args[1]).includes("openshell-gateway")
          ) {
            return { status: 0, stdout: "9999887\n", stderr: "" };
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
    expect(killed).toContain(9999887);
    expect(logs).toContain("Stopped host openshell-gateway process 9999887");
  });
});
