// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { listTargets, requireTargets } from "./registry.ts";
import { resolveRunnerForTarget } from "./runner-routing.ts";
import { type LiveTargetSupport, liveTargetSupport } from "./runtime-support.ts";
import type { TargetDefinition } from "./types.ts";

interface Args {
  list: boolean;
  emitLiveMatrix: boolean;
  targets: string[];
}

export interface LiveTargetMatrixEntry {
  id: string;
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

function buildLabel(target: TargetDefinition): string {
  const platform = target.environment?.platform ?? "unknown-platform";
  const suites = target.suiteIds ?? [];
  if (target.expectedFailure) {
    const cls = target.expectedFailure.errorClass ?? "expected-failure";
    return `${platform} · ${target.id} · expect-fail:${cls}`;
  }
  if (suites.length === 0) {
    return `${platform} · ${target.id}`;
  }
  if (suites.length <= 3) {
    return `${platform} · ${target.id} · ${suites.join("+")}`;
  }
  return `${platform} · ${target.id} · ${suites.length} suites`;
}

function liveMatrixEntry(
  target: TargetDefinition,
  support: LiveTargetSupport,
): LiveTargetMatrixEntry {
  const { runner } = resolveRunnerForTarget(target);
  return {
    id: target.id,
    runner,
    label: buildLabel(target),
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

export function buildLiveTargetMatrix(ids: string[] = []): LiveTargetMatrixEntry[] {
  const targetSupport = (ids.length > 0 ? requireTargets(ids) : listTargets()).map((target) => ({
    target,
    support: liveTargetSupport(target),
  }));
  const liveEntries =
    ids.length > 0 ? targetSupport : targetSupport.filter(({ support }) => support.supported);
  return liveEntries.map(({ target, support }) => liveMatrixEntry(target, support));
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
