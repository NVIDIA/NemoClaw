// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCommits, getDiffStat } from "../advisors/git.mts";
import { buildRiskPlan, isPrE2ePlanningJob, type RiskPlan } from "../advisors/risk-plan.mts";
import { focusedE2eJobsForChangedFiles } from "../e2e/workflow-boundary.mts";
import type { GitHubReviewContext } from "./github-context.mts";
import {
  collectDriftEvidence,
  detectLocalizedPatchSignals,
  detectRiskyAreas,
  detectSimplificationSignals,
  detectWorkflowSignals,
  type DriftEvidence,
  type LocalizedPatchSignal,
  type SimplificationSignal,
} from "./context-signals.mts";
import {
  classifyTestDepth,
  collectStaticTestInventory,
  type StaticTestInventory,
  type TestDepth,
} from "./context-tests.mts";

export type DeterministicReviewContext = {
  diffStat: string;
  commits: string[];
  riskyAreas: string[];
  riskPlan: RiskPlan;
  testDepth: TestDepth;
  staticTestInventory: StaticTestInventory;
  simplificationSignals: SimplificationSignal[];
  workflowSignals: string[];
  localizedPatchSignals: LocalizedPatchSignal[];
  driftEvidence: DriftEvidence[];
  github: GitHubReviewContext | null;
};

export type DeterministicContextOptions = {
  baseRef: string;
  headRef: string;
  headSha: string;
  changedFiles: string[];
  diff: string;
};

export type DeterministicContextDependencies = {
  collectGitHubContext: () => Promise<GitHubReviewContext | null>;
};

export async function collectDeterministicContext(
  options: DeterministicContextOptions,
  dependencies: DeterministicContextDependencies,
): Promise<DeterministicReviewContext> {
  const github = await dependencies.collectGitHubContext();
  const riskPlan = buildRiskPlan({
    headSha: options.headSha,
    changedFiles: options.changedFiles,
    focusedE2eJobs: focusedE2eJobsForChangedFiles(options.changedFiles).filter((selection) =>
      isPrE2ePlanningJob(selection.id),
    ),
  });
  const riskyAreas = [
    ...detectRiskyAreas(options.changedFiles),
    ...riskPlan.families.map((family) => family.id),
  ].filter((area, index, areas) => areas.indexOf(area) === index);
  return {
    diffStat: getDiffStat(options.baseRef, options.headRef),
    commits: getCommits(options.baseRef, options.headRef),
    riskyAreas,
    riskPlan,
    testDepth: classifyTestDepth(options.changedFiles, riskPlan, options.diff),
    staticTestInventory: collectStaticTestInventory(options.changedFiles),
    simplificationSignals: detectSimplificationSignals(options.diff),
    workflowSignals: detectWorkflowSignals(options.changedFiles, options.diff),
    localizedPatchSignals: detectLocalizedPatchSignals(options.diff),
    driftEvidence: collectDriftEvidence(options.baseRef, options.changedFiles),
    github,
  };
}

export { classifyTestDepth, collectStaticTestInventory } from "./context-tests.mts";
export { detectLocalizedPatchSignals, detectSimplificationSignals } from "./context-signals.mts";
export type { StaticTestInventory } from "./context-tests.mts";
export type { SimplificationSignal } from "./context-signals.mts";
