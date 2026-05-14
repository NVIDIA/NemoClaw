// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve a setup scenario into a concrete, fully-referenced execution plan.
 *
 * The resolver:
 *   1. looks up the scenario by id,
 *   2. resolves each dimension profile,
 *   3. resolves the expected state,
 *   4. resolves each suite definition,
 *   5. validates each suite's `requires_state` against the scenario's expected
 *      state (fail-fast if any key is missing or has an incompatible value).
 *
 * The resulting `ResolvedPlan` is serializable to JSON and forms the basis of
 * the `.e2e/plan.json` artifact and the human-readable plan printout.
 */

import type { ResolverInput } from "./load.ts";
import type {
  ResolvedPlan,
  ResolvedSuite,
  SuiteDefinition,
  ExpectedStateConfig,
} from "./schema.ts";

export type { ResolverInput } from "./load.ts";
export type { ResolvedPlan } from "./schema.ts";

function lookupProfile<T>(
  collection: Record<string, T>,
  kind: string,
  name: string,
  scenarioId: string,
): T {
  if (!(name in collection)) {
    const available = Object.keys(collection).sort().join(", ");
    throw new Error(
      `scenario '${scenarioId}' references unknown ${kind} '${name}' (available: ${available || "<none>"})`,
    );
  }
  return collection[name] as T;
}

function getByDottedPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function validateSuiteAgainstState(
  suiteId: string,
  suite: SuiteDefinition,
  state: ExpectedStateConfig,
  scenarioId: string,
): void {
  const requires = suite.requires_state ?? {};
  for (const [key, expected] of Object.entries(requires)) {
    const actual = getByDottedPath(state, key);
    if (actual === undefined) {
      throw new Error(
        `scenario '${scenarioId}' selects suite '${suiteId}' which requires state key '${key}=${String(expected)}', but the expected state has no value at '${key}'`,
      );
    }
    if (actual !== expected) {
      throw new Error(
        `scenario '${scenarioId}' selects suite '${suiteId}' which requires '${key}=${String(expected)}', but the scenario's expected state has '${key}=${String(actual)}'`,
      );
    }
  }
}

export function resolveScenario(scenarioId: string, meta: ResolverInput): ResolvedPlan {
  const scenarios = meta.scenarios.setup_scenarios;
  if (!(scenarioId in scenarios)) {
    const available = Object.keys(scenarios).sort().join(", ");
    throw new Error(
      `unknown scenario '${scenarioId}' (available: ${available || "<none>"})`,
    );
  }
  const sc = scenarios[scenarioId];
  const platform = lookupProfile(
    meta.scenarios.platforms,
    "platform",
    sc.dimensions.platform,
    scenarioId,
  );
  const install = lookupProfile(
    meta.scenarios.installs,
    "install",
    sc.dimensions.install,
    scenarioId,
  );
  const runtime = lookupProfile(
    meta.scenarios.runtimes,
    "runtime",
    sc.dimensions.runtime,
    scenarioId,
  );
  const onboarding = lookupProfile(
    meta.scenarios.onboarding,
    "onboarding",
    sc.dimensions.onboarding,
    scenarioId,
  );
  if (!(sc.expected_state in meta.expectedStates.expected_states)) {
    const available = Object.keys(meta.expectedStates.expected_states).sort().join(", ");
    throw new Error(
      `scenario '${scenarioId}' references unknown expected_state '${sc.expected_state}' (available: ${available || "<none>"})`,
    );
  }
  const stateConfig = meta.expectedStates.expected_states[sc.expected_state];
  const resolvedSuites: ResolvedSuite[] = [];
  for (const suiteId of sc.suites) {
    if (!(suiteId in meta.suites.suites)) {
      const available = Object.keys(meta.suites.suites).sort().join(", ");
      throw new Error(
        `scenario '${scenarioId}' references unknown suite '${suiteId}' (available: ${available || "<none>"})`,
      );
    }
    const def = meta.suites.suites[suiteId];
    validateSuiteAgainstState(suiteId, def, stateConfig, scenarioId);
    resolvedSuites.push({
      id: suiteId,
      requires_state: def.requires_state ?? {},
      steps: def.steps.map((s) => ({ id: s.id, script: s.script })),
    });
  }
  return {
    scenario_id: scenarioId,
    dimensions: {
      platform: { id: sc.dimensions.platform, profile: platform },
      install: { id: sc.dimensions.install, profile: install },
      runtime: { id: sc.dimensions.runtime, profile: runtime },
      onboarding: { id: sc.dimensions.onboarding, profile: onboarding },
    },
    expected_state: { id: sc.expected_state, config: stateConfig },
    suites: resolvedSuites,
    overrides: sc.overrides,
    runner_requirements: sc.runner_requirements,
  };
}

export function formatPlan(plan: ResolvedPlan): string {
  const lines: string[] = [];
  lines.push(`Scenario: ${plan.scenario_id}`);
  lines.push("Dimensions:");
  lines.push(`  platform=${plan.dimensions.platform.id}`);
  lines.push(`  install=${plan.dimensions.install.id}`);
  lines.push(`  runtime=${plan.dimensions.runtime.id}`);
  lines.push(`  onboarding=${plan.dimensions.onboarding.id}`);
  lines.push(`Expected state: ${plan.expected_state.id}`);
  lines.push("Suites:");
  for (const s of plan.suites) {
    lines.push(`  - ${s.id}`);
    for (const step of s.steps) {
      lines.push(`      * ${step.id} (${step.script})`);
    }
  }
  if (plan.runner_requirements && plan.runner_requirements.length > 0) {
    lines.push("Runner requirements:");
    for (const requirement of plan.runner_requirements) {
      lines.push(`  - ${requirement}`);
    }
  }
  if (plan.overrides) {
    lines.push("Overrides:");
    lines.push(`  ${JSON.stringify(plan.overrides)}`);
  }
  return lines.join("\n");
}
