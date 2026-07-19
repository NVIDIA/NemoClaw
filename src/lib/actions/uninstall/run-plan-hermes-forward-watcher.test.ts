// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type RunResult, runUninstallPlan, type UninstallRunDeps } from "./run-plan";

const SANDBOX = "default-sandbox";
const PORT = "8642";

type WatcherFixture = {
  pidFile: string;
  port: string;
  sandbox: string;
  watcherScript: string;
};

type ProcessFixture = {
  argv?: readonly string[] | null;
  commandLine?: string;
  commandLineAfterSignal?: string;
  commandLineReadable?: boolean;
  exitsOnSignal?: boolean;
  owner?: string;
  pid: number;
  running?: boolean;
  watcher: WatcherFixture;
};

type RunPlan = typeof runUninstallPlan;

function result(status: number | null, stdout = "", stderr = ""): RunResult {
  return { status, stdout, stderr };
}

function ok(stdout = ""): RunResult {
  return result(0, stdout);
}

function notFound(): RunResult {
  return result(1);
}

function commandKey(command: string, args: readonly string[]): string {
  return [command, ...args].join("\0");
}

function seedWatcher(
  stateRoot: string,
  pidContent: string,
  sandbox = SANDBOX,
  port = PORT,
): WatcherFixture {
  const stateDir = path.join(stateRoot, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const pidFile = path.join(stateDir, `hermes-${sandbox}-${port}.forward.pid`);
  fs.writeFileSync(pidFile, pidContent);
  return { pidFile, port, sandbox, watcherScript: `${pidFile}.js` };
}

function managedArgv(watcher: WatcherFixture): readonly string[] {
  return [
    "/usr/bin/node",
    watcher.watcherScript,
    "/usr/local/bin/openshell",
    watcher.port,
    watcher.sandbox,
  ];
}

function managedCommandLine(watcher: WatcherFixture): string {
  return `${managedArgv(watcher).join(" ")}\n`;
}

function defaultRun(command: string, args: readonly string[]): RunResult {
  const defaults = new Map<string, RunResult>([["lsof", ok("")]]);
  const shellProbe = args[0] === "-c" ? ok("/fake/bin/tool\n") : ok("");
  return defaults.get(command) ?? shellProbe;
}

function createHarness(
  tmpHome: string,
  processes: readonly ProcessFixture[],
  forwardStatuses: ReadonlyMap<string, number | null> = new Map(),
) {
  const calls: Array<{ args: string[]; command: string }> = [];
  const killed: number[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const processByPid = new Map(processes.map((process) => [process.pid, process]));
  const processCommandLines = new Map(
    processes.map((process) => [
      process.pid,
      process.commandLine ?? managedCommandLine(process.watcher),
    ]),
  );
  const alive = new Set(
    processes.filter((process) => process.running !== false).map((process) => process.pid),
  );
  const routes = new Map<string, () => RunResult>();

  for (const process of processes) {
    const pid = String(process.pid);
    routes.set(commandKey("ps", ["-p", pid, "-o", "pid="]), () =>
      alive.has(process.pid) ? ok(`${pid}\n`) : notFound(),
    );
    routes.set(commandKey("ps", ["-p", pid, "-o", "user="]), () =>
      ok(`${process.owner ?? "testuser"}\n`),
    );
    routes.set(commandKey("ps", ["-ww", "-p", pid, "-o", "args="]), () =>
      process.commandLineReadable === false
        ? result(2, "", "process inspection failed")
        : ok(processCommandLines.get(process.pid) ?? ""),
    );
  }
  for (const [forward, status] of forwardStatuses) {
    const [port, sandbox] = forward.split("\0");
    routes.set(commandKey("openshell", ["forward", "stop", port ?? "", sandbox ?? ""]), () =>
      result(status),
    );
  }

  const run = vi.fn((command: string, args: string[]): RunResult => {
    calls.push({ args: [...args], command });
    return routes.get(commandKey(command, args))?.() ?? defaultRun(command, args);
  });
  const deps: UninstallRunDeps = {
    commandExists: (command) => !["docker", "pgrep"].includes(command),
    env: { HOME: tmpHome, LOGNAME: "testuser" },
    error: (line) => warnings.push(line),
    existsSync: (target) => fs.existsSync(target),
    isTty: false,
    kill: (pid) => {
      killed.push(pid);
      const process = processByPid.get(pid);
      const replacement = process?.commandLineAfterSignal;
      const exits = process?.exitsOnSignal !== false;
      const transition =
        replacement !== undefined
          ? () => processCommandLines.set(pid, replacement)
          : exits
            ? () => alive.delete(pid)
            : () => alive.has(pid);
      transition();
      return true;
    },
    log: (line) => logs.push(line),
    readProcessArgv: (pid) => processByPid.get(pid)?.argv ?? null,
    rmSync: vi.fn(),
    run,
    runDocker: () => ok(),
  };
  return { calls, deps, killed, logs, warnings };
}

function uninstall(
  tmpHome: string,
  harness: ReturnType<typeof createHarness>,
  runPlan: RunPlan = runUninstallPlan,
  env: NodeJS.ProcessEnv = {},
) {
  return runPlan(
    { assumeYes: true, deleteModels: false, keepOpenShell: true },
    { ...harness.deps, env: { HOME: tmpHome, LOGNAME: "testuser", ...env } },
  );
}

function forwardStops(harness: ReturnType<typeof createHarness>): string[][] {
  return harness.calls
    .filter(({ command, args }) => command === "openshell" && args[0] === "forward")
    .map(({ args }) => args);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("uninstall Hermes forward watcher cleanup (#7163)", () => {
  it("stops an owned exact-argv watcher and its sandbox-scoped forward", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-stop-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "60642\n");
      const harness = createHarness(tmpHome, [{ argv: managedArgv(watcher), pid: 60642, watcher }]);
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(0);
      expect(harness.killed).toContain(60642);
      expect(harness.logs).toContain("Stopped Hermes forward watcher 60642");
      expect(forwardStops(harness)).toContainEqual(["forward", "stop", PORT, SANDBOX]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("stops an owned watcher through the exact macOS ps fallback", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-ps-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "69642\n");
      const harness = createHarness(tmpHome, [{ pid: 69642, watcher }]);
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(0);
      expect(harness.killed).toContain(69642);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("never signals a foreign-owned watcher even when its argv matches", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-foreign-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "70642\n");
      const harness = createHarness(tmpHome, [
        { argv: managedArgv(watcher), owner: "someone-else", pid: 70642, watcher },
      ]);
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(0);
      expect(harness.killed).not.toContain(70642);
      expect(forwardStops(harness)).toContainEqual(["forward", "stop", PORT, SANDBOX]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("rejects an adversarial command line that only embeds the watcher argv", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-reused-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "80642\n");
      const harness = createHarness(tmpHome, [
        {
          commandLine: `/bin/sh -c ${managedCommandLine(watcher).trim()}\n`,
          pid: 80642,
          watcher,
        },
      ]);
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(0);
      expect(harness.killed).not.toContain(80642);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("handles a stale numeric PID file without signaling it", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-stale-"));
    try {
      const root = path.join(tmpHome, ".nemoclaw");
      const stale = seedWatcher(root, "90642\n", "stale-sandbox");
      const harness = createHarness(tmpHome, [{ pid: 90642, running: false, watcher: stale }]);
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(0);
      expect(harness.killed).toHaveLength(0);
      expect(forwardStops(harness)).toContainEqual(["forward", "stop", PORT, "stale-sandbox"]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("preserves retry state when the watcher PID file is invalid", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-invalid-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "91642junk\n");
      const harness = createHarness(tmpHome, []);
      harness.deps.rmSync = fs.rmSync;
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(1);
      expect(harness.killed).toHaveLength(0);
      expect(fs.existsSync(watcher.pidFile)).toBe(true);
      expect(harness.warnings).toContain(
        `Failed to read a valid Hermes forward watcher PID from ${watcher.pidFile}.`,
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not follow a watcher PID-file symlink", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-symlink-"));
    try {
      const root = path.join(tmpHome, ".nemoclaw");
      const stateDir = path.join(root, "state");
      const target = path.join(tmpHome, "foreign-pid");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(target, "92642\n");
      const pidFile = path.join(stateDir, `hermes-${SANDBOX}-${PORT}.forward.pid`);
      fs.symlinkSync(target, pidFile);
      const watcher = { pidFile, port: PORT, sandbox: SANDBOX, watcherScript: `${pidFile}.js` };
      const harness = createHarness(tmpHome, [{ pid: 92642, watcher }]);
      harness.deps.rmSync = fs.rmSync;
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(1);
      expect(harness.killed).not.toContain(92642);
      expect(forwardStops(harness)).toContainEqual(["forward", "stop", PORT, SANDBOX]);
      expect(fs.existsSync(pidFile)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns nonzero when an owned watcher cannot be stopped", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-stuck-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "61642\n");
      const harness = createHarness(tmpHome, [
        { argv: managedArgv(watcher), exitsOnSignal: false, pid: 61642, watcher },
      ]);
      harness.deps.rmSync = fs.rmSync;
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(1);
      expect(harness.warnings).toContain("Failed to stop Hermes forward watcher 61642");
      expect(fs.existsSync(watcher.pidFile)).toBe(true);
      expect(harness.logs).not.toContain("Claws retracted. Until next time.");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("preserves retry state when a live watcher cannot be inspected", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-inspect-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "65642\n");
      const harness = createHarness(tmpHome, [{ commandLineReadable: false, pid: 65642, watcher }]);
      harness.deps.rmSync = fs.rmSync;
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(1);
      expect(harness.killed).toHaveLength(0);
      expect(fs.existsSync(watcher.pidFile)).toBe(true);
      expect(harness.warnings).toContain(
        "Failed to inspect Hermes forward watcher 65642; preserving state for retry.",
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("retries from preserved state after a transient watcher stop failure", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-retry-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "66642\n");
      const process: ProcessFixture = {
        argv: managedArgv(watcher),
        exitsOnSignal: false,
        pid: 66642,
        watcher,
      };
      const harness = createHarness(tmpHome, [process]);
      harness.deps.rmSync = fs.rmSync;

      const firstAttempt = uninstall(tmpHome, harness);
      expect(firstAttempt.exitCode).toBe(1);
      expect(fs.existsSync(watcher.pidFile)).toBe(true);

      process.exitsOnSignal = true;
      const retry = uninstall(tmpHome, harness);

      expect(retry.exitCode).toBe(0);
      expect(harness.killed).toEqual([66642, 66642, 66642]);
      expect(forwardStops(harness)).toEqual([
        ["forward", "stop", PORT, SANDBOX],
        ["forward", "stop", PORT, SANDBOX],
      ]);
      expect(fs.existsSync(watcher.pidFile)).toBe(false);
      expect(harness.logs).toContain("Claws retracted. Until next time.");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not send SIGKILL after the watcher PID is recycled", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-recycle-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "67642\n");
      const harness = createHarness(tmpHome, [
        {
          commandLineAfterSignal: "/usr/bin/sleep 99\n",
          exitsOnSignal: false,
          pid: 67642,
          watcher,
        },
      ]);
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(0);
      expect(harness.killed).toEqual([67642]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns nonzero when the sandbox-scoped forward stop fails", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-forward-"));
    try {
      const watcher = seedWatcher(path.join(tmpHome, ".nemoclaw"), "62642\n");
      const harness = createHarness(
        tmpHome,
        [{ argv: managedArgv(watcher), pid: 62642, watcher }],
        new Map([[`${PORT}\0${SANDBOX}`, 7]]),
      );
      harness.deps.rmSync = fs.rmSync;
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(1);
      expect(harness.killed).toContain(62642);
      expect(fs.existsSync(watcher.pidFile)).toBe(true);
      expect(harness.warnings).toContain(
        "Failed to stop Hermes forward for sandbox 'default-sandbox' on port 8642 (exit 7).",
      );
      expect(harness.logs).not.toContain("Claws retracted. Until next time.");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("cleans only the selected custom gateway when a sibling remains", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-sibling-"));
    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
      vi.resetModules();
      const { runUninstallPlan: runPortUninstall } = await import("./run-plan");
      const gatewayRoot = path.join(tmpHome, ".nemoclaw", "gateways");
      const selected = seedWatcher(path.join(gatewayRoot, "9123"), "63642\n", "selected-box");
      const sibling = seedWatcher(path.join(gatewayRoot, "9124"), "64642\n", "sibling-box");
      const harness = createHarness(tmpHome, [
        { argv: managedArgv(selected), pid: 63642, watcher: selected },
        { argv: managedArgv(sibling), pid: 64642, watcher: sibling },
      ]);
      const outcome = uninstall(tmpHome, harness, runPortUninstall, {
        NEMOCLAW_GATEWAY_PORT: "9123",
      });

      expect(outcome.exitCode).toBe(0);
      expect(harness.killed).toContain(63642);
      expect(harness.killed).not.toContain(64642);
      expect(forwardStops(harness)).toContainEqual(["forward", "stop", PORT, "selected-box"]);
      expect(forwardStops(harness)).not.toContainEqual(["forward", "stop", PORT, "sibling-box"]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("logs and continues when no watcher PID file exists", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-none-"));
    try {
      const harness = createHarness(tmpHome, []);
      const outcome = uninstall(tmpHome, harness);

      expect(outcome.exitCode).toBe(0);
      expect(harness.logs).toContain("No Hermes forward watchers found");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
