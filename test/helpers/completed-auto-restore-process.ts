// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHILD_TIMEOUT_MS = 10_000;

async function runChild(
  nodePath: string,
  script: string,
  args: string[],
  expectedLine: string,
  label: string,
): Promise<void> {
  const child = spawn(nodePath, ["-e", script, ...args], {
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
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${label} child exited ${String(code)}: ${stderr}`)),
    );
  });
  const producedEvidence = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} child did not report ${expectedLine}: ${stderr}`)),
      CHILD_TIMEOUT_MS,
    );
    const inspect = () => {
      if (!stdout.split(/\r?\n/u).includes(expectedLine)) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout?.on("data", inspect);
    inspect();
  });
  try {
    await Promise.all([producedEvidence, exited]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export async function reproduceCompletedAutoRestoreContainment(options: {
  nodePath: string;
  lockModulePath: string;
  stateDir: string;
  sandboxName: string;
  processToken: string;
}): Promise<{ markerPath: string; timerPid: number }> {
  const markerPath = path.join(options.stateDir, `shields-timer-${options.sandboxName}.json`);
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
    options.nodePath,
    timerScript,
    [
      options.lockModulePath,
      options.stateDir,
      markerPath,
      options.sandboxName,
      options.processToken,
    ],
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
    options.nodePath,
    containmentScript,
    [options.lockModulePath, options.stateDir, options.sandboxName],
    "CONTAINED",
    "containment",
  );

  return {
    markerPath,
    timerPid: JSON.parse(fs.readFileSync(markerPath, "utf8")).pid as number,
  };
}
