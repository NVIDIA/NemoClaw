// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { isTestProgressCapability, type TestProgressCapability } from "./progress.ts";

export interface ChildProcessProgress extends TestProgressCapability {
  activity(label: string): (() => void) | void;
  onOutput(event: { stream: "stdout" | "stderr"; atMs: number }): void;
}

export interface ObservedChildProcessOptions {
  activityLabel: string;
  progress: ChildProcessProgress;
  spawn: SpawnOptions;
}

/**
 * The single direct asynchronous child-process boundary used by live E2E code.
 * It owns content-free activity and timestamp-only output observation so a
 * caller cannot accidentally start a silent subprocess.
 */
export function spawnObservedChild(
  command: string,
  args: readonly string[],
  options: ObservedChildProcessOptions,
): ChildProcess {
  if (!isTestProgressCapability(options.progress)) {
    throw new TypeError("observed child processes require the canonical E2E progress capability");
  }
  let finishActivity: () => void = () => undefined;
  try {
    finishActivity = options.progress.activity(options.activityLabel) ?? finishActivity;
  } catch {
    // Progress diagnostics must never change process execution.
  }

  let child: ChildProcess;
  try {
    child = spawn(command, [...args], options.spawn);
  } catch (error) {
    try {
      finishActivity();
    } catch {
      // Progress diagnostics must never replace the spawn failure.
    }
    throw error;
  }

  child.stdout?.on("data", () => {
    try {
      options.progress.onOutput({ stream: "stdout", atMs: Date.now() });
    } catch {
      // Child contents never cross this timestamp-only observer boundary.
    }
  });
  child.stderr?.on("data", () => {
    try {
      options.progress.onOutput({ stream: "stderr", atMs: Date.now() });
    } catch {
      // Child contents never cross this timestamp-only observer boundary.
    }
  });
  child.once("close", () => {
    try {
      finishActivity();
    } catch {
      // Progress diagnostics must never change process completion.
    }
  });
  return child;
}
