// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";

type ProcessTreeTimeoutDeps = {
  platform?: NodeJS.Platform;
  timeoutExecutableExists?: (pathname: string) => boolean;
};

export type ProcessTreeTimeoutOptions = {
  killProcessTreeOnTimeout?: boolean;
  killSignal?: SpawnSyncOptions["killSignal"];
  timeout?: number;
};

/**
 * #10238 ownership decision: NemoClaw owns the wall-clock bound at its
 * synchronous OpenShell adapter boundary. This remains opt-in for lifecycle
 * probes; ordinary commands keep their existing execution behavior. Linux uses
 * a process-group timeout so descendants cannot retain captured pipes after the
 * direct CLI is killed. Real DGX Spark confirmation remains tracked by #10238.
 */
export function processTreeBoundedOpenshellInvocation(
  binary: string,
  args: readonly string[],
  opts: ProcessTreeTimeoutOptions,
  deps: ProcessTreeTimeoutDeps = {},
): { binary: string; args: string[]; killSignal?: SpawnSyncOptions["killSignal"] } {
  if (opts.killProcessTreeOnTimeout !== true) {
    return { binary, args: [...args], killSignal: opts.killSignal };
  }
  const timeoutMs = Number(opts.timeout);
  const platform = deps.platform ?? process.platform;
  const timeoutExecutableExists = deps.timeoutExecutableExists ?? fs.existsSync;
  if (
    platform !== "linux" ||
    !timeoutExecutableExists("/usr/bin/timeout") ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return { binary, args: [...args], killSignal: "SIGKILL" };
  }
  const groupTimeoutSeconds = Math.max(1, Math.floor(timeoutMs) - 250) / 1000;
  return {
    binary: "/usr/bin/timeout",
    args: ["--signal=KILL", `${String(groupTimeoutSeconds)}s`, binary, ...args],
    killSignal: "SIGKILL",
  };
}
