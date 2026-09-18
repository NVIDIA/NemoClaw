// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConfigExportExpectation, TargetDefinition } from "../registry/types.ts";
import { cloudExperimentalChecksForOnboarding } from "./cloud-experimental-check-list.ts";

export interface LiveTargetRunPlan {
  targetId: string;
  expectedStateId: string | undefined;
  configExportExpectation: ConfigExportExpectation;
  phases: string[];
  e2eCloudExperimentalChecks?: string[];
}

export function buildLiveTargetRunPlan(target: TargetDefinition): LiveTargetRunPlan {
  const plan: LiveTargetRunPlan = {
    targetId: target.id,
    expectedStateId: target.expectedStateId,
    configExportExpectation: target.configExport.expectation,
    phases: [
      "environment",
      "onboarding",
      ...(target.environment?.lifecycle ? ["lifecycle"] : []),
      "state-validation",
      "config-export-validation",
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
