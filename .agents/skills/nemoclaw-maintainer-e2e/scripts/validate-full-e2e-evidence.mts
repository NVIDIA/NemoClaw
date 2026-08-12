// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type JsonRecord = Record<string, unknown>;

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/u;
const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const GCP_IMAGE_NAME_PATTERN = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const EXPECTED_GCP_PROJECT = "brevdevprod";
const RFC3339_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;

export interface FullE2eEvidenceInput {
  candidateSha: string;
  cleanup: unknown;
  dispatch: unknown;
  jobs: unknown;
  launchableE2e: unknown;
  run: unknown;
}

export type BrevImageEvidenceMode = "full" | "launchable" | "push";

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
    allowDgxSparkRunnerQueue: false;
    allowJetsonDispatch: false;
    allowJetsonRunnerQueue: false;
    emptySelectors: boolean;
    includeStagingBrevLaunchable: boolean;
  };
  evidenceMode: BrevImageEvidenceMode;
  jobCompletedAt: string;
  jobUrl: string;
  launchableE2e: {
    fullE2e: "passed";
    image: {
      imageCreationTimestamp: string;
      imageId: string;
      imageName: string;
      imageOriginWorkflowRunAttempt: number;
      imageOriginWorkflowRunId: string;
      imageRepositorySha: string;
      imageSelfLink: string;
      observedFamily: "nemoclaw-brev-staging-cpu";
      project: string;
      result: "built" | "reused";
    };
    producerRunId: string;
    provisionSha: string;
    repoClean: true;
    repoSha: string;
  };
  runCreatedAt: string;
  runId: number;
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

function timestampField(value: JsonRecord, key: string, owner: string): string {
  const timestamp = stringField(value, key, owner);
  if (!RFC3339_PATTERN.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${owner}.${key} must be an RFC 3339 timestamp`);
  }
  return timestamp;
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

function requireSha(value: JsonRecord, key: string, owner: string): string {
  const sha = stringField(value, key, owner);
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${owner}.${key} must be a lowercase 40-character SHA`);
  }
  return sha;
}

function requireRepository(value: JsonRecord, key: string, owner: string): string {
  const repository = stringField(value, key, owner);
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`${owner}.${key} must be an owner/repository name`);
  }
  return repository;
}

function validateDispatchIdentity(
  dispatch: JsonRecord,
  candidateSha: string,
  requireDirectMain: boolean,
): string {
  requireEqual(dispatch.candidateSha, candidateSha, "dispatch.candidateSha");
  const kind = stringField(dispatch, "kind", "dispatch");
  if (kind === "nemoclaw-e2e-dispatch-v1") return candidateSha;
  if (kind !== "nemoclaw-e2e-dispatch-v2") {
    throw new Error(
      'dispatch.kind must equal "nemoclaw-e2e-dispatch-v1" or "nemoclaw-e2e-dispatch-v2"',
    );
  }

  requireEqual(dispatch.repository, "NVIDIA/NemoClaw", "dispatch.repository");
  const candidateRepository = requireRepository(dispatch, "candidateRepository", "dispatch");
  const baseSha = requireSha(dispatch, "baseSha", "dispatch");
  const workflowSha = requireSha(dispatch, "workflowSha", "dispatch");
  if (dispatch.prNumber === null) {
    requireEqual(candidateRepository, "NVIDIA/NemoClaw", "dispatch.candidateRepository");
    requireEqual(baseSha, candidateSha, "dispatch.baseSha");
    requireEqual(workflowSha, candidateSha, "dispatch.workflowSha");
  } else {
    positiveIntegerField(dispatch, "prNumber", "dispatch");
    if (requireDirectMain) {
      throw new Error("dispatch.prNumber must be null for release image evidence");
    }
  }
  return workflowSha;
}

function validateEvidence(
  input: FullE2eEvidenceInput,
  evidenceMode: BrevImageEvidenceMode,
  requireDirectMain: boolean,
): FullE2eEvidenceSummary {
  if (!SHA_PATTERN.test(input.candidateSha)) {
    throw new Error("candidate SHA must be a lowercase 40-character SHA");
  }

  const run = record(input.run, "run");
  const expectedEvent = evidenceMode === "push" ? "push" : "workflow_dispatch";
  requireEqual(run.head_branch, "main", "run.head_branch");
  requireEqual(run.event, expectedEvent, "run.event");
  requireEqual(run.path, ".github/workflows/e2e.yaml", "run.path");
  requireEqual(run.status, "completed", "run.status");
  requireEqual(run.conclusion, "success", "run.conclusion");
  const attempt = positiveIntegerField(run, "run_attempt", "run");
  const runUrl = stringField(run, "html_url", "run");
  requireGitHubUrl(runUrl, "run.html_url");
  const runId = positiveIntegerField(run, "id", "run");
  const runCreatedAt = timestampField(run, "created_at", "run");

  const dispatch = record(input.dispatch, "dispatch");
  const expectedWorkflowSha = validateDispatchIdentity(
    dispatch,
    input.candidateSha,
    requireDirectMain,
  );
  requireEqual(run.head_sha, expectedWorkflowSha, "run.head_sha");
  requireEqual(dispatch.eventName, expectedEvent, "dispatch.eventName");
  requireEqual(dispatch.workflowRunId, String(runId), "dispatch.workflowRunId");
  const receiptAttempt = positiveIntegerField(dispatch, "workflowRunAttempt", "dispatch");
  if (receiptAttempt > attempt) {
    throw new Error("dispatch.workflowRunAttempt exceeds run.run_attempt");
  }
  requireEqual(dispatch.targets, "", "dispatch.targets");
  if (evidenceMode === "full") {
    requireEqual(dispatch.jobs, "", "dispatch.jobs");
    requireEqual(
      dispatch.includeStagingBrevLaunchable,
      true,
      "dispatch.includeStagingBrevLaunchable",
    );
    requireEqual(dispatch.emptySelectors, true, "dispatch.emptySelectors");
  } else if (evidenceMode === "launchable") {
    requireEqual(dispatch.jobs, "staging-brev-launchable", "dispatch.jobs");
    requireEqual(
      dispatch.includeStagingBrevLaunchable,
      false,
      "dispatch.includeStagingBrevLaunchable",
    );
    requireEqual(dispatch.emptySelectors, false, "dispatch.emptySelectors");
  } else {
    requireEqual(dispatch.jobs, "", "dispatch.jobs");
    requireEqual(
      dispatch.includeStagingBrevLaunchable,
      false,
      "dispatch.includeStagingBrevLaunchable",
    );
    requireEqual(dispatch.emptySelectors, true, "dispatch.emptySelectors");
  }
  requireEqual(dispatch.allowJetsonRunnerQueue, false, "dispatch.allowJetsonRunnerQueue");
  if (
    dispatch.kind === "nemoclaw-e2e-dispatch-v2" ||
    Object.hasOwn(dispatch, "allowJetsonDispatch")
  ) {
    requireEqual(dispatch.allowJetsonDispatch, false, "dispatch.allowJetsonDispatch");
  }
  requireEqual(dispatch.allowDgxSparkRunnerQueue, false, "dispatch.allowDgxSparkRunnerQueue");

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
  const jobCompletedAt = timestampField(job, "completed_at", "Exact staging Brev Launchable");
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
  if (!DECIMAL_ID_PATTERN.test(producerRunId)) {
    throw new Error("launchableE2e.producer.runId must be a positive decimal ID");
  }

  const image = record(launchableE2e.image, "launchableE2e.image");
  const project = stringField(image, "project", "launchableE2e.image");
  if (!GCP_PROJECT_PATTERN.test(project)) {
    throw new Error("launchableE2e.image.project must be a canonical GCP project ID");
  }
  requireEqual(project, EXPECTED_GCP_PROJECT, "launchableE2e.image.project");
  const imageName = stringField(image, "imageName", "launchableE2e.image");
  if (!GCP_IMAGE_NAME_PATTERN.test(imageName)) {
    throw new Error("launchableE2e.image.imageName must be a canonical GCP image name");
  }
  const imageId = stringField(image, "imageId", "launchableE2e.image");
  if (!DECIMAL_ID_PATTERN.test(imageId)) {
    throw new Error("launchableE2e.image.imageId must be a positive decimal ID");
  }
  const imageSelfLink = stringField(image, "imageSelfLink", "launchableE2e.image");
  const expectedImageSelfLink = `https://www.googleapis.com/compute/v1/projects/${project}/global/images/${imageName}`;
  requireEqual(imageSelfLink, expectedImageSelfLink, "launchableE2e.image.imageSelfLink");
  const imageCreationTimestamp = timestampField(
    image,
    "imageCreationTimestamp",
    "launchableE2e.image",
  );
  const imageRepositorySha = requireSha(image, "imageRepositorySha", "launchableE2e.image");
  const imageOriginWorkflowRunId = stringField(
    image,
    "imageOriginWorkflowRunId",
    "launchableE2e.image",
  );
  if (!DECIMAL_ID_PATTERN.test(imageOriginWorkflowRunId)) {
    throw new Error("launchableE2e.image.imageOriginWorkflowRunId must be a positive decimal ID");
  }
  const imageOriginWorkflowRunAttempt = positiveIntegerField(
    image,
    "imageOriginWorkflowRunAttempt",
    "launchableE2e.image",
  );
  requireEqual(
    image.observedFamily,
    "nemoclaw-brev-staging-cpu",
    "launchableE2e.image.observedFamily",
  );
  const result = stringField(image, "result", "launchableE2e.image");
  if (result !== "built" && result !== "reused") {
    throw new Error('launchableE2e.image.result must equal "built" or "reused"');
  }
  if (result === "built") {
    requireEqual(
      imageOriginWorkflowRunId,
      producerRunId,
      "launchableE2e.image.imageOriginWorkflowRunId",
    );
    requireEqual(
      imageOriginWorkflowRunAttempt,
      1,
      "launchableE2e.image.imageOriginWorkflowRunAttempt",
    );
  }
  const boot = record(launchableE2e.boot, "launchableE2e.boot");
  requireEqual(
    boot.bootImage,
    `projects/${project}/global/images/${imageName}`,
    "launchableE2e.boot.bootImage",
  );
  requireEqual(boot.repoSha, input.candidateSha, "launchableE2e.boot.repoSha");
  requireEqual(boot.provisionSha, input.candidateSha, "launchableE2e.boot.provisionSha");
  requireEqual(
    boot.imageRepositorySha,
    imageRepositorySha,
    "launchableE2e.boot.imageRepositorySha",
  );
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
      allowDgxSparkRunnerQueue: false,
      allowJetsonDispatch: false,
      allowJetsonRunnerQueue: false,
      emptySelectors: evidenceMode !== "launchable",
      includeStagingBrevLaunchable: evidenceMode === "full",
    },
    evidenceMode,
    jobCompletedAt,
    jobUrl,
    launchableE2e: {
      fullE2e: "passed",
      image: {
        imageCreationTimestamp,
        imageId,
        imageName,
        imageOriginWorkflowRunAttempt,
        imageOriginWorkflowRunId,
        imageRepositorySha,
        imageSelfLink,
        observedFamily: "nemoclaw-brev-staging-cpu",
        project,
        result,
      },
      producerRunId,
      provisionSha: input.candidateSha,
      repoClean: true,
      repoSha: input.candidateSha,
    },
    runCreatedAt,
    runId,
    runUrl,
  };
}

export function validateFullE2eEvidence(input: FullE2eEvidenceInput): FullE2eEvidenceSummary {
  return validateEvidence(input, "full", false);
}

export function validateBrevImageEvidence(
  input: FullE2eEvidenceInput,
  evidenceMode: BrevImageEvidenceMode,
): FullE2eEvidenceSummary {
  return validateEvidence(input, evidenceMode, true);
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
      mode: { type: "string" },
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

  const input = {
    candidateSha: values["candidate-sha"]!,
    cleanup: readJson(values["cleanup-json"]!),
    dispatch: readJson(values["dispatch-json"]!),
    jobs: readJson(values["jobs-json"]!),
    launchableE2e: readJson(values["launchable-e2e-json"]!),
    run: readJson(values["run-json"]!),
  };
  const mode = values.mode;
  if (mode !== undefined && mode !== "full" && mode !== "launchable" && mode !== "push") {
    throw new Error('--mode must equal "full", "launchable", or "push"');
  }
  const summary = mode ? validateBrevImageEvidence(input, mode) : validateFullE2eEvidence(input);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
