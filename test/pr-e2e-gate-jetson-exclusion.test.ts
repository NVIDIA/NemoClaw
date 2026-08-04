// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { buildRiskPlan, riskPlanRequiredJobIds } from "../tools/advisors/risk-plan.mts";
import {
  focusedPrGateE2eJobsForChangedFiles,
  validateRiskPlan,
} from "../tools/e2e/pr-e2e-gate.mts";
import { focusedE2eJobsForChangedFiles } from "../tools/e2e/workflow-boundary.mts";

it("omits the guarded Jetson job from automatic PR E2E plans (#7610)", () => {
  const changedFiles = ["test/e2e/live/jetson-nvmap-gpu.test.ts"];

  expect(focusedE2eJobsForChangedFiles(changedFiles)).toEqual([
    { id: "jetson-nvmap-gpu", matchedFiles: changedFiles },
  ]);
  const plan = buildRiskPlan({
    headSha: "a".repeat(40),
    changedFiles,
    focusedE2eJobs: focusedPrGateE2eJobsForChangedFiles(changedFiles),
  });

  expect(validateRiskPlan(plan, new Set(riskPlanRequiredJobIds(plan)))).toEqual(plan);
  expect(riskPlanRequiredJobIds(plan)).not.toContain("jetson-nvmap-gpu");
  expect(riskPlanRequiredJobIds(plan)).toEqual(
    expect.arrayContaining(["cloud-inference", "cloud-onboard", "security-posture"]),
  );
});
