// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConfigExportExpectation, TargetDefinition } from "../registry/types.ts";
import { cloudExperimentalChecksForOnboarding } from "./cloud-experimental-check-list.ts";

export interface LiveTargetRunPlan {
  targetId: string;
  manifestPath: string | null;
  expectedStateId: string | undefined;
  configExportExpectation: ConfigExportExpectation;
  suiteIds: string[];
  phases: string[];
  e2eCloudExperimentalChecks?: string[];
}

const PROGRESS_PHASE_PREFIX = [
  "resolve the target contract and run plan",
  "confirm the target environment is ready",
  "prepare the target lifecycle prerequisites",
  "onboard the registry-selected sandbox",
  "execute the target lifecycle boundary",
] as const;

const PROGRESS_PHASE_SUFFIX = ["record target completion evidence"] as const;

export function liveTargetProgressPhases(plan: LiveTargetRunPlan): readonly string[] {
  const validationPhases = plan.e2eCloudExperimentalChecks?.length
    ? [
        "run target-specific cloud checks",
        "validate the exported sandbox configuration",
        "verify the expected sandbox state",
      ]
    : [
        "verify the expected sandbox state",
        "validate the exported sandbox configuration",
        "run target-specific cloud checks",
      ];
  return [...PROGRESS_PHASE_PREFIX, ...validationPhases, ...PROGRESS_PHASE_SUFFIX];
}

export function buildLiveTargetRunPlan(target: TargetDefinition): LiveTargetRunPlan {
  const plan: LiveTargetRunPlan = {
    targetId: target.id,
    manifestPath: target.manifestPath ?? null,
    expectedStateId: target.expectedStateId,
    configExportExpectation: target.configExport.expectation,
    suiteIds: target.suiteIds ?? [],
    phases: ["environment", "onboarding", ...(target.environment?.lifecycle ? ["lifecycle"] : [])],
  };
  const cloudExperimentalChecks = cloudExperimentalChecksForOnboarding(
    target.environment?.onboarding,
  );
  if (cloudExperimentalChecks.length > 0) {
    plan.e2eCloudExperimentalChecks = [...cloudExperimentalChecks];
    plan.phases.push("cloud-experimental-checks");
    plan.phases.push("config-export-validation", "state-validation");
  } else {
    plan.phases.push("state-validation", "config-export-validation");
  }
  return plan;
}
