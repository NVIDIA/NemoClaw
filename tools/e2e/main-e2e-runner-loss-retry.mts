// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import {
  validateWorkflowJobsPage,
  verifiedRunnerLossEvidence,
  type WorkflowJob,
} from "./hosted-runner-loss.mts";
import { decideRetry, detectRunnerLoss } from "./runner-pressure-core.mts";

const EXPECTED_REPOSITORY = "NVIDIA/NemoClaw";
const E2E_WORKFLOW_NAME = "E2E";
const E2E_WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const E2E_MAIN_DISPLAY_TITLE = "E2E main";
const MAX_WORKFLOW_JOB_PAGES = 10;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const USER_AGENT = "nemoclaw-main-e2e-runner-loss-retry";

type MainE2eRun = {
  id: number;
  event: "schedule" | "workflow_dispatch";
  headSha: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
};

export type MainE2eRunnerLossRetryResult = {
  retry: boolean;
  reason: string;
  runnerLostMarkerCount: number;
  runId: number;
  runAttempt: number;
  headSha: string;
  runUrl: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return assertPositiveInteger(Number(value), name);
}

export function validateMainE2eRun(value: unknown, expectedRunId: number): MainE2eRun {
  const expectedHtmlUrl = `https://github.com/${EXPECTED_REPOSITORY}/actions/runs/${expectedRunId}`;
  if (
    !isObjectRecord(value) ||
    value.id !== expectedRunId ||
    value.name !== E2E_WORKFLOW_NAME ||
    value.path !== E2E_WORKFLOW_PATH ||
    !["schedule", "workflow_dispatch"].includes(String(value.event)) ||
    value.head_branch !== "main" ||
    typeof value.head_sha !== "string" ||
    !SHA_PATTERN.test(value.head_sha) ||
    value.display_title !== E2E_MAIN_DISPLAY_TITLE ||
    !Number.isSafeInteger(value.run_attempt) ||
    (value.run_attempt as number) < 1 ||
    typeof value.status !== "string" ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    value.html_url !== expectedHtmlUrl ||
    !isObjectRecord(value.repository) ||
    value.repository.full_name !== EXPECTED_REPOSITORY ||
    !isObjectRecord(value.head_repository) ||
    value.head_repository.full_name !== EXPECTED_REPOSITORY
  ) {
    throw new Error("workflow run is not a trusted final-main E2E run");
  }
  return {
    id: expectedRunId,
    event: value.event as "schedule" | "workflow_dispatch",
    headSha: value.head_sha,
    runAttempt: value.run_attempt as number,
    status: value.status,
    conclusion: value.conclusion,
    htmlUrl: expectedHtmlUrl,
  };
}

function validateMainDescendant(value: unknown, headSha: string): void {
  if (
    !isObjectRecord(value) ||
    !["ahead", "identical"].includes(String(value.status)) ||
    value.behind_by !== 0 ||
    !Number.isSafeInteger(value.ahead_by) ||
    (value.ahead_by as number) < 0 ||
    !isObjectRecord(value.base_commit) ||
    value.base_commit.sha !== headSha ||
    !isObjectRecord(value.merge_base_commit) ||
    value.merge_base_commit.sha !== headSha
  ) {
    throw new Error("failed E2E SHA is not an authenticated ancestor of current main");
  }
}

async function listAttemptJobs(options: {
  repository: string;
  token: string;
  runId: number;
  runAttempt: number;
}): Promise<{ jobs: WorkflowJob[]; complete: boolean }> {
  const jobs: WorkflowJob[] = [];
  let totalCount: number | undefined;
  for (let page = 1; page <= MAX_WORKFLOW_JOB_PAGES; page += 1) {
    const response = validateWorkflowJobsPage(
      await githubApi<unknown>(
        `repos/${options.repository}/actions/runs/${options.runId}/attempts/${options.runAttempt}/jobs?per_page=100&page=${page}`,
        options.token,
        { userAgent: USER_AGENT },
      ),
    );
    totalCount ??= response.totalCount;
    if (response.totalCount !== totalCount || jobs.length + response.jobs.length > totalCount) {
      throw new Error("GitHub returned an invalid workflow job count");
    }
    jobs.push(...response.jobs);
    if (jobs.length === totalCount) return { jobs, complete: true };
    if (response.jobs.length < 100) break;
  }
  return { jobs, complete: jobs.length === totalCount };
}

function noRetryResult(run: MainE2eRun, reason: string): MainE2eRunnerLossRetryResult {
  return {
    retry: false,
    reason,
    runnerLostMarkerCount: 0,
    runId: run.id,
    runAttempt: run.runAttempt,
    headSha: run.headSha,
    runUrl: run.htmlUrl,
  };
}

function sameAttempt(left: MainE2eRun, right: MainE2eRun): boolean {
  return (
    left.id === right.id &&
    left.event === right.event &&
    left.headSha === right.headSha &&
    left.runAttempt === right.runAttempt &&
    left.status === right.status &&
    left.conclusion === right.conclusion &&
    left.htmlUrl === right.htmlUrl
  );
}

export async function retryMainE2eRunnerLoss(options: {
  repository: string;
  token: string;
  runId: number;
  expectedRunAttempt: number;
}): Promise<MainE2eRunnerLossRetryResult> {
  if (options.repository !== EXPECTED_REPOSITORY) {
    throw new Error(`runner-loss retry is restricted to ${EXPECTED_REPOSITORY}`);
  }
  if (!options.token) throw new Error("GITHUB_TOKEN is required");
  assertPositiveInteger(options.runId, "run ID");
  assertPositiveInteger(options.expectedRunAttempt, "expected run attempt");

  const loadRun = async (): Promise<MainE2eRun> =>
    validateMainE2eRun(
      await githubApi<unknown>(
        `repos/${options.repository}/actions/runs/${options.runId}`,
        options.token,
        { userAgent: USER_AGENT },
      ),
      options.runId,
    );
  const run = await loadRun();
  if (run.runAttempt !== options.expectedRunAttempt) {
    return noRetryResult(
      run,
      `run already advanced to attempt ${run.runAttempt}; event attempt ${options.expectedRunAttempt} cannot retry it`,
    );
  }
  if (run.status !== "completed" || run.conclusion !== "failure") {
    return noRetryResult(
      run,
      `run is ${run.status} with conclusion ${run.conclusion ?? "none"}; only a completed failure is retryable`,
    );
  }

  validateMainDescendant(
    await githubApi<unknown>(
      `repos/${options.repository}/compare/${run.headSha}...main`,
      options.token,
      { userAgent: USER_AGENT },
    ),
    run.headSha,
  );
  const details = await listAttemptJobs({
    repository: options.repository,
    token: options.token,
    runId: run.id,
    runAttempt: run.runAttempt,
  });
  const evidence = verifiedRunnerLossEvidence({
    workflowConclusion: run.conclusion,
    jobs: details.jobs,
    jobDetailsAvailable: true,
    jobDetailsComplete: details.complete,
  });
  const decision = decideRetry({
    runnerLoss: evidence === null ? false : detectRunnerLoss(evidence),
    classification: null,
    attempt: run.runAttempt,
  });
  const result: MainE2eRunnerLossRetryResult = {
    retry: decision.retry,
    reason: decision.reason,
    runnerLostMarkerCount: evidence?.runnerLostMarkerCount ?? 0,
    runId: run.id,
    runAttempt: run.runAttempt,
    headSha: run.headSha,
    runUrl: run.htmlUrl,
  };
  if (!decision.retry) return result;

  const confirmed = await loadRun();
  if (!sameAttempt(run, confirmed)) {
    return {
      ...result,
      retry: false,
      reason: "run changed while runner-loss evidence was being verified; refusing a stale retry",
    };
  }
  await githubApi<void>(
    `repos/${options.repository}/actions/runs/${run.id}/rerun-failed-jobs`,
    options.token,
    { method: "POST", userAgent: USER_AGENT },
  );
  return result;
}

export function renderRetryLog(result: MainE2eRunnerLossRetryResult): string {
  const originalAttemptUrl = `${result.runUrl}/attempts/${result.runAttempt}`;
  const lines = [
    "## Final-main E2E runner-loss policy",
    "",
    `- Original attempt: [${result.runAttempt}](${originalAttemptUrl})`,
    `- Tested SHA: \`${result.headSha}\``,
    `- Confirmed hosted-runner-loss jobs: ${result.runnerLostMarkerCount}`,
    `- Decision: ${result.retry ? "queued one failed-job retry" : "did not retry"}`,
    `- Reason: ${result.reason}`,
  ];
  if (result.retry) {
    lines.push(
      `- Retry attempt: [${result.runAttempt + 1}](${result.runUrl}/attempts/${result.runAttempt + 1})`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderRetrySummary(): string {
  return [
    "## Final-main E2E runner-loss policy",
    "",
    "See the job log for the validated decision and attempt links.",
    "",
  ].join("\n");
}

function appendJobSummary(): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const descriptor = fs.openSync(
    summaryPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("GITHUB_STEP_SUMMARY must be a regular file");
    }
    fs.writeFileSync(descriptor, renderRetrySummary(), "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

async function main(): Promise<void> {
  const result = await retryMainE2eRunnerLoss({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
    runId: parsePositiveInteger(process.env.SUBJECT_RUN_ID, "SUBJECT_RUN_ID"),
    expectedRunAttempt: parsePositiveInteger(
      process.env.SUBJECT_RUN_ATTEMPT,
      "SUBJECT_RUN_ATTEMPT",
    ),
  });
  appendJobSummary();
  console.log(renderRetryLog(result).trimEnd());
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
