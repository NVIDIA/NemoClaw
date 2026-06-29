// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalScenarios } from "./scenarios/baseline.ts";
import type { ScenarioDefinition } from "./types.ts";

export const SCENARIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const SCENARIO_ID_PATTERN_DESCRIPTION =
  "ASCII letters, digits, underscores, and hyphens, starting with a letter or digit";

export interface ScenarioRegistry {
  scenarios: ScenarioDefinition[];
  byId: Map<string, ScenarioDefinition>;
}

export function assertSafeScenarioId(id: string, context = "Scenario ID"): void {
  if (!SCENARIO_ID_PATTERN.test(id)) {
    throw new Error(
      `${context} '${id}' is not safe for workflow regex filters or artifact paths; expected ${SCENARIO_ID_PATTERN_DESCRIPTION}.`,
    );
  }
}

export function buildScenarioRegistry(scenarios: ScenarioDefinition[]): ScenarioRegistry {
  const byId = new Map<string, ScenarioDefinition>();
  const duplicates = new Set<string>();
  for (const scenario of scenarios) {
    assertSafeScenarioId(scenario.id);
    if (byId.has(scenario.id)) {
      duplicates.add(scenario.id);
    }
    byId.set(scenario.id, scenario);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate scenario IDs: ${Array.from(duplicates).sort().join(", ")}`);
  }
  return { scenarios: [...scenarios], byId };
}

const registry = buildScenarioRegistry(canonicalScenarios());

export function listScenarios(): ScenarioDefinition[] {
  return [...registry.scenarios].sort((a, b) => a.id.localeCompare(b.id));
}

export function getScenario(id: string): ScenarioDefinition | undefined {
  return registry.byId.get(id);
}

export function requireScenarios(ids: string[]): ScenarioDefinition[] {
  const availableIds = listScenarios().map((scenario) => scenario.id);
  const scenarios = ids.map((id) => {
    assertSafeScenarioId(id, "Selected scenario ID");
    const found = getScenario(id);
    if (!found) {
      throw new Error(`Unknown scenario '${id}'. Available scenarios: ${availableIds.join(", ")}`);
    }
    return found;
  });
  return scenarios;
}
