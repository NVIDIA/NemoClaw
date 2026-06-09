// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileRunPlans, renderPlanText, writePlanArtifacts } from "./compiler.ts";
import { ScenarioRunner } from "./orchestrators/runner.ts";
import { listScenarios } from "./registry.ts";
import { resolveRunnerForScenario } from "./runner-routing.ts";
import type { PhaseResult, ScenarioDefinition } from "./types.ts";

interface Args {
  list: boolean;
  emitMatrix: boolean;
  planOnly: boolean;
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
  const args: Args = { list: false, emitMatrix: false, planOnly: false, scenarios: [] };
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
  // Consumed by the dynamic matrix workflow (PR #4359).
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

  if (args.planOnly) {
    // Local debug only. Workflows must not pass --plan-only.
    return;
  }

  const runner = new ScenarioRunner();
  const allResults: PhaseResult[] = [];
  let anyFailed = false;
  for (const plan of plans) {
    const results = await runner.run({ contextDir }, plan);
    allResults.push(...results);
    if (planFailed(plan, results)) {
      anyFailed = true;
    }
  }

  // Surface a compact run summary so phase results don't have to be opened
  // to see what passed.
  console.log("");
  console.log("Phase results:");
  for (const result of allResults) {
    const counts = result.assertions.reduce(
      (acc, assertion) => {
        acc[assertion.status] = (acc[assertion.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    const detail = Object.entries(counts)
      .map(([status, count]) => `${status}=${count}`)
      .join(" ");
    console.log(`  ${result.phase}: ${result.status} (${detail || "no steps"})`);
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
}

// A scenario fails iff:
//   positive (no expectedFailure): any phase result failed.
//   negative (expectedFailure declared): the synthetic
//     negative-contract phase did not match, OR state-validation
//     did not prove the declared forbidden side effects stayed absent.
//
// The matcher decides exit code for negatives so that a scenario
// that failed for the right reason in the right phase is no longer
// reported as red just because setup did not complete. Forbidden
// side effects stay visible through the typed state-validation probes.
function forbiddenSideEffectProbeId(sideEffect: string): string {
  if (sideEffect === "gateway-started") {
    return "state-validation.gateway-absent";
  }
  if (sideEffect === "sandbox-created") {
    return "state-validation.sandbox-absent";
  }
  return `state-validation.${sideEffect}`;
}

export function planFailed(plan: import("./types.ts").RunPlan, results: PhaseResult[]): boolean {
  if (!plan.expectedFailure) {
    return results.some((result) => result.status === "failed");
  }
  const contractPhase = results.find((result) => result.phase === "negative-contract");
  if (!contractPhase || contractPhase.status !== "passed") {
    return true;
  }
  const requiredSideEffectProbes = (plan.expectedFailure.forbiddenSideEffects ?? []).map(forbiddenSideEffectProbeId);
  if (requiredSideEffectProbes.length === 0) {
    return false;
  }
  const stateValidation = results.find((result) => result.phase === "state-validation");
  if (!stateValidation || stateValidation.status !== "passed") {
    return true;
  }
  const passedActionIds = new Set(
    stateValidation.actions.filter((action) => action.status === "passed").map((action) => action.id),
  );
  return requiredSideEffectProbes.some((id) => !passedActionIds.has(id));
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
