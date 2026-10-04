// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as childProcess from "node:child_process";
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import * as nodeUtil from "node:util";
import { promisify } from "node:util";

declare const require: {
  (specifier: "node:child_process"): typeof childProcess;
  (specifier: "node:util"): typeof nodeUtil;
};
const aliasedSpawn = childProcess.spawn;
const requiredChildProcess = require("node:child_process");
const { spawn: requiredSpawn } = require("node:child_process");
const reassignedChildProcess = childProcess;
let assignmentChildProcess: typeof childProcess;
assignmentChildProcess = childProcess;
const { spawn: namespaceDestructuredSpawn } = reassignedChildProcess;
let assignmentDestructuredExecFile = childProcess.execFile;
({ execFile: assignmentDestructuredExecFile } = assignmentChildProcess);
const boundSpawn = childProcess.spawn.bind(childProcess);
const boundSpawnSync = childProcess.spawnSync.bind(childProcess);
const extractedSpawnBinder = spawn.bind;
const preappliedSpawnSync = spawnSync.bind(null, "preapplied-child", []);
const conditionalSpawnSync = Math.random() > 0.5 ? spawnSync : childProcess.spawnSync;
let conflictingSyncAlias = spawnSync;
conflictingSyncAlias = execFileSync as unknown as typeof spawnSync;
const promisedExec = promisify(exec);
const promisedExecFile = nodeUtil.promisify(execFile);
const requireAlias = require;
const dynamicallyImportedChildProcess = await import("node:child_process");

type ProgressProbe = {
  activity(label: string): () => void;
  onOutput(event: { stream: "stdout" | "stderr"; atMs: number }): void;
};

export function silentAsyncChild(): void {
  spawn("silent-child", [], { stdio: ["ignore", "pipe", "pipe"] });
}

export function observedAsyncChild(progress: ProgressProbe): void {
  const finishActivity = progress.activity("command: observed-child");
  const child = spawn("observed-child", [], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", () => progress.onOutput({ stream: "stdout", atMs: Date.now() }));
  child.stderr?.on("data", () => progress.onOutput({ stream: "stderr", atMs: Date.now() }));
  child.once("close", finishActivity);
}

export function ignoredAsyncChild(progress: ProgressProbe): void {
  const finishActivity = progress.activity("command: ignored-child");
  const child = spawn("ignored-child", [], { stdio: "ignore" });
  child.once("close", finishActivity);
}

export function namespaceAsyncChild(): void {
  childProcess.spawn("namespace-child", [], { stdio: "ignore" });
}

export function aliasedAsyncChild(): void {
  aliasedSpawn("aliased-child", [], { stdio: "ignore" });
}

export function requiredNamespaceAsyncChild(): void {
  requiredChildProcess.spawn("required-namespace-child", [], { stdio: "ignore" });
}

export function requiredDestructuredAsyncChild(): void {
  requiredSpawn("required-destructured-child", [], { stdio: "ignore" });
}

export function reassignedNamespaceAsyncChild(): void {
  reassignedChildProcess.spawn("reassigned-namespace-child", [], { stdio: "ignore" });
}

export function namespaceDestructuredAsyncChild(): void {
  namespaceDestructuredSpawn("namespace-destructured-child", [], { stdio: "ignore" });
}

export function assignmentAliasAsyncChild(): void {
  assignmentChildProcess.spawn("assignment-namespace-child", [], { stdio: "ignore" });
  assignmentDestructuredExecFile("assignment-destructured-child", [], () => undefined);
}

export function nestedRequiredAsyncChild(): void {
  const { execFile: nestedExecFile } = require("node:child_process");
  nestedExecFile("nested-required-child", [], () => undefined);
}

export function directNestedRequiredAsyncChild(): void {
  require("node:child_process").fork("direct-required-child");
}

export function boundAsyncChild(): void {
  boundSpawn("bound-child", [], { stdio: "ignore" });
}

export function inlineBoundAsyncChild(): void {
  childProcess.execFile.bind(childProcess)("inline-bound-child", [], () => undefined);
}

export function promisedAsyncChildren(): void {
  void promisedExec("promised-exec-child");
  void promisedExecFile("promised-exec-file-child");
  void require("node:util").promisify(require("node:child_process").exec)(
    "required-promised-child",
  );
}

export function aliasedLoaderAsyncChildren(): void {
  requireAlias("node:child_process").spawn("aliased-required-child", [], { stdio: "ignore" });
  dynamicallyImportedChildProcess.spawn("dynamically-imported-child", [], { stdio: "ignore" });
}

export function extractedBindAsyncChild(): void {
  (extractedSpawnBinder as unknown as (receiver: null) => typeof spawn)(null)(
    "extracted-bind-child",
    [],
    { stdio: "ignore" },
  );
}

export function computedNamespaceEscape(method: string): void {
  const candidate = (childProcess as unknown as Record<string, unknown>)[method];
  if (typeof candidate === "function") candidate("computed-child");
}

export function passedApiEscape(consume: (value: unknown) => void): void {
  consume(childProcess.spawn);
}

export function storedApiEscapes(): void {
  const shorthand = { spawn };
  const property = { runner: execFile };
  const spread = { ...childProcess };
  const array = [spawnSync];
  void [shorthand, property, spread, array];
}

export function unsupportedNamespaceMember(): void {
  void childProcess.ChildProcess;
  const { ChildProcess } = childProcess;
  void ChildProcess;
}

export function unboundedSyncChild(): void {
  spawnSync("unbounded-child", []);
}

export function boundedSyncChild(): void {
  spawnSync("bounded-child", [], { killSignal: "SIGKILL", timeout: 1_000 });
}

export function zeroTimeoutSyncChild(): void {
  spawnSync("zero-timeout-child", [], { killSignal: "SIGKILL", timeout: 0 });
}

export function undefinedTimeoutSyncChild(): void {
  spawnSync("undefined-timeout-child", [], { killSignal: "SIGKILL", timeout: undefined });
}

export function heartbeatLengthTimeoutSyncChild(): void {
  spawnSync("heartbeat-timeout-child", [], { killSignal: "SIGKILL", timeout: 5 * 60_000 });
}

export function missingHardKillSyncChild(): void {
  spawnSync("missing-hard-kill-child", [], { timeout: 1_000 });
}

export function softKillSyncChild(): void {
  spawnSync("soft-kill-child", [], { killSignal: "SIGTERM", timeout: 1_000 });
}

export function undefinedKillSyncChild(): void {
  spawnSync("undefined-kill-child", [], { killSignal: undefined, timeout: 1_000 });
}

export function otherBoundedSyncChildren(): void {
  execSync("bounded-exec", { killSignal: "SIGKILL", timeout: 1_000 });
  execFileSync("bounded-exec-file", [], { killSignal: "SIGKILL", timeout: 1_000 });
  boundSpawnSync("bounded-bound-spawn", [], { killSignal: "SIGKILL", timeout: 1_000 });
}

export function decoyAndPreappliedSyncOptions(): void {
  (spawnSync as unknown as (...args: unknown[]) => unknown)(
    "decoy-child",
    [],
    { killSignal: "SIGTERM", timeout: 0 },
    { killSignal: "SIGKILL", timeout: 1_000 },
  );
  (execFileSync as unknown as (...args: unknown[]) => unknown)(
    "misplaced-options-child",
    { killSignal: "SIGTERM", timeout: 0 },
    { killSignal: "SIGKILL", timeout: 1_000 },
  );
  preappliedSpawnSync({ killSignal: "SIGKILL", timeout: 1_000 });
  conditionalSpawnSync("conditional-child", [], {
    killSignal: "SIGKILL",
    timeout: 1_000,
  });
}

export function conflictingReassignmentSyncOptions(): void {
  conflictingSyncAlias("conflicting-child", [], {
    killSignal: "SIGKILL",
    timeout: 1_000,
  });
}

export function spreadSyncOptions(): void {
  const overrides: Record<string, unknown> = { killSignal: "SIGTERM", timeout: 0 };
  spawnSync("unsafe-spread-child", [], {
    killSignal: "SIGKILL",
    timeout: 1_000,
    ...overrides,
  });
  spawnSync("safe-spread-child", [], {
    ...overrides,
    killSignal: "SIGKILL",
    timeout: 1_000,
  });
}
