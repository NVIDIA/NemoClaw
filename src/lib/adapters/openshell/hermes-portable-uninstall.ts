// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

export type HermesPortableUninstallOpenShellSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface HermesPortableUninstallOpenShellResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

/** Execute one authority-bound OpenShell command without interpreting its lifecycle result. */
export function runHermesPortableUninstallOpenShell(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  spawn: HermesPortableUninstallOpenShellSpawn = spawnSync,
): HermesPortableUninstallOpenShellResult {
  const result = spawn(executable, [...args], {
    encoding: "utf8",
    env,
    maxBuffer: 512 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error ? { error: result.error } : {}),
  };
}
