// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type JsonRecord = Record<string, unknown>;

export interface FullE2eEvidenceInput {
  candidateSha: string;
  cleanup: unknown;
  dispatch: unknown;
  jobs: unknown;
  launchableE2e: unknown;
  run: unknown;
}

export interface FullE2eEvidenceSummary {
  attempt: number;
  candidateSha: string;
  cleanup: {
    status: "ABSENT";
    verifiedAt: string;
    workspaceId: string;
    workspaceName: string;
  };
  dispatch: {
    emptySelectors: true;
    includeStagingBrevLaunchable: true;
  };
  jobUrl: string;
  launchableE2e: {
    fullE2e: "passed";
    producerRunId: string;
    provisionSha: string;
    repoClean: true;
    repoSha: string;
  };
  runUrl: string;
}

function record(value: unknown, owner: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${owner} must be an object`);
  }
  return value as JsonRecord;
}

function jobRecords(value: unknown): JsonRecord[] {
  const pages = Array.isArray(value) ? value : [value];
  return pages.flatMap((page, pageIndex) => {
    const payload = record(page, `jobs response[${pageIndex}]`);
    if (!Array.isArray(payload.jobs)) {
      throw new Error(`jobs response[${pageIndex}].jobs must be an array`);
    }
    return payload.jobs.map((job, jobIndex) =>
      record(job, `jobs response[${pageIndex}].jobs[${jobIndex}]`),
    );
  });
}

function stringField(value: JsonRecord, key: string, owner: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${owner}.${key} must be a non-empty string`);
  }
  return field;
}

function positiveIntegerField(value: JsonRecord, key: string, owner: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || Number(field) < 1) {
    throw new Error(`${owner}.${key} must be a positive integer`);
  }
  return Number(field);
}

function requireEqual(actual: unknown, expected: unknown, owner: string): void {
  if (actual !== expected) {
    throw new Error(`${owner} must equal ${JSON.stringify(expected)}`);
  }
}

function requireGitHubUrl(value: string, owner: string): void {
  if (!value.startsWith("https://github.com/NVIDIA/NemoClaw/actions/")) {
    throw new Error(`${owner} must be an NVIDIA/NemoClaw Actions URL`);
  }
}

export function validateFullE2eEvidence(input: FullE2eEvidenceInput): FullE2eEvidenceSummary {
  if (!/^[0-9a-f]{40}$/.test(input.candidateSha)) {
    throw new Error("candidate SHA must be a lowercase 40-character SHA");
  }

  const run = record(input.run, "run");
  requireEqual(run.head_sha, input.candidateSha, "run.head_sha");
  requireEqual(run.head_branch, "main", "run.head_branch");
  requireEqual(run.event, "workflow_dispatch", "run.event");
  requireEqual(run.path, ".github/workflows/e2e.yaml", "run.path");
  requireEqual(run.status, "completed", "run.status");
  requireEqual(run.conclusion, "success", "run.conclusion");
  const attempt = positiveIntegerField(run, "run_attempt", "run");
  const runUrl = stringField(run, "html_url", "run");
  requireGitHubUrl(runUrl, "run.html_url");
  const runId = positiveIntegerField(run, "id", "run");

  const dispatch = record(input.dispatch, "dispatch");
  requireEqual(dispatch.kind, "nemoclaw-e2e-dispatch-v1", "dispatch.kind");
  requireEqual(dispatch.candidateSha, input.candidateSha, "dispatch.candidateSha");
  requireEqual(dispatch.eventName, "workflow_dispatch", "dispatch.eventName");
  requireEqual(dispatch.workflowRunId, String(runId), "dispatch.workflowRunId");
  const receiptAttempt = positiveIntegerField(dispatch, "workflowRunAttempt", "dispatch");
  if (receiptAttempt > attempt) {
    throw new Error("dispatch.workflowRunAttempt exceeds run.run_attempt");
  }
  requireEqual(dispatch.jobs, "", "dispatch.jobs");
  requireEqual(dispatch.targets, "", "dispatch.targets");
  requireEqual(
    dispatch.includeStagingBrevLaunchable,
    true,
    "dispatch.includeStagingBrevLaunchable",
  );
  requireEqual(dispatch.emptySelectors, true, "dispatch.emptySelectors");

  const matchingJobs = jobRecords(input.jobs).filter(
    (job) => job.name === "Exact staging Brev Launchable",
  );
  const successfulJobs = matchingJobs
    .map((job, index) => ({
      attempt: positiveIntegerField(job, "run_attempt", `Exact staging Brev Launchable[${index}]`),
      job,
      runId: positiveIntegerField(job, "run_id", `Exact staging Brev Launchable[${index}]`),
    }))
    .filter(
      ({ attempt: jobAttempt, job, runId: jobRunId }) =>
        jobRunId === runId &&
        jobAttempt <= attempt &&
        jobAttempt === receiptAttempt &&
        job.status === "completed" &&
        job.conclusion === "success",
    )
    .sort((left, right) => right.attempt - left.attempt);
  if (successfulJobs.length === 0) {
    throw new Error(
      "jobs response must contain a completed successful Exact staging Brev Launchable job from this workflow run",
    );
  }
  const job = successfulJobs[0]!.job;
  const jobUrl = stringField(job, "html_url", "Exact staging Brev Launchable");
  requireGitHubUrl(jobUrl, "Exact staging Brev Launchable html_url");
  if (!jobUrl.startsWith(`${runUrl}/job/`)) {
    throw new Error("Exact staging Brev Launchable html_url must belong to the workflow run");
  }

  const launchableE2e = record(input.launchableE2e, "launchableE2e");
  requireEqual(launchableE2e.candidateSha, input.candidateSha, "launchableE2e.candidateSha");
  requireEqual(launchableE2e.fullE2e, "passed", "launchableE2e.fullE2e");
  const producer = record(launchableE2e.producer, "launchableE2e.producer");
  requireEqual(producer.status, "success", "launchableE2e.producer.status");
  const producerRunId = stringField(producer, "runId", "launchableE2e.producer");
  const boot = record(launchableE2e.boot, "launchableE2e.boot");
  requireEqual(boot.repoSha, input.candidateSha, "launchableE2e.boot.repoSha");
  requireEqual(boot.provisionSha, input.candidateSha, "launchableE2e.boot.provisionSha");
  requireEqual(boot.repoClean, true, "launchableE2e.boot.repoClean");

  const workspace = record(launchableE2e.workspace, "launchableE2e.workspace");
  const workspaceName = stringField(workspace, "name", "launchableE2e.workspace");
  const workspaceId = stringField(workspace, "id", "launchableE2e.workspace");
  const cleanup = record(input.cleanup, "cleanup");
  requireEqual(cleanup.workspaceName, workspaceName, "cleanup.workspaceName");
  requireEqual(cleanup.workspaceId, workspaceId, "cleanup.workspaceId");
  requireEqual(cleanup.status, "ABSENT", "cleanup.status");
  const verifiedAt = stringField(cleanup, "verifiedAt", "cleanup");
  if (Number.isNaN(Date.parse(verifiedAt))) {
    throw new Error("cleanup.verifiedAt must be an ISO timestamp");
  }

  return {
    attempt: receiptAttempt,
    candidateSha: input.candidateSha,
    cleanup: {
      status: "ABSENT",
      verifiedAt,
      workspaceId,
      workspaceName,
    },
    dispatch: {
      emptySelectors: true,
      includeStagingBrevLaunchable: true,
    },
    jobUrl,
    launchableE2e: {
      fullE2e: "passed",
      producerRunId,
      provisionSha: input.candidateSha,
      repoClean: true,
      repoSha: input.candidateSha,
    },
    runUrl,
  };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(): void {
  const { values } = parseArgs({
    options: {
      "candidate-sha": { type: "string" },
      "cleanup-json": { type: "string" },
      "dispatch-json": { type: "string" },
      "jobs-json": { type: "string" },
      "launchable-e2e-json": { type: "string" },
      "run-json": { type: "string" },
    },
    strict: true,
  });
  for (const name of [
    "candidate-sha",
    "cleanup-json",
    "dispatch-json",
    "jobs-json",
    "launchable-e2e-json",
    "run-json",
  ] as const) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }

  const summary = validateFullE2eEvidence({
    candidateSha: values["candidate-sha"]!,
    cleanup: readJson(values["cleanup-json"]!),
    dispatch: readJson(values["dispatch-json"]!),
    jobs: readJson(values["jobs-json"]!),
    launchableE2e: readJson(values["launchable-e2e-json"]!),
    run: readJson(values["run-json"]!),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
