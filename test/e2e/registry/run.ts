// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { E2eAgentRuntime } from "../../../tools/e2e/execution-coverage.mts";

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

export interface LiveTargetMatrixEntry {
  id: string;
  agentRuntime: E2eAgentRuntime;
  observableOutcome: string;
  environmentOrInferenceEndpoint: string;
  unresolvedReason: string;
  runner: string;
  label: string;
  platform: string;
  install: string;
  runtime: string;
  onboarding: string;
  expectedStateId: string;
  suites: string[];
  requiredSecrets: string[];
  supported: boolean;
  supportReasons: string[];
  pendingRuntimeSuites: string[];
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
): LiveTargetMatrixEntry {
  const { runner } = resolveRunnerForTarget(target);
  const executionCoverage = liveTargetExecutionCoverage(target, support);
  return {
    id: target.id,
    ...executionCoverage,
    runner,
    label: liveTargetTestTitle(target, support),
    platform: target.environment?.platform ?? "unknown",
    install: target.environment?.install ?? "unknown",
    runtime: target.environment?.runtime ?? "unknown",
    onboarding: target.environment?.onboarding ?? "unknown",
    expectedStateId: target.expectedStateId ?? "",
    suites: target.suiteIds ?? [],
    requiredSecrets: target.requiredSecrets ?? [],
    supported: support.supported,
    supportReasons: support.reasons,
    pendingRuntimeSuites: support.pendingRuntimeSuites,
  };
}

export function buildLiveTargetInventory(): LiveTargetMatrixEntry[] {
  return listTargets().map((target) => liveMatrixEntry(target, liveTargetSupport(target)));
}

export function buildLiveTargetMatrix(ids: string[] = []): LiveTargetMatrixEntry[] {
  if (ids.length === 0) {
    return buildLiveTargetInventory().filter((entry) => entry.supported);
  }
  return requireTargets(ids).map((target) => liveMatrixEntry(target, liveTargetSupport(target)));
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
