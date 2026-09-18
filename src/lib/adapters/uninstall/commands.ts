// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";

import { createCliOpenShellGatewayLifecycleFromRunner } from "../openshell/gateway-lifecycle-cli";
import { createCliOpenShellGatewayReuseObserver } from "../openshell/gateway-reuse-cli";
import { createCliOpenShellProviderAdapter } from "../openshell/provider-adapter-cli";
import {
  createCliOpenShellSandboxLifecycleFromRunner,
  createCliOpenShellSandboxLookupFromRunner,
  createCliOpenShellSandboxObserverFromRunner,
} from "../openshell/sandbox-lifecycle-cli";
import { dockerSpawnSync } from "../docker/exec";
import { buildSubprocessEnvFrom } from "../../subprocess-env";

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

export function createUninstallGatewayLifecycle(run: typeof defaultRun, env: NodeJS.ProcessEnv) {
  return createCliOpenShellGatewayLifecycleFromRunner((args, options) =>
    run("openshell", args, { ...options, env }),
  );
}

export function createUninstallSandboxLifecycle(run: typeof defaultRun, env: NodeJS.ProcessEnv) {
  const childEnv = buildSubprocessEnvFrom(env);
  return createCliOpenShellSandboxLifecycleFromRunner(
    (args, options) => run("openshell", args, { env: childEnv, ...options }),
    { environment: env },
  );
}

export function createUninstallSandboxLookup(run: typeof defaultRun, env: NodeJS.ProcessEnv) {
  const childEnv = buildSubprocessEnvFrom(env);
  return createCliOpenShellSandboxLookupFromRunner((args, options) =>
    run("openshell", args, { env: childEnv, ...options }),
  );
}

export function createUninstallSandboxObserver(run: typeof defaultRun, env: NodeJS.ProcessEnv) {
  const childEnv = buildSubprocessEnvFrom(env);
  return createCliOpenShellSandboxObserverFromRunner((args, options) =>
    run("openshell", args, { env: childEnv, ...options }),
  );
}

export function createUninstallGatewayReuseObserver(
  run: typeof defaultRun,
  env: NodeJS.ProcessEnv,
) {
  return createCliOpenShellGatewayReuseObserver((args, options) => {
    const result = run("openshell", args, { ...options, env });
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  }, env);
}
