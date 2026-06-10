// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { listScenarios, requireScenarios } from "./registry.ts";
import { resolveRunnerForScenario } from "./runner-routing.ts";
import { type LiveScenarioSupport, liveScenarioSupport } from "./runtime-support.ts";
import type { ScenarioDefinition } from "./types.ts";

interface Args {
  list: boolean;
  emitLiveMatrix: boolean;
  scenarios: string[];
}

export interface LiveScenarioMatrixEntry {
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
    scenarios: [],
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
    if (arg === "--scenarios") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--scenarios requires a comma-separated value");
      }
      args.scenarios = value
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
  console.log("live Vitest scenario registry");
  for (const scenario of listScenarios()) {
    console.log(`- ${scenario.id}${scenario.description ? `: ${scenario.description}` : ""}`);
  }
}

function buildLabel(scenario: ScenarioDefinition): string {
  const platform = scenario.environment?.platform ?? "unknown-platform";
  const suites = scenario.suiteIds ?? [];
  if (scenario.expectedFailure) {
    const cls = scenario.expectedFailure.errorClass ?? "expected-failure";
    return `${platform} · ${scenario.id} · expect-fail:${cls}`;
  }
  if (suites.length === 0) {
    return `${platform} · ${scenario.id}`;
  }
  if (suites.length <= 3) {
    return `${platform} · ${scenario.id} · ${suites.join("+")}`;
  }
  return `${platform} · ${scenario.id} · ${suites.length} suites`;
}

function liveMatrixEntry(
  scenario: ScenarioDefinition,
  support: LiveScenarioSupport,
): LiveScenarioMatrixEntry {
  const { runner } = resolveRunnerForScenario(scenario);
  return {
    id: scenario.id,
    runner,
    label: buildLabel(scenario),
    platform: scenario.environment?.platform ?? "unknown",
    install: scenario.environment?.install ?? "unknown",
    runtime: scenario.environment?.runtime ?? "unknown",
    onboarding: scenario.environment?.onboarding ?? "unknown",
    expectedStateId: scenario.expectedStateId ?? "",
    suites: scenario.suiteIds ?? [],
    requiredSecrets: scenario.requiredSecrets ?? [],
    supported: support.supported,
    supportReasons: support.reasons,
    pendingRuntimeSuites: support.pendingRuntimeSuites,
  };
}

export function buildLiveScenarioMatrix(ids: string[] = []): LiveScenarioMatrixEntry[] {
  const scenarioSupport = (ids.length > 0 ? requireScenarios(ids) : listScenarios()).map(
    (scenario) => ({
      scenario,
      support: liveScenarioSupport(scenario),
    }),
  );
  const liveEntries =
    ids.length > 0 ? scenarioSupport : scenarioSupport.filter(({ support }) => support.supported);
  return liveEntries.map(({ scenario, support }) => liveMatrixEntry(scenario, support));
}

function emitLiveMatrix(ids: string[]) {
  // Single line so GHA's `$GITHUB_OUTPUT` can consume it via
  //   echo "matrix=$(npx tsx ... --emit-live-matrix)" >> "$GITHUB_OUTPUT"
  // without needing heredoc multi-line output handling.
  process.stdout.write(`${JSON.stringify(buildLiveScenarioMatrix(ids))}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    printList();
    return;
  }
  if (args.emitLiveMatrix) {
    emitLiveMatrix(args.scenarios);
    return;
  }
  throw new Error("scenario execution is retired; use --emit-live-matrix for Vitest fan-out");
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
