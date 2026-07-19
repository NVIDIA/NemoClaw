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

describe("uninstall Hermes forward watcher cleanup (#7163)", () => {
  const SANDBOX = "default-sandbox";
  const PORT = "8642";

  function seedWatcher(tmpHome: string, pidContent: string) {
    const stateDir = path.join(tmpHome, ".nemoclaw", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const pidFile = path.join(stateDir, `hermes-${SANDBOX}-${PORT}.forward.pid`);
    fs.writeFileSync(pidFile, pidContent);
    return { pidFile, watcherScript: `${pidFile}.js` };
  }

  function watcherRun(config: {
    pid: string;
    watcherScript: string;
    owner?: string;
    exited: Set<number>;
    forwardStops: string[][];
  }) {
    return (command: string, args: readonly string[]): RunResult => {
      if (command === "openshell" && args[0] === "forward" && args[1] === "stop") {
        config.forwardStops.push([...args]);
        return ok();
      }
      if (command === "ps" && args[0] === "-p" && args[1] === config.pid && args[2] === "-o") {
        const pidNum = Number(config.pid);
        if (args[3] === "pid=")
          return config.exited.has(pidNum) ? notFound() : ok(`${config.pid}\n`);
        if (args[3] === "user=") return ok(`${config.owner ?? "testuser"}\n`);
        if (args[3] === "args=")
          return ok(
            `/usr/bin/node ${config.watcherScript} /usr/local/bin/openshell ${PORT} ${SANDBOX}\n`,
          );
      }
      if (command === "lsof") return ok("");
      if (args[0] === "-c") return ok("/fake/bin/tool\n");
      if (args[0] === "-f") return ok("");
      return ok();
    };
  }

  function runWithWatcher(
    tmpHome: string,
    overrides: {
      pid: string;
      watcherScript: string;
      owner?: string;
      exited: Set<number>;
      forwardStops: string[][];
      killed: number[];
      logs: string[];
      warnings: string[];
    },
  ) {
    return runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
        error: (line) => overrides.warnings.push(line),
        existsSync: (target) => fs.existsSync(target),
        isTty: false,
        kill: (pid, _signal) => {
          overrides.killed.push(pid);
          if (overrides.owner === undefined || overrides.owner === "testuser") {
            overrides.exited.add(pid);
          }
          return true;
        },
        log: (line) => overrides.logs.push(line),
        rmSync: vi.fn(),
        run: watcherRun({
          pid: overrides.pid,
          watcherScript: overrides.watcherScript,
          owner: overrides.owner,
          exited: overrides.exited,
          forwardStops: overrides.forwardStops,
        }),
        runDocker: () => ok(""),
      },
    );
  }

  it("stops an owned watcher after ownership and argv verification, then stops its forward", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-stop-"));
    const logs: string[] = [];
    const warnings: string[] = [];
    const killed: number[] = [];
    const forwardStops: string[][] = [];
    try {
      const { watcherScript } = seedWatcher(tmpHome, "60642\n");
      const result = runWithWatcher(tmpHome, {
        pid: "60642",
        watcherScript,
        exited: new Set<number>(),
        forwardStops,
        killed,
        logs,
        warnings,
      });

      expect(result.exitCode).toBe(0);
      expect(killed).toContain(60642);
      expect(logs).toContain("Stopped Hermes forward watcher 60642");
      expect(forwardStops).toContainEqual(["forward", "stop", PORT, SANDBOX]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("never signals a foreign-owned watcher even when the argv matches", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-foreign-"));
    const logs: string[] = [];
    const warnings: string[] = [];
    const killed: number[] = [];
    const forwardStops: string[][] = [];
    try {
      const { watcherScript } = seedWatcher(tmpHome, "70642\n");
      const result = runWithWatcher(tmpHome, {
        pid: "70642",
        watcherScript,
        owner: "someone-else",
        exited: new Set<number>(),
        forwardStops,
        killed,
        logs,
        warnings,
      });

      expect(result.exitCode).toBe(0);
      expect(killed).not.toContain(70642);
      expect(logs).not.toContain("Stopped Hermes forward watcher 70642");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("skips a reused PID whose argv no longer matches the managed watcher script", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-reused-"));
    const logs: string[] = [];
    const warnings: string[] = [];
    const killed: number[] = [];
    const forwardStops: string[][] = [];
    try {
      seedWatcher(tmpHome, "80642\n");
      const result = runWithWatcher(tmpHome, {
        pid: "80642",
        watcherScript: "/some/unrelated/process.js",
        exited: new Set<number>(),
        forwardStops,
        killed,
        logs,
        warnings,
      });

      expect(result.exitCode).toBe(0);
      expect(killed).not.toContain(80642);
      expect(logs).not.toContain("Stopped Hermes forward watcher 80642");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("handles a stale PID that is no longer running", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-stale-"));
    const logs: string[] = [];
    const warnings: string[] = [];
    const killed: number[] = [];
    const forwardStops: string[][] = [];
    try {
      const { watcherScript } = seedWatcher(tmpHome, "90642\n");
      const result = runWithWatcher(tmpHome, {
        pid: "90642",
        watcherScript,
        exited: new Set<number>([90642]),
        forwardStops,
        killed,
        logs,
        warnings,
      });

      expect(result.exitCode).toBe(0);
      expect(killed).not.toContain(90642);
      expect(forwardStops).toContainEqual(["forward", "stop", PORT, SANDBOX]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("ignores a PID file with invalid contents", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-invalid-"));
    const logs: string[] = [];
    const warnings: string[] = [];
    const killed: number[] = [];
    const forwardStops: string[][] = [];
    try {
      const { watcherScript } = seedWatcher(tmpHome, "not-a-pid\n");
      const result = runWithWatcher(tmpHome, {
        pid: "0",
        watcherScript,
        exited: new Set<number>(),
        forwardStops,
        killed,
        logs,
        warnings,
      });

      expect(result.exitCode).toBe(0);
      expect(killed).toHaveLength(0);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns nonzero and warns when an owned watcher cannot be stopped", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-stuck-"));
    const logs: string[] = [];
    const warnings: string[] = [];
    const killed: number[] = [];
    const forwardStops: string[][] = [];
    try {
      const { watcherScript } = seedWatcher(tmpHome, "61642\n");
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
          error: (line) => warnings.push(line),
          existsSync: (target) => fs.existsSync(target),
          isTty: false,
          kill: (pid) => {
            killed.push(pid);
            return true;
          },
          log: (line) => logs.push(line),
          rmSync: vi.fn(),
          run: watcherRun({
            pid: "61642",
            watcherScript,
            exited: new Set<number>(),
            forwardStops,
          }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(warnings).toContain("Failed to stop Hermes forward watcher 61642");
      expect(logs).not.toContain("Claws retracted. Until next time.");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("logs and continues when no watcher PID file exists", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-7163-none-"));
    const logs: string[] = [];
    const warnings: string[] = [];
    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env: { HOME: tmpHome, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
          error: (line) => warnings.push(line),
          existsSync: (target) => fs.existsSync(target),
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
      expect(logs).toContain("No Hermes forward watchers found");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
