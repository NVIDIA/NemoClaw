// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileRunPlans, renderPlanText, writePlanArtifacts } from "./compiler.ts";
import { ScenarioRunner } from "./orchestrators/runner.ts";
import { listScenarios } from "./registry.ts";
import { resolveRunnerForScenario } from "./runner-routing.ts";
import type { ScenarioDefinition } from "./types.ts";

interface Args {
  list: boolean;
  planOnly: boolean;
  dryRun: boolean;
  validateOnly: boolean;
  emitMatrix: boolean;
  scenarios: string[];
}

/**
 * Shape of a single GitHub Actions matrix `include` entry emitted by
 * `--emit-matrix`. The fields are kept short and JSON-stable so the consuming
 * workflow can reference them as `${{ matrix.id }}`, `${{ matrix.runner }}`,
 * etc. without further parsing.
 */
export interface ScenarioMatrixEntry {
  id: string;
  runner: string;
  label: string;
  platform: string;
  suites: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    list: false,
    planOnly: false,
    dryRun: false,
    validateOnly: false,
    emitMatrix: false,
    scenarios: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--emit-matrix") {
      args.emitMatrix = true;
      continue;
    }
    if (arg === "--plan-only") {
      args.planOnly = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--validate-only") {
      args.validateOnly = true;
      continue;
    }
    if (arg === "--scenarios") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--scenarios requires a comma-separated value");
      }
      args.scenarios = value.split(",").map((id) => id.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printList() {
  console.log("hybrid scenario registry");
  for (const scenario of listScenarios()) {
    console.log(`- ${scenario.id}${scenario.description ? `: ${scenario.description}` : ""}`);
  }
}

function buildLabel(scenario: ScenarioDefinition): string {
  const platform = scenario.environment?.platform ?? "unknown-platform";
  const suites = scenario.suiteIds ?? [];
  if (scenario.expectedFailure) {
    const cls = scenario.expectedFailure.errorClass ?? "expected-failure";
    return `${platform} \u00b7 ${scenario.id} \u00b7 expect-fail:${cls}`;
  }
  if (suites.length === 0) {
    return `${platform} \u00b7 ${scenario.id}`;
  }
  if (suites.length <= 3) {
    return `${platform} \u00b7 ${scenario.id} \u00b7 ${suites.join("+")}`;
  }
  return `${platform} \u00b7 ${scenario.id} \u00b7 ${suites.length} suites`;
}

/**
 * Build the GitHub Actions matrix for every scenario in the typed registry.
 * Sorted by id so workflow runs are deterministic and diffable.
 */
export function buildScenarioMatrix(): ScenarioMatrixEntry[] {
  return listScenarios().map((scenario): ScenarioMatrixEntry => {
    const { runner } = resolveRunnerForScenario(scenario);
    return {
      id: scenario.id,
      runner,
      label: buildLabel(scenario),
      platform: scenario.environment?.platform ?? "unknown",
      suites: scenario.suiteIds ?? [],
    };
  });
}

function emitMatrix() {
  // Single line so GHA's `$GITHUB_OUTPUT` can consume it via
  //   echo "matrix=$(npx tsx ... --emit-matrix)" >> "$GITHUB_OUTPUT"
  // without needing heredoc multi-line output handling.
  process.stdout.write(`${JSON.stringify(buildScenarioMatrix())}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    printList();
    return;
  }
  if (args.emitMatrix) {
    emitMatrix();
    return;
  }

  const modeCount = [args.planOnly, args.dryRun, args.validateOnly].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("Use exactly one of --plan-only, --dry-run, or --validate-only with --scenarios <id[,id...]>");
  }
  if (args.scenarios.length === 0) {
    throw new Error("scenario execution requires --scenarios <id[,id...]>");
  }

  if (process.env.E2E_SUITE_FILTER) {
    throw new Error("E2E_SUITE_FILTER is not supported; define assertion selection in scenario builders.");
  }

  const plans = compileRunPlans(args.scenarios);
  const contextDir = process.env.E2E_CONTEXT_DIR ?? process.cwd();
  writePlanArtifacts(plans, contextDir);
  console.log(renderPlanText(plans));

  if (args.dryRun) {
    const runner = new ScenarioRunner();
    for (const plan of plans) {
      await runner.run({ contextDir, dryRun: true }, plan);
    }
  }
}

// Only execute when invoked directly as a script. Importing this module from
// tests (e.g. `buildScenarioMatrix`) must not trigger the CLI side-effects.
// Compare via realpath so symlinked paths (e.g. `/tmp` -> `/private/tmp` on
// macOS) still resolve as equal.
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
