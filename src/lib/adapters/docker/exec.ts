// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type ExecFileSyncOptionsWithStringEncoding,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { hostContainerEngineArgv } from "../container-engine";

export type DockerExecFileSyncOptions = Omit<ExecFileSyncOptionsWithStringEncoding, "encoding">;
export type DockerSpawnSyncOptions = Parameters<typeof spawnSync>[2];
export type DockerSpawnSyncResult = ReturnType<typeof spawnSync>;

export function dockerExecFileSync(
  args: readonly string[],
  opts: DockerExecFileSyncOptions = {},
): string {
  const [command, ...commandArgs] = hostContainerEngineArgv(args);
  return String(execFileSync(command, commandArgs, { encoding: "utf-8", ...opts }));
}

export function dockerSpawnSync(
  args: readonly string[],
  opts: DockerSpawnSyncOptions = {},
): DockerSpawnSyncResult {
  const [command, ...commandArgs] = hostContainerEngineArgv(args);
  return spawnSync(command, commandArgs, opts);
}

export function dockerSpawn(
  args: readonly string[],
  opts: Parameters<typeof spawn>[2] = {},
): ReturnType<typeof spawn> {
  const [command, ...commandArgs] = hostContainerEngineArgv(args);
  return spawn(command, commandArgs, opts);
}
