// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  if (scenario.environment?.onboarding === "cloud-langchain-deepagents-code") {
    plan.e2eCloudExperimentalChecks = [
      "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
      "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
    ];
  }
  return plan;
}
