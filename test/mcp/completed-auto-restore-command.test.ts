// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Args } from "@oclif/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NemoClawCommand } from "../../src/lib/cli/nemoclaw-oclif-command";
import * as lifecycleLock from "../../src/lib/state/mcp-lifecycle-lock";

const CHILD_TIMEOUT_MS = 10_000;
const LOCK_MODULE_PATH = path.resolve("src/lib/state/mcp-lifecycle-lock.ts");

async function runChild(
  script: string,
  args: string[],
  expectedLine: string,
  label: string,
): Promise<void> {
  const child = spawn(process.execPath, ["--require", "tsx/cjs", "-e", script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const completed = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      switch (settled) {
        case true:
          return;
      }
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(
      () => settle(new Error(`${label} child did not report ${expectedLine}: ${stderr}`)),
      CHILD_TIMEOUT_MS,
    );
    child.once("error", (error) => settle(error));
    child.once("exit", (code) => {
      switch (true) {
        case code !== 0:
          settle(new Error(`${label} child exited ${String(code)}: ${stderr}`));
          break;
        case !stdout.split(/\r?\n/u).includes(expectedLine):
          settle(new Error(`${label} child exited before reporting ${expectedLine}: ${stderr}`));
          break;
        default:
          settle();
      }
    });
  });
  try {
    await completed;
  } finally {
    child.exitCode === null && child.kill("SIGKILL");
  }
}

async function reproduceCompletedAutoRestoreContainment(
  stateDir: string,
  sandboxName: string,
  processToken: string,
): Promise<{ markerPath: string; timerPid: number }> {
  const markerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
  const timerScript = String.raw`
const fs = require("node:fs");
const lock = require(process.argv[1]);
const stateDir = process.argv[2];
const markerPath = process.argv[3];
const sandboxName = process.argv[4];
const processToken = process.argv[5];
fs.writeFileSync(markerPath, JSON.stringify({
  pid: process.pid,
  sandboxName,
  snapshotPath: stateDir + "/snapshot.yaml",
  restoreAt: new Date(Date.now() - 60000).toISOString(),
  processToken,
}));
lock.withMcpLifecycleDeadlineFenceSync(sandboxName, processToken, () => {
  fs.writeSync(1, "OWNED\n");
  process.exit(0);
}, { stateDir, pollIntervalMs: 5, timeoutMs: 1000, corruptLockGraceMs: 1 });
`;
  await runChild(
    timerScript,
    [LOCK_MODULE_PATH, stateDir, markerPath, sandboxName, processToken],
    "OWNED",
    "timer",
  );

  const containmentScript = String.raw`
const fs = require("node:fs");
const lock = require(process.argv[1]);
const stateDir = process.argv[2];
const sandboxName = process.argv[3];
try {
  lock.withMcpLifecycleLockSync(sandboxName, () => process.exit(3), {
    stateDir,
    pollIntervalMs: 5,
    timeoutMs: 1000,
    corruptLockGraceMs: 1,
  });
  process.exit(4);
} catch {
  fs.statSync(lock.getMcpLifecycleLockPath(sandboxName, stateDir) + ".containment");
  fs.writeSync(1, "CONTAINED\n");
}
`;
  await runChild(
    containmentScript,
    [LOCK_MODULE_PATH, stateDir, sandboxName],
    "CONTAINED",
    "containment",
  );

  return {
    markerPath,
    timerPid: JSON.parse(fs.readFileSync(markerPath, "utf8")).pid as number,
  };
}

class StatusCommand extends NemoClawCommand {
  static id = "sandbox:status";
  static args = { sandboxName: Args.string({ required: true }) };
  static flags = {};
  static entered = false;

  public async run(): Promise<void> {
    const { args } = await this.parse(StatusCommand);
    StatusCommand.entered = lifecycleLock.isMcpLifecycleLockHeld(args.sandboxName!);
  }
}

class LogsCommand extends NemoClawCommand {
  static id = "sandbox:logs";
  static args = { sandboxName: Args.string({ required: true }) };
  static flags = {};
  static entered = false;

  public async run(): Promise<void> {
    const { args } = await this.parse(LogsCommand);
    LogsCommand.entered = lifecycleLock.isMcpLifecycleLockHeld(args.sandboxName!);
  }
}

describe("completed auto-restore command admission", () => {
  let testHome: string;
  let stateDir: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-restore-command-"));
    stateDir = path.join(testHome, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    vi.stubEnv("HOME", testHome);
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", testHome);
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    StatusCommand.entered = false;
    LogsCommand.entered = false;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  const commands = [
    {
      id: "sandbox:status",
      run: () => StatusCommand.run(["alpha"], process.cwd()),
      entered: () => StatusCommand.entered,
    },
    {
      id: "sandbox:logs",
      run: () => LogsCommand.run(["alpha"], process.cwd()),
      entered: () => LogsCommand.entered,
    },
  ];

  it.each(commands)(
    "$id enters after exact completed auto-restore recovery (#10094)",
    { timeout: 30_000 },
    async ({ run, entered }) => {
      const processToken = "c".repeat(32);
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        processToken,
      );
      fs.writeFileSync(
        path.join(stateDir, "shields-alpha.json"),
        JSON.stringify({ shieldsDown: false, updatedAt: new Date().toISOString() }),
      );
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);

      await expect(run()).resolves.toBeUndefined();

      expect(entered()).toBe(true);
      expect(
        [orphan.markerPath, lockPath, `${lockPath}.deadline`, `${lockPath}.containment`].map(
          (file) => fs.existsSync(file),
        ),
      ).toEqual([false, false, false, false]);
    },
  );

  it("denies command entry for an ambiguous live timer owner (#10094)", async () => {
    const processToken = "d".repeat(32);
    const orphan = await reproduceCompletedAutoRestoreContainment(stateDir, "alpha", processToken);
    fs.writeFileSync(
      path.join(stateDir, "shields-alpha.json"),
      JSON.stringify({ shieldsDown: false, updatedAt: new Date().toISOString() }),
    );
    const marker = JSON.parse(fs.readFileSync(orphan.markerPath, "utf8"));
    marker.pid = process.pid;
    fs.writeFileSync(orphan.markerPath, JSON.stringify(marker));

    await expect(StatusCommand.run(["alpha"], process.cwd())).rejects.toThrow(
      "containment is active",
    );
    expect(StatusCommand.entered).toBe(false);
    expect(fs.existsSync(orphan.markerPath)).toBe(true);
  });

  it(
    "retries an exact marker restored after cleanup failure (#10094)",
    {
      timeout: 30_000,
    },
    async () => {
      const processToken = "e".repeat(32);
      const orphan = await reproduceCompletedAutoRestoreContainment(
        stateDir,
        "alpha",
        processToken,
      );
      fs.writeFileSync(
        path.join(stateDir, "shields-alpha.json"),
        JSON.stringify({ shieldsDown: false, updatedAt: new Date().toISOString() }),
      );
      const realUnlink = fs.unlinkSync.bind(fs);
      let injected = false;
      const injectUnlinkFailure = (): never => {
        injected = true;
        const error = new Error("injected unlink failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      };
      vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
        return !injected && String(target).includes(".completed-")
          ? injectUnlinkFailure()
          : realUnlink(target);
      });

      await expect(StatusCommand.run(["alpha"], process.cwd())).resolves.toBeUndefined();

      expect(injected).toBe(true);
      expect(StatusCommand.entered).toBe(true);
      expect(fs.existsSync(orphan.markerPath)).toBe(false);
      expect(fs.readdirSync(stateDir).filter((name) => name.includes(".completed-"))).toEqual([]);
    },
  );

  it("clears the child timeout when the timer process exits early (#10094)", async () => {
    vi.useFakeTimers();

    await expect(runChild("process.exit(1);", [], "OWNED", "timer")).rejects.toThrow(
      "timer child exited 1",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
