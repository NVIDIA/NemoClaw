// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";

import { createCliOpenShellProviderAdapter } from "../openshell/provider-adapter-cli";
import { dockerSpawnSync } from "../docker/exec";

export interface RunResult {
  status: number | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function toRunResult(result: SpawnSyncReturns<string | Buffer>): RunResult {
  return {
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

export function defaultRun(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): RunResult {
  return toRunResult(spawnSync(command, args, { encoding: "utf-8", ...options }));
}

export function defaultRunDocker(args: string[], options: SpawnSyncOptions = {}): RunResult {
  return toRunResult(dockerSpawnSync(args, { encoding: "utf-8", ...options }));
}

export function createUninstallProviderAdapter(run: typeof defaultRun, env: NodeJS.ProcessEnv) {
  return createCliOpenShellProviderAdapter({
    environment: env,
    run: (args, options) => run("openshell", args, { ...options, env }),
  });
}
