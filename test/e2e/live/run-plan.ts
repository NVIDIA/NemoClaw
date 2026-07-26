// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cloudExperimentalChecksForOnboarding } from "./cloud-experimental-check-list.ts";
import type { TargetDefinition } from "../registry/types.ts";

export interface LiveTargetRunPlan {
  targetId: string;
  manifestPath: string | null;
  expectedStateId: string | undefined;
  suiteIds: string[];
  phases: string[];
  e2eCloudExperimentalChecks?: string[];
}

export function buildLiveTargetRunPlan(target: TargetDefinition): LiveTargetRunPlan {
  const plan: LiveTargetRunPlan = {
    targetId: target.id,
    manifestPath: target.manifestPath ?? null,
    expectedStateId: target.expectedStateId,
    suiteIds: target.suiteIds ?? [],
    phases: [
      "environment",
      "onboarding",
      ...(target.environment?.lifecycle ? ["lifecycle"] : []),
      "state-validation",
    ],
  };
  const cloudExperimentalChecks = cloudExperimentalChecksForOnboarding(
    target.environment?.onboarding,
  );
  if (cloudExperimentalChecks.length > 0) {
    plan.e2eCloudExperimentalChecks = [...cloudExperimentalChecks];
  }
  return plan;
}
