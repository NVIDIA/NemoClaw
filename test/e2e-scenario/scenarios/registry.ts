// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalScenarios } from "./scenarios/baseline.ts";
import type { ScenarioDefinition } from "./types.ts";

export interface ScenarioRegistry {
  scenarios: ScenarioDefinition[];
  byId: Map<string, ScenarioDefinition>;
}

export function buildScenarioRegistry(scenarios: ScenarioDefinition[]): ScenarioRegistry {
  const byId = new Map<string, ScenarioDefinition>();
  const duplicates = new Set<string>();
  for (const scenario of scenarios) {
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
    const found = getScenario(id);
    if (!found) {
      throw new Error(`Unknown scenario '${id}'. Available scenarios: ${availableIds.join(", ")}`);
    }
    return found;
  });
  return scenarios;
}
