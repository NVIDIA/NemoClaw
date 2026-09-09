// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";

import { dockerSpawnSync } from "../../adapters/docker/exec";
import { createManagedProviderAdapter } from "../../adapters/openshell/managed-provider-adapter";
import { providerDeleteSkipMessage } from "../../domain/uninstall/messaging";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function toRunResult(result: SpawnSyncReturns<string | Buffer>): RunResult {
  return {
    status: result.status,
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

export async function deleteUninstallProviders(
  providers: readonly string[],
  runtime: {
    env: NodeJS.ProcessEnv;
    run: typeof defaultRun;
    log: (message: string) => void;
    warn: (message: string) => void;
  },
): Promise<void> {
  const adapter = createManagedProviderAdapter(
    (args, options) => runtime.run("openshell", args, { ...options, env: runtime.env }),
    { environment: runtime.env },
  );
  for (const providerName of providers) {
    const result = await adapter.deleteProvider({ target: { kind: "selected" }, providerName });
    if (result.ok) runtime.log(`Deleted provider '${providerName}'`);
    else runtime.warn(providerDeleteSkipMessage(providerName));
  }
}
