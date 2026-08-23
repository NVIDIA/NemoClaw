#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";

const TRUSTED_REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const DISPLAY_TITLE = "E2E main";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
// Broad failed-job reruns are not retry evidence: they can replay deterministic
// product, auth, policy, malformed-input, and cleanup failures. Keep observing
// manual attempts for history, but authorize no automatic workflow reruns.
export const E2E_MAX_RETRIES = 0;
export const E2E_MAX_ATTEMPTS = 3;

export type MainRunRetryAction =
  | "failed-no-retry"
  | "ignored"
  | "passed-after-retry"
  | "passed-first-attempt";

type ApiRequest = (path: string, options?: { method?: "GET" }) => Promise<unknown>;

type SourceRun = {
  id: number;
  workflowId: number;
  attempt: number;
  status: "completed";
  conclusion: string;
  event: "push";
  path: typeof WORKFLOW_PATH;
  displayTitle: typeof DISPLAY_TITLE;
  headBranch: "main";
  headSha: string;
  repository: typeof TRUSTED_REPOSITORY;
  headRepository: typeof TRUSTED_REPOSITORY;
  url: string;
};

type AttemptEvidence = {
  attempt: number;
  failedJobs: string[];
  nonSkippedJobs: number;
  runnerMinutes: number;
};

export type MainRunRetryEvidence = {
  schemaVersion: 1;
  sourceRunId: number;
  sourceSha: string;
  sourceAttempt: number;
  sourceConclusion: string;
  sourceUrl: string;
  action: MainRunRetryAction;
  reason: string;
  flaky: boolean;
  maxRetries: typeof E2E_MAX_RETRIES;
  attempts: AttemptEvidence[];
  totalRunnerMinutes: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub returned a non-object response");
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function validateSourceRun(value: unknown): SourceRun {
  const run = record(value);
  const repository = record(run.repository);
  const headRepository = record(run.head_repository);
  if (
    run.status !== "completed" ||
    typeof run.conclusion !== "string" ||
    run.event !== "push" ||
    run.path !== WORKFLOW_PATH ||
    run.display_title !== DISPLAY_TITLE ||
    run.head_branch !== "main" ||
    typeof run.head_sha !== "string" ||
    !SHA_PATTERN.test(run.head_sha) ||
    repository.full_name !== TRUSTED_REPOSITORY ||
    headRepository.full_name !== TRUSTED_REPOSITORY ||
    typeof run.html_url !== "string"
  ) {
    throw new Error("source run is not a completed trusted E2E main push");
  }
  const id = positiveInteger(run.id, "source run ID");
  const expectedUrl = `https://github.com/${TRUSTED_REPOSITORY}/actions/runs/${id}`;
  if (run.html_url !== expectedUrl) throw new Error("source run URL does not match its identity");
  const attempt = positiveInteger(run.run_attempt, "source run attempt");
  if (attempt > E2E_MAX_ATTEMPTS) throw new Error("source run exceeds the retry attempt limit");
  return {
    id,
    workflowId: positiveInteger(run.workflow_id, "workflow ID"),
    attempt,
    status: "completed",
    conclusion: run.conclusion,
    event: "push",
    path: WORKFLOW_PATH,
    displayTitle: DISPLAY_TITLE,
    headBranch: "main",
    headSha: run.head_sha,
    repository: TRUSTED_REPOSITORY,
    headRepository: TRUSTED_REPOSITORY,
    url: run.html_url,
  };
}

function validateLatestRun(value: unknown, source: SourceRun): boolean {
  const response = record(value);
  if (!Array.isArray(response.workflow_runs))
    throw new Error("GitHub returned no workflow run list");
  const eligible = response.workflow_runs
    .map((item) => record(item))
    .find(
      (run) =>
        run.workflow_id === source.workflowId &&
        run.event === "push" &&
        run.path === WORKFLOW_PATH &&
        run.display_title === DISPLAY_TITLE &&
        run.head_branch === "main" &&
        record(run.repository).full_name === TRUSTED_REPOSITORY &&
        record(run.head_repository).full_name === TRUSTED_REPOSITORY,
    );
  return eligible?.id === source.id;
}

const JOB_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

type ValidatedJob = {
  name: string;
  conclusion: string;
  startedAt: string | null;
  completedAt: string | null;
};

function validateJob(value: unknown, attempt: number): ValidatedJob {
  const job = record(value);
  const name = job.name;
  const conclusion = job.conclusion;
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    typeof conclusion !== "string" ||
    !JOB_CONCLUSIONS.has(conclusion) ||
    job.run_attempt !== attempt ||
    job.status !== "completed"
  ) {
    throw new Error("GitHub returned invalid E2E job identity");
  }
  const startedAt = typeof job.started_at === "string" ? job.started_at : null;
  const completedAt = typeof job.completed_at === "string" ? job.completed_at : null;
  if (
    conclusion !== "skipped" &&
    (!startedAt ||
      !TIMESTAMP_PATTERN.test(startedAt) ||
      !completedAt ||
      !TIMESTAMP_PATTERN.test(completedAt))
  ) {
    throw new Error("GitHub returned invalid E2E job timestamps");
  }
  return { name, conclusion, startedAt, completedAt };
}

function validateAttemptEvidence(value: unknown, attempt: number): AttemptEvidence {
  const response = record(value);
  if (
    !Array.isArray(response.jobs) ||
    response.jobs.length === 0 ||
    response.jobs.length > 100 ||
    !Number.isSafeInteger(response.total_count) ||
    response.total_count !== response.jobs.length
  ) {
    throw new Error("GitHub returned an invalid or truncated E2E job list");
  }
  const jobs = response.jobs.map((job) => validateJob(job, attempt));
  const active = jobs.filter((job) => job.conclusion !== "skipped");
  const runnerMilliseconds = active.reduce((total, job) => {
    const duration = Date.parse(job.completedAt!) - Date.parse(job.startedAt!);
    if (!Number.isFinite(duration) || duration < 0)
      throw new Error("GitHub returned invalid job timing");
    return total + duration;
  }, 0);
  return {
    attempt,
    failedJobs: active
      .filter((job) => job.conclusion !== "success")
      .map((job) => job.name)
      .sort(),
    nonSkippedJobs: active.length,
    runnerMinutes: Number((runnerMilliseconds / 60_000).toFixed(2)),
  };
}

export function decideMainRunRetry(source: SourceRun): {
  action: MainRunRetryAction;
  reason: string;
} {
  if (source.conclusion === "success") {
    return source.attempt === 1
      ? { action: "passed-first-attempt", reason: "E2E passed on its first attempt" }
      : { action: "passed-after-retry", reason: `E2E passed on attempt ${source.attempt}` };
  }
  if (source.conclusion !== "failure") {
    return { action: "ignored", reason: `E2E concluded with ${source.conclusion}` };
  }
  return {
    action: "failed-no-retry",
    reason: "E2E failed; retry requires operation-level transient evidence",
  };
}

export async function evaluateMainRunRetry(options: {
  repository: string;
  token: string;
  sourceRunId: number;
  controllerAttempt: number;
  request?: ApiRequest;
}): Promise<MainRunRetryEvidence> {
  if (options.repository !== TRUSTED_REPOSITORY) {
    throw new Error(`E2E retry is restricted to ${TRUSTED_REPOSITORY}`);
  }
  if (!options.token) throw new Error("GitHub token is required");
  positiveInteger(options.sourceRunId, "source run ID");
  if (positiveInteger(options.controllerAttempt, "controller attempt") !== 1) {
    throw new Error("controller reruns cannot request E2E retries");
  }
  const request =
    options.request ??
    ((path, requestOptions) =>
      githubApi<unknown>(path, options.token, {
        method: requestOptions?.method ?? "GET",
        userAgent: "nemoclaw-e2e-main-retry",
      }));
  const runPath = `repos/${options.repository}/actions/runs/${options.sourceRunId}`;
  const source = validateSourceRun(await request(runPath));
  const latestPath = `repos/${options.repository}/actions/workflows/${source.workflowId}/runs?branch=main&event=push&per_page=20`;
  const isLatest = validateLatestRun(await request(latestPath), source);
  const attempts: AttemptEvidence[] = [];
  if (source.conclusion === "success" || source.conclusion === "failure") {
    for (let attempt = 1; attempt <= source.attempt; attempt += 1) {
      attempts.push(
        validateAttemptEvidence(
          await request(`${runPath}/attempts/${attempt}/jobs?per_page=100`),
          attempt,
        ),
      );
    }
  }
  const decision = isLatest
    ? decideMainRunRetry(source)
    : { action: "ignored" as const, reason: "a newer E2E main push exists" };
  return {
    schemaVersion: 1,
    sourceRunId: source.id,
    sourceSha: source.headSha,
    sourceAttempt: source.attempt,
    sourceConclusion: source.conclusion,
    sourceUrl: source.url,
    action: decision.action,
    reason: decision.reason,
    flaky: decision.action === "passed-after-retry",
    maxRetries: E2E_MAX_RETRIES,
    attempts,
    totalRunnerMinutes: Number(
      attempts.reduce((total, attempt) => total + attempt.runnerMinutes, 0).toFixed(2),
    ),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function writeRetryEvidence(file: string, evidence: MainRunRetryEvidence): void {
  const temporaryFile = `${file}.partial.${process.pid}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporaryFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    // lgtm[js/network-data-to-file] GitHub run and job fields pass type, enum,
    // count, and length limits before the controller writes them to a fixed
    // runner-owned path through an exclusive 0600 descriptor.
    fs.writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"); // lgtm[js/http-to-file-access]
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(temporaryFile, file);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporaryFile, { force: true });
  }
}

async function main(): Promise<void> {
  const evidence = await evaluateMainRunRetry({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    token: requiredEnvironment("GITHUB_TOKEN"),
    sourceRunId: integerEnvironment("SOURCE_RUN_ID"),
    controllerAttempt: integerEnvironment("GITHUB_RUN_ATTEMPT"),
  });
  writeRetryEvidence(requiredEnvironment("RETRY_EVIDENCE_PATH"), evidence);
  const message = `${evidence.reason}; ${evidence.totalRunnerMinutes} runner-minutes across ${evidence.sourceAttempt} attempt(s)`;
  if (evidence.flaky) console.log(`::warning title=E2E passed after retry::${message}`);
  else console.log(`::notice title=E2E retry decision::${message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
