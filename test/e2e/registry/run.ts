// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { E2eExecutionMetadata } from "../../../tools/e2e/execution-coverage.mts";
import { liveTargetTimeoutContract } from "../../../tools/e2e/onboard-timeout-contract.mts";
import {
  type E2eGatewayRuntime,
  type E2eGatewayRuntimeSupport,
  type E2eRuntimeProvider,
  e2eRuntimeProviders,
  runtimeCoverageVariant,
  runtimeExecutionId,
} from "../../../tools/e2e/gateway-runtime.mts";

import { listTargets, requireTargets } from "./registry.ts";
import { resolveRunnerForTarget } from "./runner-routing.ts";
import {
  liveTargetExecutionCoverage,
  type LiveTargetSupport,
  liveTargetSupport,
  liveTargetTestTitle,
} from "./runtime-support.ts";
import type { TargetDefinition } from "./types.ts";

interface Args {
  list: boolean;
  emitLiveMatrix: boolean;
  targets: string[];
}

export interface LiveTargetInventoryEntry extends E2eExecutionMetadata {
  id: string;
  supported: boolean;
  supportReasons: string[];
}

export interface LiveTargetMatrixEntry extends LiveTargetInventoryEntry {
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
  support: LiveTargetSupport,
  runtimeProvider: E2eRuntimeProvider,
): LiveTargetMatrixEntry {
  const { runner } = resolveRunnerForTarget(target);
  return {
    ...liveTargetInventoryEntry(target, support),
    execution_id: runtimeExecutionId(target.id, "", runtimeProvider),
    runtime_provider: runtimeProvider,
    coverage_variant: runtimeCoverageVariant("", runtimeProvider),
    runner,
    label: `${liveTargetTestTitle(target, support)} [${runtimeProvider}]`,
    platform: target.environment?.platform ?? "unknown",
    install: target.environment?.install ?? "unknown",
    runtime: target.environment?.runtime ?? "unknown",
    onboarding: target.environment?.onboarding ?? "unknown",
    expectedStateId: target.expectedStateId ?? "",
    suites: target.suiteIds ?? [],
    requiredSecrets: target.requiredSecrets ?? [],
    pendingRuntimeSuites: support.pendingRuntimeSuites,
    timeout_minutes: liveTargetTimeoutContract(target.environment?.lifecycle).targetTimeoutMinutes,
  };
}

export function liveTargetInventoryEntry(
  target: TargetDefinition,
  support = liveTargetSupport(target),
): LiveTargetInventoryEntry {
  return {
    id: target.id,
    ...liveTargetExecutionCoverage(target, support),
    supported: support.supported,
    supportReasons: support.reasons,
  };
}

export function buildLiveTargetInventory(): LiveTargetInventoryEntry[] {
  return listTargets().map((target) => liveTargetInventoryEntry(target));
}

export function liveTargetGatewayRuntimes(target: TargetDefinition): E2eGatewayRuntimeSupport {
  return target.gatewayRuntimes ?? ["docker"];
}

export function buildLiveTargetMatrix(
  ids: string[] = [],
  gatewayRuntimes: readonly E2eGatewayRuntime[] = ["docker"],
): LiveTargetMatrixEntry[] {
  if (ids.length === 0) {
    return listTargets().flatMap((target) => {
      const support = liveTargetSupport(target);
      return support.supported
        ? e2eRuntimeProviders(liveTargetGatewayRuntimes(target), gatewayRuntimes).map(
            (runtimeProvider) => liveMatrixEntry(target, support, runtimeProvider),
          )
        : [];
    });
  }
  return requireTargets(ids).flatMap((target) =>
    e2eRuntimeProviders(liveTargetGatewayRuntimes(target), gatewayRuntimes).map((runtimeProvider) =>
      liveMatrixEntry(target, liveTargetSupport(target), runtimeProvider),
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
