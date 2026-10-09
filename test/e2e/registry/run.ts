// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { E2eExecutionMetadata } from "../../../tools/e2e/execution-coverage.mts";
import {
  type E2eGatewayRuntime,
  type E2eGatewayRuntimeSupport,
  type E2eRuntimeProvider,
  e2eRuntimeProviders,
  runtimeCoverageVariant,
  runtimeExecutionId,
} from "../../../tools/e2e/gateway-runtime.mts";
import { liveTargetTimeoutContract } from "../../../tools/e2e/onboard-timeout-contract.mts";
import { liveTargetTestTitle, requireLiveTargetExecution } from "./execution.ts";
import { listTargets, requireTargets } from "./registry.ts";
import { resolveRunnerForTarget } from "./runner-routing.ts";
import type { TargetDefinition } from "./types.ts";

interface Args {
  list: boolean;
  emitLiveMatrix: boolean;
  targets: string[];
}

export interface LiveTargetMatrixEntry extends E2eExecutionMetadata {
  id: string;
  execution_id: string;
  runtime_provider: E2eRuntimeProvider;
  coverage_variant: string;
  runner: string;
  label: string;
  platform: string;
  install: string;
  runtime: string;
  onboarding: string;
  expectedStateId: string;
  suites: string[];
  requiredSecrets: string[];
  pendingRuntimeSuites: string[];
  timeout_minutes: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    list: false,
    emitLiveMatrix: false,
    targets: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--emit-live-matrix") {
      args.emitLiveMatrix = true;
      continue;
    }
    if (arg === "--targets") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--targets requires a comma-separated value");
      }
      args.targets = value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printList() {
  console.log("live E2E target registry");
  for (const target of listTargets()) {
    console.log(`- ${target.id}${target.description ? `: ${target.description}` : ""}`);
  }
}

function liveMatrixEntry(
  target: TargetDefinition,
  runtimeProvider: E2eRuntimeProvider,
): LiveTargetMatrixEntry {
  const { runner } = resolveRunnerForTarget(target);
  return {
    id: target.id,
    ...requireLiveTargetExecution(target),
    execution_id: runtimeExecutionId(target.id, "", runtimeProvider),
    runtime_provider: runtimeProvider,
    coverage_variant: runtimeCoverageVariant("", runtimeProvider),
    runner,
    label: `${liveTargetTestTitle(target)} [${runtimeProvider}]`,
    platform: target.environment.platform,
    install: target.environment.install,
    runtime: target.environment.runtime,
    onboarding: target.environment.onboarding,
    expectedStateId: target.expectedStateId,
    suites: target.suiteIds,
    requiredSecrets: target.requiredSecrets,
    pendingRuntimeSuites: target.suiteIds,
    timeout_minutes: liveTargetTimeoutContract(
      target.environment.lifecycle,
      target.configExport.expectation,
    ).targetTimeoutMinutes,
  };
}

export function liveTargetGatewayRuntimes(target: TargetDefinition): E2eGatewayRuntimeSupport {
  return target.gatewayRuntimes;
}

export function buildLiveTargetMatrix(
  ids: string[] = [],
  gatewayRuntimes: readonly E2eGatewayRuntime[] = ["docker"],
): LiveTargetMatrixEntry[] {
  const targets = ids.length === 0 ? listTargets() : requireTargets(ids);
  return targets.flatMap((target) =>
    e2eRuntimeProviders(liveTargetGatewayRuntimes(target), gatewayRuntimes).map((runtimeProvider) =>
      liveMatrixEntry(target, runtimeProvider),
    ),
  );
}

function emitLiveMatrix(ids: string[]) {
  // Single line so GHA's `$GITHUB_OUTPUT` can consume it via
  //   echo "matrix=$(npx tsx ... --emit-live-matrix)" >> "$GITHUB_OUTPUT"
  // without needing heredoc multi-line output handling.
  process.stdout.write(`${JSON.stringify(buildLiveTargetMatrix(ids))}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    printList();
    return;
  }
  if (args.emitLiveMatrix) {
    emitLiveMatrix(args.targets);
    return;
  }
  throw new Error("direct target execution is retired; use --emit-live-matrix for fan-out");
}

// Only execute when invoked directly as a script. Importing this module from
// tests must not trigger CLI side effects. Compare via realpath so symlinked
// paths (e.g. `/tmp` -> `/private/tmp` on macOS) still resolve as equal.
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
