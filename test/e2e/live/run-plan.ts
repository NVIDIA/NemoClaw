// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type CompiledRuntimeMatrix,
  type ResolvedRuntimeCase,
  resolveRuntimeCase,
} from "../registry/runtime-matrix.ts";
import type { TargetDefinition } from "../registry/types.ts";
import { cloudExperimentalChecksForOnboarding } from "./cloud-experimental-check-list.ts";

export interface LiveTargetRunPlan {
  targetId: string;
  manifestPath: string | null;
  expectedStateId: string | undefined;
  suiteIds: string[];
  phases: string[];
  runtimeCase?: ResolvedRuntimeCase;
  e2eCloudExperimentalChecks?: string[];
}

export function buildLiveTargetRunPlan(
  target: TargetDefinition,
  runtimeMatrix?: CompiledRuntimeMatrix,
): LiveTargetRunPlan {
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
  if (target.runtimeCase) {
    if (!runtimeMatrix) {
      throw new Error(
        `Target '${target.id}' references a runtime case without a compiled runtime matrix`,
      );
    }
    plan.runtimeCase = resolveRuntimeCase(runtimeMatrix, target.runtimeCase);
  }
  return plan;
}
