// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

export type DockerExecFileSyncOptions = Omit<ExecFileSyncOptionsWithStringEncoding, "encoding">;
export type DockerSpawnSyncOptions = Parameters<typeof spawnSync>[2];
export type DockerSpawnSyncResult = ReturnType<typeof spawnSync>;

export function dockerExecFileSync(
  args: readonly string[],
  opts: DockerExecFileSyncOptions = {},
): string {
  return String(execFileSync("docker", [...args], { encoding: "utf-8", ...opts }));
}

export function dockerSpawnSync(
  args: readonly string[],
  opts: DockerSpawnSyncOptions = {},
): DockerSpawnSyncResult {
  return spawnSync("docker", [...args], opts);
}
