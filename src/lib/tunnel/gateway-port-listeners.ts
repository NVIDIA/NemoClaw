// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";

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
  // `command` is an internal literal ("lsof"), never user supplied.
  return (
    defaultGatewayReleaseRun(
      "sh",
      ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`],
      { env },
    ).status === 0
  );
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
