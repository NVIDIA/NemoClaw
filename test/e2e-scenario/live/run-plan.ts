// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScenarioDefinition } from "../scenarios/types.ts";

export interface LiveScenarioRunPlan {
  scenarioId: string;
  manifestPath: string | null;
  expectedStateId: string | undefined;
  suiteIds: string[];
  phases: string[];
}

export function buildLiveScenarioRunPlan(scenario: ScenarioDefinition): LiveScenarioRunPlan {
  return {
    scenarioId: scenario.id,
    manifestPath: scenario.manifestPath ?? null,
    expectedStateId: scenario.expectedStateId,
    suiteIds: scenario.suiteIds ?? [],
    phases: [
      "environment",
      "onboarding",
      ...(scenario.environment?.lifecycle ? ["lifecycle"] : []),
      "state-validation",
    ],
  };
}
