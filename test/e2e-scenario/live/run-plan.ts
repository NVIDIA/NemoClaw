// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cloudExperimentalChecksForOnboarding } from "./cloud-experimental-check-list.ts";
import type { ScenarioDefinition } from "../scenarios/types.ts";

export interface LiveScenarioRunPlan {
  scenarioId: string;
  manifestPath: string | null;
  expectedStateId: string | undefined;
  suiteIds: string[];
  phases: string[];
  e2eCloudExperimentalChecks?: string[];
}

export function buildLiveScenarioRunPlan(scenario: ScenarioDefinition): LiveScenarioRunPlan {
  const plan: LiveScenarioRunPlan = {
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
  const cloudExperimentalChecks = cloudExperimentalChecksForOnboarding(
    scenario.environment?.onboarding,
  );
  if (cloudExperimentalChecks.length > 0) {
    plan.e2eCloudExperimentalChecks = [...cloudExperimentalChecks];
  }
  return plan;
}
