// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowAttemptEvidence } from "./runner-pressure-core.mts";

const GITHUB_HOSTED_RUNNER_NAME_PATTERN = /^GitHub Actions [1-9][0-9]*$/u;

export type WorkflowJob = {
  id: number;
  name: string;
  status?: string;
  conclusion: string | null;
  runnerId?: number | null;
  runnerName?: string | null;
  labels?: string[];
  steps: Array<{ name: string; status?: string; conclusion: string | null }>;
};

export type WorkflowJobsPage = { totalCount: number; jobs: WorkflowJob[] };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validateWorkflowJob(value: unknown): WorkflowJob {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    (value.status !== undefined && typeof value.status !== "string") ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    (value.runner_id !== undefined &&
      value.runner_id !== null &&
      (!Number.isSafeInteger(value.runner_id) || (value.runner_id as number) < 1)) ||
    (value.runner_name !== undefined &&
      value.runner_name !== null &&
      typeof value.runner_name !== "string") ||
    (value.labels !== undefined &&
      (!Array.isArray(value.labels) || value.labels.some((label) => typeof label !== "string"))) ||
    (value.steps !== undefined && !Array.isArray(value.steps))
  ) {
    throw new Error("GitHub returned an invalid workflow job");
  }
  const steps = (value.steps ?? []).map((step) => {
    if (
      !isObjectRecord(step) ||
      typeof step.name !== "string" ||
      step.name.length === 0 ||
      (step.status !== undefined && typeof step.status !== "string") ||
      (step.conclusion !== null && typeof step.conclusion !== "string")
    ) {
      throw new Error("GitHub returned an invalid workflow job step");
    }
    return {
      name: step.name,
      ...(step.status === undefined ? {} : { status: step.status }),
      conclusion: step.conclusion,
    };
  });
  return {
    id: value.id as number,
    name: value.name,
    ...(value.status === undefined ? {} : { status: value.status }),
    conclusion: value.conclusion,
    ...(value.runner_id === undefined ? {} : { runnerId: value.runner_id as number | null }),
    ...(value.runner_name === undefined ? {} : { runnerName: value.runner_name }),
    ...(value.labels === undefined ? {} : { labels: value.labels as string[] }),
    steps,
  };
}

export function validateWorkflowJobsPage(value: unknown): WorkflowJobsPage {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.jobs)
  ) {
    throw new Error("GitHub returned an invalid workflow job listing");
  }
  return {
    totalCount: value.total_count as number,
    jobs: value.jobs.map(validateWorkflowJob),
  };
}

/**
 * GitHub records a lost hosted runner as a completed failed job whose active
 * step never received a terminal conclusion. This is stronger than a
 * cancellation: user and concurrency cancellations finish the active step and
 * run cleanup, while the release-run failures tracked by #7146 retained one
 * `in_progress` step after the job itself became terminal.
 * GitHub owns this hosted-runner state, so repository code cannot repair its
 * source. Remove this retry only after GitHub stops producing this signature;
 * keep the classifier fail-closed for any replacement terminal evidence.
 */
export function hasTrustedHostedRunnerLossMarker(job: WorkflowJob): boolean {
  if (
    job.status !== "completed" ||
    job.conclusion !== "failure" ||
    !Number.isSafeInteger(job.runnerId) ||
    (job.runnerId ?? 0) < 1 ||
    typeof job.runnerName !== "string" ||
    !GITHUB_HOSTED_RUNNER_NAME_PATTERN.test(job.runnerName) ||
    !Array.isArray(job.labels) ||
    job.labels.includes("self-hosted")
  ) {
    return false;
  }
  const strandedSteps = job.steps.filter(
    (step) => step.status === "in_progress" && step.conclusion === null,
  );
  return (
    strandedSteps.length === 1 &&
    job.steps.every(
      (step) =>
        step.conclusion === "success" ||
        (step.conclusion === null && ["in_progress", "pending"].includes(step.status ?? "")),
    )
  );
}

export function verifiedRunnerLossEvidence(options: {
  workflowConclusion: string | null;
  jobs: readonly WorkflowJob[];
  jobDetailsAvailable: boolean;
  jobDetailsComplete: boolean;
}): WorkflowAttemptEvidence | null {
  if (
    !options.jobDetailsAvailable ||
    !options.jobDetailsComplete ||
    options.jobs.length === 0 ||
    !["failure", "cancelled"].includes(options.workflowConclusion ?? "")
  ) {
    return null;
  }
  const runnerLostMarkerCount = options.jobs.filter(hasTrustedHostedRunnerLossMarker).length;
  const ordinaryFailureEvidencePresent = options.jobs.some(
    (job) =>
      !hasTrustedHostedRunnerLossMarker(job) &&
      !["success", "skipped", "neutral", "cancelled"].includes(job.conclusion ?? ""),
  );
  return {
    terminalClassificationPresent: ordinaryFailureEvidencePresent,
    jobConclusion: options.workflowConclusion as "failure" | "cancelled",
    runnerLostMarkerCount,
  };
}
