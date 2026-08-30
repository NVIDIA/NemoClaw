// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getMcpLifecycleLockPath } from "../../src/lib/state/mcp-lifecycle-lock";

const CHILD_TIMEOUT_MS = 10_000;
const LOCK_MODULE_PATH = path.resolve("src/lib/state/mcp-lifecycle-lock.ts");

export async function runCompletedAutoRestoreFixtureChild(
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
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    const timeout = setTimeout(
      () => settle(new Error(`${label} child did not report ${expectedLine}: ${stderr}`)),
      CHILD_TIMEOUT_MS,
    );
    child.once("error", (error) => settle(error));
    child.once("close", (code) => {
      if (code !== 0) {
        settle(new Error(`${label} child exited ${String(code)}: ${stderr}`));
      } else if (!stdout.split(/\r?\n/u).includes(expectedLine)) {
        settle(new Error(`${label} child closed before reporting ${expectedLine}: ${stderr}`));
      } else {
        settle();
      }
    });
  });
  try {
    await completed;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export async function createCompletedAutoRestoreFixture(
  stateDir: string,
  sandboxName: string,
  processToken: string,
) {
  fs.mkdirSync(stateDir, { recursive: true });
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
  await runCompletedAutoRestoreFixtureChild(
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
  await runCompletedAutoRestoreFixtureChild(
    containmentScript,
    [LOCK_MODULE_PATH, stateDir, sandboxName],
    "CONTAINED",
    "containment",
  );

  const statePath = path.join(stateDir, `shields-${sandboxName}.json`);
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      shieldsDown: false,
      shieldsDownAt: null,
      shieldsDownTimeout: null,
      shieldsDownReason: null,
      shieldsDownPolicy: null,
      fileHashes: { "/sandbox/.openclaw/openclaw.json": "a".repeat(64) },
      updatedAt: new Date().toISOString(),
    }),
  );
  const lockPath = getMcpLifecycleLockPath(sandboxName, stateDir);
  return {
    containmentPath: `${lockPath}.containment`,
    deadlinePath: `${lockPath}.deadline`,
    lockPath,
    markerPath,
    statePath,
    timerPid: JSON.parse(fs.readFileSync(markerPath, "utf8")).pid as number,
  };
}
