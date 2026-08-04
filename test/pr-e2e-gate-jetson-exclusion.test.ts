// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  normalizeE2eCoverageResult,
  normalizeE2eTargetAdvisorResult,
  trustedE2eRecommendationInventory,
} from "../tools/advisors/e2e-recommendations.mts";
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

  expect(focusedPrGateE2eJobsForChangedFiles(changedFiles)).toEqual([]);
  expect(validateRiskPlan(plan, new Set(riskPlanRequiredJobIds(plan)))).toEqual(plan);
  expect(riskPlanRequiredJobIds(plan)).not.toContain("jetson-nvmap-gpu");
  expect(riskPlanRequiredJobIds(plan)).toEqual(
    expect.arrayContaining(["cloud-inference", "cloud-onboard", "security-posture"]),
  );
});

it("omits the guarded Jetson job from advisor E2E recommendations (#7610)", () => {
  const changedFiles = ["test/e2e/live/jetson-nvmap-gpu.test.ts"];
  const metadata = { baseRef: "origin/main", headRef: "HEAD", changedFiles };
  const riskPlan = buildRiskPlan({
    headSha: "a".repeat(40),
    changedFiles,
    focusedE2eJobs: focusedPrGateE2eJobsForChangedFiles(changedFiles),
  });
  const modelGuidance = {
    requiredTests: [{ id: "jetson-nvmap-gpu", reason: "Model-selected coverage." }],
    optionalTests: [{ id: "jetson-nvmap-gpu", reason: "Model-selected coverage." }],
    required: [
      {
        id: "jetson-nvmap-gpu",
        workflow: "e2e.yaml",
        selectorType: "job",
        reason: "Model-selected job.",
      },
    ],
    optional: [],
    confidence: "high",
  };

  const coverage = normalizeE2eCoverageResult(modelGuidance, metadata, riskPlan);
  const targets = normalizeE2eTargetAdvisorResult(modelGuidance, metadata, { riskPlan });
  const dynamicallyDiscovered = normalizeE2eTargetAdvisorResult(modelGuidance, metadata, {
    riskPlan,
    changedFileSources: {
      [changedFiles[0]]: "// @module-tag e2e/credential-free\n",
    },
  });

  expect(trustedE2eRecommendationInventory().allowedJobIds).not.toContain("jetson-nvmap-gpu");
  expect(coverage.requiredTests.map((item) => item.id)).not.toContain("jetson-nvmap-gpu");
  expect(coverage.optionalTests.map((item) => item.id)).not.toContain("jetson-nvmap-gpu");
  expect(targets.required.map((item) => item.id)).not.toContain("jetson-nvmap-gpu");
  expect(targets.optional.map((item) => item.id)).not.toContain("jetson-nvmap-gpu");
  expect(dynamicallyDiscovered.changedCredentialFreeTests).toEqual([]);
  expect(dynamicallyDiscovered.required.map((item) => item.id)).not.toContain("jetson-nvmap-gpu");
});
