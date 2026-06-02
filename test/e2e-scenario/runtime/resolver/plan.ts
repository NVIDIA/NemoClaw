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
  BaseScenario,
  ResolvedPlan,
  ResolvedSuite,
  SuiteDefinition,
  ExpectedFailure,
  ExpectedStateConfig,
  TestPlan,
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

/**
 * Merge a state-level `expected_failure` with an optional scenario-level
 * override and return a fully-formed `ExpectedFailure`, or `undefined` if
 * neither side declares one. Scenario-level fields win over state-level.
 *
 * After merge, every required field MUST be present. The loader already
 * enforces this for state-level blocks; an override-only declaration on a
 * positive expected state is rejected here.
 */
function resolveExpectedFailure(
  stateConfig: ExpectedStateConfig,
  expectedStateId: string,
  scenarioId: string,
  overrides: Array<{
    block?: Partial<ExpectedFailure>;
    mode: "fill" | "override";
    origin: string;
  }>,
): ExpectedFailure | undefined {
  const stateBlock = (stateConfig as { expected_failure?: unknown }).expected_failure as
    | Partial<ExpectedFailure>
    | undefined;
  const presentOverrides = overrides.filter((source) => source.block);
  if (!stateBlock && presentOverrides.length === 0) return undefined;
  if (!stateBlock) {
    const origins = presentOverrides.map((source) => source.origin).join(", ");
    throw new Error(
      `scenario '${scenarioId}' declares expected_failure but expected_state '${expectedStateId}' does not - declare the base contract on the state first (source: ${origins})`,
    );
  }
  const merged: Partial<ExpectedFailure> = { ...stateBlock };
  for (const source of overrides) {
    const block = source.block;
    if (!block) continue;
    for (const key of Object.keys(block) as Array<keyof ExpectedFailure>) {
      const value = block[key];
      if (value === undefined) continue;
      if (source.mode === "fill" && merged[key] !== undefined) continue;
      (merged as Record<keyof ExpectedFailure, unknown>)[key] = value;
    }
  }
  if (!merged.phase || !merged.error_class) {
    throw new Error(
      `scenario '${scenarioId}' expected_failure resolves with missing required fields (phase, error_class) after merge`,
    );
  }
  return merged as ExpectedFailure;
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
  const legacy = meta.scenarios.setup_scenarios[scenarioId];
  const directPlan = meta.scenarios.test_plans?.[scenarioId];
  if (!legacy && !directPlan) {
    const available = [
      ...Object.keys(meta.scenarios.setup_scenarios),
      ...Object.keys(meta.scenarios.test_plans ?? {}),
    ].sort().join(", ");
    throw new Error(`unknown scenario '${scenarioId}' (available: ${available || "<none>"})`);
  }
  const planId = legacy?.alias_for_plan ?? scenarioId;
  const layeredPlan = meta.scenarios.test_plans?.[planId];
  const legacyDimensions = legacy?.dimensions;
  const baseId = layeredPlan?.base;
  const base = baseId ? lookupProfile(meta.scenarios.base_scenarios ?? {}, "base", baseId, scenarioId) : undefined;
  const onboardingId = legacy?.alias_for_plan && legacyDimensions?.onboarding ? legacyDimensions.onboarding : (layeredPlan?.onboarding ?? legacyDimensions?.onboarding);
  const onboardingCollection = onboardingId && onboardingId in meta.scenarios.onboarding ? meta.scenarios.onboarding : (meta.scenarios.onboarding_profiles ?? meta.scenarios.onboarding);
  const onboarding = lookupProfile(onboardingCollection, "onboarding", onboardingId ?? "", scenarioId);
  const platformId = base?.platform ?? legacyDimensions?.platform;
  const installId = base?.install ?? legacyDimensions?.install;
  const runtimeId = base?.runtime ?? legacyDimensions?.runtime;
  if (!platformId || !installId || !runtimeId) throw new Error(`scenario '${scenarioId}' is missing layered base or legacy dimensions`);
  const platform = lookupProfile(meta.scenarios.platforms, "platform", platformId, scenarioId);
  const install = lookupProfile(meta.scenarios.installs, "install", installId, scenarioId);
  const runtime = lookupProfile(meta.scenarios.runtimes, "runtime", runtimeId, scenarioId);
  const expectedStateId = layeredPlan?.expected_state ?? legacy?.expected_state;
  if (!expectedStateId || !(expectedStateId in meta.expectedStates.expected_states)) {
    const available = Object.keys(meta.expectedStates.expected_states).sort().join(", ");
    throw new Error(`scenario '${scenarioId}' references unknown expected_state '${expectedStateId}' (available: ${available || "<none>"})`);
  }
  const stateConfig = meta.expectedStates.expected_states[expectedStateId];
  const suiteIds = layeredPlan?.suites ?? legacy?.suites ?? [];
  const resolvedSuites: ResolvedSuite[] = [];
  for (const suiteId of suiteIds) {
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
  const runnerRequirements = [
    ...(base?.runner_requirements ?? []),
    ...((layeredPlan as TestPlan | undefined)?.runner_requirements ?? []),
    ...(legacy?.runner_requirements ?? []),
  ];
  const expectedFailure = resolveExpectedFailure(stateConfig, expectedStateId, scenarioId, [
    { origin: `base '${baseId}'`, block: base?.expected_failure, mode: "fill" },
    { origin: `test_plan '${planId}'`, block: layeredPlan?.expected_failure, mode: "override" },
    { origin: `setup_scenario '${scenarioId}'`, block: legacy?.expected_failure, mode: "override" },
  ]);
  return {
    scenario_id: scenarioId,
    plan_id: layeredPlan ? planId : undefined,
    legacy_scenario_id: legacy?.alias_for_plan ? scenarioId : undefined,
    base: base && baseId ? { id: baseId, profile: base as BaseScenario } : undefined,
    onboarding: onboardingId ? { id: onboardingId, profile: onboarding } : undefined,
    onboarding_assertions: layeredPlan?.onboarding_assertions ?? [],
    dimensions: {
      platform: { id: platformId, profile: platform },
      install: { id: installId, profile: install },
      runtime: { id: runtimeId, profile: runtime },
      onboarding: { id: onboardingId ?? "", profile: onboarding },
    },
    expected_state: { id: expectedStateId, config: stateConfig },
    suites: resolvedSuites,
    overrides: layeredPlan?.overrides ?? legacy?.overrides,
    runner_requirements: runnerRequirements.length > 0 ? runnerRequirements : undefined,
    required_secrets: layeredPlan?.required_secrets,
    ...(expectedFailure ? { expected_failure: expectedFailure } : {}),
  };
}

export function formatPlan(plan: ResolvedPlan): string {
  const lines: string[] = [];
  lines.push(`Scenario: ${plan.scenario_id}`);
  if (plan.plan_id) lines.push(`Test plan: ${plan.plan_id}`);
  if (plan.base) lines.push(`Base: ${plan.base.id}`);
  if (plan.onboarding) lines.push(`Onboarding: ${plan.onboarding.id}`);
  lines.push("Dimensions:");
  lines.push(`  platform=${plan.dimensions.platform.id}`);
  lines.push(`  install=${plan.dimensions.install.id}`);
  lines.push(`  runtime=${plan.dimensions.runtime.id}`);
  lines.push(`  onboarding=${plan.dimensions.onboarding.id}`);
  lines.push(`Expected state: ${plan.expected_state.id}`);
  if (plan.onboarding_assertions && plan.onboarding_assertions.length > 0) {
    lines.push("Onboarding assertions:");
    for (const assertion of plan.onboarding_assertions) lines.push(`  - ${assertion}`);
  }
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
  if (plan.expected_failure) {
    lines.push("Expected failure:");
    lines.push(`  phase=${plan.expected_failure.phase}`);
    lines.push(`  error_class=${plan.expected_failure.error_class}`);
    if (plan.expected_failure.message_pattern) {
      lines.push(`  message_pattern=${plan.expected_failure.message_pattern}`);
    }
    if (plan.expected_failure.forbidden_side_effects?.length) {
      lines.push(`  forbidden_side_effects=${plan.expected_failure.forbidden_side_effects.join(",")}`);
    }
  }
  return lines.join("\n");
}
