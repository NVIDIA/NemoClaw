// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { trustedE2eRecommendationInventory } from "../advisors/e2e-recommendations.mts";
import type { RiskPlan } from "../advisors/risk-plan.mts";
import type { DeterministicReviewContext } from "./deterministic-context.mts";

const RISK_CONTEXT_PATH_SAMPLE_LIMIT = 20;
const RISK_CONTEXT_PATH_CHARACTER_LIMIT = 240;

export function buildDriftTurnContext(
  context: DeterministicReviewContext,
): Record<string, unknown> {
  return {
    diffStat: context.diffStat,
    commits: context.commits,
    riskyAreas: context.riskyAreas,
    workflowSignals: context.workflowSignals,
    driftEvidence: context.driftEvidence,
    previousAdvisorReview: context.previousAdvisorReview,
    openPrOverlaps: context.github?.openPrOverlaps ?? [],
  };
}

export function buildScopeRiskTurnContext(
  context: DeterministicReviewContext,
): Record<string, unknown> {
  return {
    ...buildDriftTurnContext(context),
    riskPlan: buildRiskPlanReviewContext(context.riskPlan),
  };
}

export function buildCorrectnessTurnContext(
  context: DeterministicReviewContext,
): Record<string, unknown> {
  return {
    localizedPatchSignals: context.localizedPatchSignals,
    simplificationSignals: context.simplificationSignals,
    issueReferenceLines: context.github?.issueReferenceLines ?? [],
    linkedIssues: context.github?.linkedIssues ?? [],
    githubFetchError: context.github?.fetchError,
  };
}

export function buildSecurityTurnContext(
  context: DeterministicReviewContext,
): Record<string, unknown> {
  return {
    riskPlan: buildRiskPlanReviewContext(context.riskPlan),
    riskyAreas: context.riskyAreas,
    workflowSignals: context.workflowSignals,
  };
}

export function buildTestsTurnContext(
  context: DeterministicReviewContext,
): Record<string, unknown> {
  return {
    riskPlan: buildRiskPlanReviewContext(context.riskPlan),
    e2eInventory: trustedE2eRecommendationInventory(),
    testDepth: context.testDepth,
    staticTestInventory: context.staticTestInventory,
  };
}

export function buildOperationsTurnContext(
  context: DeterministicReviewContext,
): Record<string, unknown> {
  return {
    riskPlan: buildRiskPlanReviewContext(context.riskPlan),
    riskyAreas: context.riskyAreas,
    workflowSignals: context.workflowSignals,
    e2eInventory: trustedE2eRecommendationInventory(),
    selectorGuidanceOnly: true,
  };
}

export function buildReconciliationTurnContext(
  context: DeterministicReviewContext,
): Record<string, unknown> {
  return {
    previousAdvisorReview: context.previousAdvisorReview
      ? { present: true, headSha: context.previousAdvisorReview.headSha }
      : null,
    riskPlan: {
      headSha: context.riskPlan.headSha,
      planHash: context.riskPlan.planHash,
      tier: context.riskPlan.tier,
      familyIds: context.riskPlan.families.map((family) => family.id),
      requiredJobIds: context.riskPlan.requiredJobs.map((job) => job.id),
      requiredTargetIds: context.riskPlan.requiredTargets.map((target) => target.id),
    },
    linkedIssues: (context.github?.linkedIssues ?? []).map(({ number, fetchError }) => ({
      number,
      fetchError,
    })),
    githubFetchError: context.github?.fetchError,
  };
}

export function buildRiskPlanReviewContext(plan: RiskPlan): Record<string, unknown> {
  return {
    version: plan.version,
    headSha: plan.headSha,
    planHash: plan.planHash,
    tier: plan.tier,
    changedFiles: boundedPathSummary(plan.changedFiles),
    families: plan.families.map((family) => ({
      id: family.id,
      summary: family.summary,
      tier: family.tier,
      matchedFiles: boundedPathSummary(family.matchedFiles),
      invariants: family.invariants,
      requiredJobs: family.requiredJobs,
      requiredTargets: family.requiredTargets,
    })),
    requiredJobs: plan.requiredJobs.map((job) => ({
      id: job.id,
      tier: job.tier,
      families: job.families,
      reasons: job.reasons,
      matchedFileCount: job.matchedFiles.length,
    })),
    requiredTargets: plan.requiredTargets.map((target) => ({
      id: target.id,
      tier: target.tier,
      families: target.families,
      reasons: target.reasons,
      matchedFileCount: target.matchedFiles.length,
    })),
  };
}

function boundedPathSummary(files: readonly string[]): Record<string, unknown> {
  return {
    count: files.length,
    sample: files
      .slice(0, RISK_CONTEXT_PATH_SAMPLE_LIMIT)
      .map((file) =>
        file.length <= RISK_CONTEXT_PATH_CHARACTER_LIMIT
          ? file
          : `${file.slice(0, RISK_CONTEXT_PATH_CHARACTER_LIMIT - 3)}...`,
      ),
    omitted: Math.max(0, files.length - RISK_CONTEXT_PATH_SAMPLE_LIMIT),
  };
}

export function buildValidationTurnContext(
  context: DeterministicReviewContext,
): Record<string, unknown> {
  return {
    riskPlan: context.riskPlan,
    testDepth: context.testDepth,
    staticTestInventory: context.staticTestInventory,
    simplificationSignals: context.simplificationSignals,
    localizedPatchSignals: context.localizedPatchSignals,
    previousAdvisorReview: context.previousAdvisorReview,
    issueReferenceLines: context.github?.issueReferenceLines ?? [],
    linkedIssues: context.github?.linkedIssues ?? [],
    githubFetchError: context.github?.fetchError,
  };
}
