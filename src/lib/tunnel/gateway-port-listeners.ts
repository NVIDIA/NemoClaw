// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { HostGatewayProcessDeps, RunResult } from "../onboard/host-gateway-process";

export function defaultGatewayReleaseRun(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): RunResult {
  const result = spawnSync(command, args, { encoding: "utf-8", ...options });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

export function defaultGatewayReleaseCommandExists(
  command: string,
  env: NodeJS.ProcessEnv,
): boolean {
  // Resolve the internal literal (currently only "lsof") directly from PATH.
  // Ignore empty entries instead of treating the working directory as trusted.
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        fs.accessSync(path.join(directory, command), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

export function listeningGatewayPids(
  port: number,
  run: NonNullable<HostGatewayProcessDeps["run"]>,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): number[] | null {
  const result = run("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { env });
  if (result.status !== 0 && result.status !== 1) {
    const detail = result.stderr.trim() || `status ${String(result.status)}`;
    warn(`lsof failed while scanning gateway port ${port}: ${detail}`);
    return null;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
