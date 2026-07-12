#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

import { githubApi, githubRestPaginated } from "../advisors/github.mts";
import { parseArgs } from "../advisors/io.mts";
import {
  buildRiskPlan,
  RISK_PLAN_VERSION,
  type RiskPlan,
  riskPlanRequiredJobIds,
} from "../advisors/risk-plan.mts";
import { SHARED_E2E_JOB_ID } from "./credential-free-tests.mts";
import { readPrivateRegularFile, writePrivateRegularFile } from "./private-file.ts";
import type { E2eRiskSignal } from "./risk-signal.ts";
import { readFreeStandingJobsInventory } from "./workflow-boundary.mts";

const E2E_WORKFLOW = "e2e.yaml";
const E2E_WORKFLOW_PATH = `.github/workflows/${E2E_WORKFLOW}`;
const CHECK_NAME = "E2E / PR Gate";
const USER_AGENT = "nemoclaw-pr-e2e-gate";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SHARD_PATTERN = /^(?:default|[A-Za-z0-9][A-Za-z0-9_-]*)$/u;
const CORRELATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RUN_REASONS = new Set(["passed", "failed", "interrupted"]);
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_CONTROLLER_ERROR_CHARS = 512;
const MAX_PR_FILES = 3000;
const MAX_ACTIVE_RUN_PAGES_PER_STATUS = 10;
const MAX_REPORTED_CI_JOBS = 10;
const ACTIVE_WORKFLOW_RUN_STATUSES = [
  "requested",
  "waiting",
  "pending",
  "queued",
  "in_progress",
] as const;
const ACTIVE_WORKFLOW_RUN_STATUS_SET = new Set<string>(ACTIVE_WORKFLOW_RUN_STATUSES);
const EVIDENCE_LIMITS = {
  maxDepth: 8,
  maxEntries: 4096,
} as const;

type ControllerPaths = {
  planPath: string;
  statePath: string;
  evidencePath: string;
};

export type ControllerCommand =
  | ({
      mode: "start";
      headSha: string;
      headRepository: string;
      headBranch: string;
      workflowSha: string;
      ciConclusion: string;
      ciRunId: number;
      ciRunAttempt: number;
      prNumber?: number;
    } & ControllerPaths)
  | ({
      mode: "finish";
      checkRunId: number;
      childRunId: number;
      stateHash: string;
    } & ControllerPaths)
  | { mode: "abandon"; checkRunId: number; childRunId?: number }
  | { mode: "cancel"; prNumber: number };

type CheckConclusion = "success" | "failure";

export type PullRequest = {
  number: number;
  state: string;
  changed_files: number;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo: { full_name: string } };
};

type PullRequestListItem = Omit<PullRequest, "changed_files">;

type PullRequestFile = { filename: string; previous_filename?: string };

type WorkflowRun = {
  id: number;
  name: string;
  path: string;
  workflow_id: number;
  event: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  display_title: string;
  html_url: string;
};

type WorkflowRunsResponse = { workflow_runs: WorkflowRun[] };
type WorkflowJob = {
  id: number;
  name: string;
  conclusion: string | null;
  steps: Array<{ name: string; conclusion: string | null }>;
};
type WorkflowJobsPage = { totalCount: number; jobs: WorkflowJob[] };
type CheckRun = { id: number };
type GitReference = { ref: string; object: { type: string; sha: string } };

type WorkflowDispatchDetails = {
  workflow_run_id: number;
  run_url: string;
  html_url: string;
};

type WorkflowRunIdentity = {
  childRunId: number;
  correlationId: string;
  prNumber: number;
  repository: string;
  workflowSha: string;
};

export type PrGateState = {
  version: 1;
  commitSha: string;
  workflowSha: string;
  planHash: string;
  correlationId: string;
  prNumber: number;
  expectedJobs: string[];
  expectedShards: Record<string, string[]>;
};

export type PrGateVerdict = {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
};

export class PrerequisiteCiError extends Error {}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredArgument(value: string | undefined, name: string): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parsePositiveId(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe integer range`);
  return parsed;
}

function parseHash(value: string | undefined, name: string): string {
  const parsed = requiredArgument(value, name);
  if (!HASH_PATTERN.test(parsed)) throw new Error(`--${name} must be a lowercase SHA-256 hash`);
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertRepository(value: string, name: string): void {
  if (!REPOSITORY_PATTERN.test(value)) throw new Error(`${name} must be an owner/repository name`);
}

function assertBranch(value: string): void {
  if (
    value.length > 255 ||
    /[\u0000-\u001f\u007f\\]/u.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    throw new Error("head branch is invalid");
  }
}

function assertRepositoryPath(value: string): void {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000\r\n]/u.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("pull request files contain an unsafe repository path");
  }
}

function tokenAndRepository(): { token: string; repository: string } {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token) throw new Error("GITHUB_TOKEN is required");
  assertRepository(repository, "GITHUB_REPOSITORY");
  return { token, repository };
}

export function privateControllerPaths(workDir: string): ControllerPaths {
  const resolved = path.resolve(workDir);
  const stat = fs.lstatSync(resolved);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    resolved !== workDir ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (currentUid !== null && stat.uid !== currentUid)
  ) {
    throw new Error("--work-dir must be an owned private absolute directory");
  }
  return {
    planPath: path.join(resolved, "risk-plan.json"),
    statePath: path.join(resolved, "controller-state.json"),
    evidencePath: path.join(resolved, "evidence"),
  };
}

export function parseControllerCommand(argv: string[]): ControllerCommand {
  const args = parseArgs(argv);
  if (args.mode === "start") {
    return {
      mode: "start",
      headSha: requiredArgument(args.head, "head"),
      headRepository: requiredArgument(args.headRepo, "head-repo"),
      headBranch: requiredArgument(args.headBranch, "head-branch"),
      workflowSha: requiredArgument(args.workflowSha, "workflow-sha"),
      ciConclusion: requiredArgument(args.ciConclusion, "ci-conclusion"),
      ciRunId: parsePositiveId(requiredArgument(args.ciRunId, "ci-run-id"), "--ci-run-id"),
      ciRunAttempt: parsePositiveId(
        requiredArgument(args.ciRunAttempt, "ci-run-attempt"),
        "--ci-run-attempt",
      ),
      prNumber: args.pr ? parsePositiveId(args.pr, "--pr") : undefined,
      ...privateControllerPaths(requiredArgument(args.workDir, "work-dir")),
    };
  }
  if (args.mode === "finish") {
    return {
      mode: "finish",
      ...privateControllerPaths(requiredArgument(args.workDir, "work-dir")),
      checkRunId: parsePositiveId(requiredArgument(args.checkId, "check-id"), "--check-id"),
      childRunId: parsePositiveId(requiredArgument(args.runId, "run-id"), "--run-id"),
      stateHash: parseHash(args.stateHash, "state-hash"),
    };
  }
  if (args.mode === "abandon") {
    return {
      mode: "abandon",
      checkRunId: parsePositiveId(requiredArgument(args.checkId, "check-id"), "--check-id"),
      childRunId: args.runId ? parsePositiveId(args.runId, "--run-id") : undefined,
    };
  }
  if (args.mode === "cancel") {
    return {
      mode: "cancel",
      prNumber: parsePositiveId(requiredArgument(args.pr, "pr"), "--pr"),
    };
  }
  throw new Error("--mode must be start, finish, abandon, or cancel");
}

function readRegularJson(file: string, maxBytes = MAX_PLAN_BYTES): unknown {
  return JSON.parse(readPrivateRegularFile(file, { maxBytes })!);
}

export function validatePrGateState(value: unknown): PrGateState {
  if (!isObjectRecord(value) || value.version !== 1) {
    throw new Error("State version is invalid");
  }
  if (typeof value.commitSha !== "string" || !SHA_PATTERN.test(value.commitSha)) {
    throw new Error("State commit SHA is invalid");
  }
  if (typeof value.workflowSha !== "string" || !SHA_PATTERN.test(value.workflowSha)) {
    throw new Error("State workflow SHA is invalid");
  }
  if (typeof value.planHash !== "string" || !HASH_PATTERN.test(value.planHash)) {
    throw new Error("State plan hash is invalid");
  }
  if (typeof value.correlationId !== "string" || !CORRELATION_PATTERN.test(value.correlationId)) {
    throw new Error("State correlation ID is invalid");
  }
  if (!Number.isSafeInteger(value.prNumber) || (value.prNumber as number) < 1) {
    throw new Error("State PR number is invalid");
  }
  if (
    !Array.isArray(value.expectedJobs) ||
    value.expectedJobs.length < 1 ||
    !value.expectedJobs.every((job) => typeof job === "string" && JOB_PATTERN.test(job)) ||
    new Set(value.expectedJobs).size !== value.expectedJobs.length
  ) {
    throw new Error("State jobs are invalid");
  }
  if (!isObjectRecord(value.expectedShards)) {
    throw new Error("State shards are invalid");
  }
  const shardJobs = Object.keys(value.expectedShards).sort();
  if (JSON.stringify(shardJobs) !== JSON.stringify([...value.expectedJobs].sort())) {
    throw new Error("State shard jobs do not match expected jobs");
  }
  for (const job of value.expectedJobs) {
    const shards = value.expectedShards[job];
    if (
      !Array.isArray(shards) ||
      shards.length < 1 ||
      new Set(shards).size !== shards.length ||
      !shards.every((shard) => typeof shard === "string" && SHARD_PATTERN.test(shard))
    ) {
      throw new Error(`State shards are invalid for ${job}`);
    }
  }
  return value as PrGateState;
}

export function validateRiskPlan(value: unknown, allowedJobs: ReadonlySet<string>): RiskPlan {
  if (!isObjectRecord(value)) throw new Error("risk plan must be an object");
  if (value.version !== RISK_PLAN_VERSION) throw new Error("unsupported risk-plan version");
  if (typeof value.headSha !== "string" || !SHA_PATTERN.test(value.headSha)) {
    throw new Error("risk plan headSha must be a lowercase 40-character SHA");
  }
  if (
    !Array.isArray(value.changedFiles) ||
    !value.changedFiles.every((file) => typeof file === "string")
  ) {
    throw new Error("risk plan changedFiles must be strings");
  }
  for (const file of value.changedFiles) assertRepositoryPath(file as string);
  const rebuilt = buildRiskPlan({
    headSha: value.headSha,
    changedFiles: value.changedFiles as string[],
  });
  if (JSON.stringify(value) !== JSON.stringify(rebuilt)) {
    throw new Error("risk plan does not match its hash and inputs");
  }
  if (!HASH_PATTERN.test(rebuilt.planHash)) throw new Error("risk plan hash is invalid");
  const selectedJobs = riskPlanRequiredJobIds(rebuilt);
  if (new Set(selectedJobs).size !== selectedJobs.length) {
    throw new Error("risk plan required jobs must be unique");
  }
  for (const job of selectedJobs) {
    if (!JOB_PATTERN.test(job) || !allowedJobs.has(job)) {
      throw new Error(`risk plan names unknown E2E job: ${job}`);
    }
  }
  return rebuilt;
}

export function validateSignal(
  value: unknown,
  state: Pick<
    PrGateState,
    "commitSha" | "planHash" | "correlationId" | "expectedJobs" | "expectedShards"
  >,
): E2eRiskSignal {
  if (!isObjectRecord(value) || value.version !== 1) {
    throw new Error("invalid E2E signal version");
  }
  const signal = value as E2eRiskSignal;
  if (!state.expectedJobs.includes(signal.jobId)) throw new Error("E2E signal job is unexpected");
  if (!state.expectedShards[signal.jobId]?.includes(signal.shardId)) {
    throw new Error("E2E signal shard is unexpected");
  }
  if (signal.expectedSha !== state.commitSha) throw new Error("E2E signal SHA mismatch");
  if (signal.testedSha !== state.commitSha) throw new Error("E2E signal tested SHA mismatch");
  if (signal.planHash !== state.planHash) throw new Error("E2E signal plan hash mismatch");
  if (signal.correlationId !== state.correlationId) {
    throw new Error("E2E signal correlation mismatch");
  }
  for (const key of ["passed", "failed", "skipped", "pending", "unhandledErrors"] as const) {
    if (!Number.isSafeInteger(signal[key]) || signal[key] < 0) {
      throw new Error(`E2E signal ${key} must be a non-negative integer`);
    }
  }
  if (!RUN_REASONS.has(signal.runReason)) {
    throw new Error("E2E signal runReason is invalid");
  }
  return signal;
}

export function classifyPrGateEvidence(options: {
  workflowConclusion: string | null;
  expectedJobs: readonly string[];
  expectedShards: Readonly<Record<string, readonly string[]>>;
  signals: readonly E2eRiskSignal[];
}): PrGateVerdict {
  if (options.workflowConclusion !== "success") {
    return {
      conclusion: "failure",
      title: "E2E run did not succeed",
      summary: `The run concluded ${options.workflowConclusion ?? "without a result"}.`,
    };
  }
  const expectedEvidence = options.expectedJobs.flatMap((job) =>
    (options.expectedShards[job] ?? []).map((shard) => `${job}:${shard}`),
  );
  if (
    options.expectedJobs.length === 0 ||
    options.expectedJobs.some((job) => (options.expectedShards[job]?.length ?? 0) === 0)
  ) {
    return {
      conclusion: "failure",
      title: "Evidence policy is incomplete",
      summary: "At least one selected job has no configured shard policy.",
    };
  }
  const byJobShard = new Map<string, E2eRiskSignal>();
  for (const signal of options.signals) {
    const key = `${signal.jobId}:${signal.shardId}`;
    if (byJobShard.has(key)) {
      return {
        conclusion: "failure",
        title: "Duplicate evidence",
        summary: `More than one signal was uploaded for ${key}.`,
      };
    }
    byJobShard.set(key, signal);
  }
  const missing = expectedEvidence.filter((key) => !byJobShard.has(key));
  if (missing.length > 0) {
    return {
      conclusion: "failure",
      title: "Evidence is missing",
      summary: `Missing signals: ${missing.join(", ")}.`,
    };
  }
  const failed = expectedEvidence.filter((key) => {
    const signal = byJobShard.get(key)!;
    return signal.failed > 0 || signal.unhandledErrors > 0 || signal.runReason === "failed";
  });
  if (failed.length > 0) {
    return {
      conclusion: "failure",
      title: "Tests failed",
      summary: `Failing signals: ${failed.join(", ")}.`,
    };
  }
  const partial = expectedEvidence.filter((key) => {
    const signal = byJobShard.get(key)!;
    return (
      signal.passed < 1 || signal.skipped > 0 || signal.pending > 0 || signal.runReason !== "passed"
    );
  });
  if (partial.length > 0) {
    return {
      conclusion: "failure",
      title: "Evidence is incomplete",
      summary: `Incomplete or skipped signals: ${partial.join(", ")}.`,
    };
  }
  return {
    conclusion: "success",
    title: "All selected jobs passed",
    summary: "Every expected job shard passed with no skips or pending tests.",
  };
}

function appendOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  if (!/^(?:check_id|dispatched|finalized|run_id|state_hash)$/u.test(name)) {
    throw new Error("invalid controller output name");
  }
  const validValue =
    name === "state_hash" ? HASH_PATTERN.test(value) : /^(?:true|false|[1-9][0-9]*)$/u.test(value);
  if (!validValue) throw new Error("invalid controller output value");
  const descriptor = fs.openSync(
    output,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("GITHUB_OUTPUT must be a regular file");
    // lgtm[js/network-data-to-file] Values are reduced to a strict single-line allowlist above,
    // and the runner-owned output file is opened without following symlinks.
    // lgtm[js/http-to-file-access]
    fs.writeFileSync(descriptor, `${name}=${value}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

async function createCheck(
  repository: string,
  token: string,
  headSha: string,
  title: string,
  summary: string,
): Promise<number> {
  const check = await githubApi<CheckRun>(`repos/${repository}/check-runs`, token, {
    method: "POST",
    body: {
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
      output: { title, summary },
    },
    userAgent: USER_AGENT,
  });
  if (!Number.isSafeInteger(check.id) || check.id < 1) {
    throw new Error("GitHub returned an invalid check id");
  }
  return check.id;
}

async function completeCheck(
  context: { repository: string; checkRunId: number },
  token: string,
  verdict: PrGateVerdict,
  detailsUrl?: string,
): Promise<void> {
  await githubApi(`repos/${context.repository}/check-runs/${context.checkRunId}`, token, {
    method: "PATCH",
    body: {
      status: "completed",
      conclusion: verdict.conclusion,
      completed_at: new Date().toISOString(),
      details_url: detailsUrl,
      output: { title: verdict.title, summary: verdict.summary },
    },
    userAgent: USER_AGENT,
  });
}

async function updateRunningCheck(
  context: { repository: string; checkRunId: number },
  token: string,
  options: { childRunId: number; jobs: readonly string[]; planHash: string },
): Promise<void> {
  const childRunUrl = `https://github.com/${context.repository}/actions/runs/${options.childRunId}`;
  await githubApi(`repos/${context.repository}/check-runs/${context.checkRunId}`, token, {
    method: "PATCH",
    body: {
      status: "in_progress",
      details_url: childRunUrl,
      output: {
        title: `Running ${options.jobs.length} E2E ${options.jobs.length === 1 ? "job" : "jobs"}`,
        summary: `Risk plan ${options.planHash} selected: ${options.jobs.join(", ")}.`,
      },
    },
    userAgent: USER_AGENT,
  });
}

function controllerErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const singleLine = message
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return singleLine.length > MAX_CONTROLLER_ERROR_CHARS
    ? `${singleLine.slice(0, MAX_CONTROLLER_ERROR_CHARS - 3)}...`
    : singleLine;
}

async function completeFailureAfterControllerError(
  context: { repository: string; checkRunId: number },
  token: string,
  title: string,
  options: { error: unknown; detailsUrl?: string },
): Promise<boolean> {
  const reason = controllerErrorMessage(options.error).replace(/`/gu, "'");
  try {
    await completeCheck(
      context,
      token,
      {
        conclusion: "failure",
        title,
        summary: `The controller could not complete the check.\n\nController error: \`${reason}\``,
      },
      options.detailsUrl,
    );
    return true;
  } catch (error) {
    console.error(`Failed to close check after controller error: ${controllerErrorMessage(error)}`);
    return false;
  }
}

function validatePullRequestIdentity(value: unknown): PullRequestListItem {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1
  ) {
    throw new Error("GitHub returned an invalid pull request number");
  }
  if (value.state !== "open") throw new Error("GitHub returned invalid pull request state");
  if (!isObjectRecord(value.head) || !isObjectRecord(value.base)) {
    throw new Error("GitHub returned invalid pull request refs");
  }
  const head = value.head;
  const base = value.base;
  if (
    typeof head.ref !== "string" ||
    typeof head.sha !== "string" ||
    !SHA_PATTERN.test(head.sha) ||
    !isObjectRecord(head.repo) ||
    typeof head.repo.full_name !== "string" ||
    !REPOSITORY_PATTERN.test(head.repo.full_name) ||
    typeof base.sha !== "string" ||
    !SHA_PATTERN.test(base.sha) ||
    !isObjectRecord(base.repo) ||
    typeof base.repo.full_name !== "string" ||
    !REPOSITORY_PATTERN.test(base.repo.full_name)
  ) {
    throw new Error("GitHub returned invalid pull request identity");
  }
  return value as PullRequestListItem;
}

function validatePullRequest(value: unknown): PullRequest {
  const identity = validatePullRequestIdentity(value);
  if (!isObjectRecord(value) || !Number.isSafeInteger(value.changed_files)) {
    throw new Error("GitHub returned an invalid pull request changed-file count");
  }
  return { ...identity, changed_files: value.changed_files as number };
}

function pullIdentity(pull: PullRequestListItem): Record<string, unknown> {
  return {
    number: pull.number,
    state: pull.state,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    headRepository: pull.head.repo?.full_name,
    baseSha: pull.base.sha,
    baseRepository: pull.base.repo.full_name,
  };
}

export async function resolvePullRequest(options: {
  repository: string;
  token: string;
  headSha: string;
  headRepository: string;
  headBranch: string;
}): Promise<PullRequest> {
  assertRepository(options.repository, "repository");
  assertRepository(options.headRepository, "head repository");
  if (!options.token) throw new Error("GitHub token is required");
  if (!SHA_PATTERN.test(options.headSha)) throw new Error("head SHA is invalid");
  assertBranch(options.headBranch);
  const owner = options.headRepository.split("/", 1)[0]!;
  const query = encodeURIComponent(`${owner}:${options.headBranch}`);
  const response = await githubApi<unknown>(
    `repos/${options.repository}/pulls?state=open&head=${query}&per_page=100`,
    options.token,
    { userAgent: USER_AGENT },
  );
  if (!Array.isArray(response)) throw new Error("GitHub returned an invalid pull request list");
  const matches = response
    .map(validatePullRequestIdentity)
    .filter(
      (pull) =>
        pull.head.sha === options.headSha &&
        pull.head.ref === options.headBranch &&
        pull.head.repo?.full_name === options.headRepository &&
        pull.base.repo.full_name === options.repository,
    );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one open pull request for the triggering revision; found ${matches.length}`,
    );
  }
  const detail = validatePullRequest(
    await githubApi<unknown>(
      `repos/${options.repository}/pulls/${matches[0]!.number}`,
      options.token,
      {
        userAgent: USER_AGENT,
      },
    ),
  );
  if (JSON.stringify(pullIdentity(matches[0]!)) !== JSON.stringify(pullIdentity(detail))) {
    throw new Error("Pull request identity changed while its details were being resolved");
  }
  return detail;
}

function validateWorkflowJob(value: unknown): WorkflowJob {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    (value.steps !== undefined && !Array.isArray(value.steps))
  ) {
    throw new Error("GitHub returned an invalid workflow job");
  }
  const steps = (value.steps ?? []).map((step) => {
    if (
      !isObjectRecord(step) ||
      typeof step.name !== "string" ||
      step.name.length === 0 ||
      (step.conclusion !== null && typeof step.conclusion !== "string")
    ) {
      throw new Error("GitHub returned an invalid workflow job step");
    }
    return { name: step.name, conclusion: step.conclusion };
  });
  return {
    id: value.id as number,
    name: value.name,
    conclusion: value.conclusion,
    steps,
  };
}

function validateWorkflowJobsPage(value: unknown): WorkflowJobsPage {
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

async function listNonPassingCiJobs(
  repository: string,
  token: string,
  ciRunId: number,
  ciRunAttempt: number,
): Promise<{ jobs: WorkflowJob[]; complete: boolean }> {
  const response = validateWorkflowJobsPage(
    await githubApi<unknown>(
      `repos/${repository}/actions/runs/${ciRunId}/attempts/${ciRunAttempt}/jobs?per_page=100`,
      token,
      { userAgent: USER_AGENT },
    ),
  );
  if (response.jobs.length > response.totalCount) {
    throw new Error("GitHub returned an invalid workflow job count");
  }
  return {
    jobs: response.jobs.filter(
      (job) => !["success", "skipped", "neutral"].includes(job.conclusion ?? ""),
    ),
    complete: response.jobs.length === response.totalCount,
  };
}

function normalizedCiMetadata(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  if (!normalized) return fallback;
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function markdownLinkText(value: string): string {
  return normalizedCiMetadata(value, "unnamed job")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\\/gu, "\\\\")
    .replace(/\[/gu, "\\[")
    .replace(/\]/gu, "\\]");
}

function markdownCode(value: string, fallback: string): string {
  return `\`${normalizedCiMetadata(value, fallback).replace(/`/gu, "'")}\``;
}

function ciFailureReport(options: {
  repository: string;
  prNumber?: number;
  ciRunId: number;
  ciRunAttempt: number;
  ciConclusion: string;
  jobs: readonly WorkflowJob[];
  jobDetailsAvailable: boolean;
  jobDetailsComplete: boolean;
}): { summary: string; errorMessage: string; ciRunUrl: string } {
  const prUrl = options.prNumber
    ? `https://github.com/${options.repository}/pull/${options.prNumber}`
    : undefined;
  const ciRunUrl = `https://github.com/${options.repository}/actions/runs/${options.ciRunId}/attempts/${options.ciRunAttempt}`;
  const conclusion = normalizedCiMetadata(options.ciConclusion, "without a result");
  const reportedJobs = options.jobs.slice(0, MAX_REPORTED_CI_JOBS);
  const ciLink = `[CI / Pull Request attempt ${options.ciRunAttempt}](${ciRunUrl})`;
  const summary = options.prNumber
    ? [
        `[PR #${options.prNumber}](${prUrl}) did not pass ${ciLink} (${markdownCode(conclusion, "without a result")}), so no E2E run was dispatched.`,
      ]
    : [
        `${ciLink} concluded ${markdownCode(conclusion, "without a result")}, so no E2E run was dispatched. The triggering PR was not present in the workflow event.`,
      ];
  if (reportedJobs.length > 0) {
    summary.push("", "Jobs that did not pass:");
    for (const job of reportedJobs) {
      const jobUrl = `https://github.com/${options.repository}/actions/runs/${options.ciRunId}/job/${job.id}`;
      const failedSteps = job.steps.filter((step) => step.conclusion === "failure");
      const detail =
        failedSteps.length > 0
          ? `${failedSteps.length === 1 ? "failed step" : "failed steps"}: ${failedSteps
              .slice(0, 3)
              .map((step) => markdownCode(step.name, "unnamed step"))
              .join(", ")}${failedSteps.length > 3 ? ` and ${failedSteps.length - 3} more` : ""}`
          : `concluded ${markdownCode(job.conclusion ?? "without a result", "without a result")}`;
      summary.push(`- [${markdownLinkText(job.name)}](${jobUrl}) — ${detail}.`);
    }
    if (options.jobs.length > reportedJobs.length) {
      summary.push(
        `- ${options.jobs.length - reportedJobs.length} more; open the CI run for details.`,
      );
    }
    if (!options.jobDetailsComplete) {
      summary.push("- The job listing was truncated; open the CI run for the full result.");
    }
  } else if (options.jobDetailsAvailable) {
    summary.push(
      "",
      options.jobDetailsComplete
        ? "GitHub reported no non-passing job. Open the CI run for details."
        : "The job listing was truncated before a non-passing job was found. Open the CI run for details.",
    );
  } else {
    summary.push("", "Job details could not be loaded. Open the CI run for details.");
  }

  const conciseJobs = reportedJobs.slice(0, 3).map((job) => {
    const failedSteps = job.steps
      .filter((step) => step.conclusion === "failure")
      .slice(0, 2)
      .map((step) => normalizedCiMetadata(step.name, "unnamed step"));
    const detail =
      failedSteps.length > 0 ? failedSteps.join(", ") : (job.conclusion ?? "no result");
    return `${normalizedCiMetadata(job.name, "unnamed job")} (${detail})`;
  });
  const jobMessage =
    conciseJobs.length > 0 ? conciseJobs.join("; ") : "no non-passing job details were available";
  const truncationMessage =
    options.jobDetailsAvailable && !options.jobDetailsComplete ? "; job listing truncated" : "";
  return {
    summary: summary.join("\n"),
    errorMessage: `${options.prNumber ? `PR #${options.prNumber}: ${prUrl}` : "Triggering PR unavailable"}; CI run attempt ${options.ciRunAttempt}: ${ciRunUrl}; CI / Pull Request concluded ${conclusion}; jobs that did not pass: ${jobMessage}${truncationMessage}`,
    ciRunUrl,
  };
}

export async function pullChangedFiles(
  repository: string,
  pull: PullRequest,
  token: string,
): Promise<string[]> {
  assertRepository(repository, "repository");
  if (!token) throw new Error("GitHub token is required");
  if (
    !Number.isSafeInteger(pull.changed_files) ||
    pull.changed_files < 0 ||
    pull.changed_files > MAX_PR_FILES
  ) {
    throw new Error(`Pull request changed-file count must be between 0 and ${MAX_PR_FILES}`);
  }
  const files = await githubRestPaginated<PullRequestFile>(
    `repos/${repository}/pulls/${pull.number}/files`,
    token,
    MAX_PR_FILES,
  );
  if (files.length !== pull.changed_files) {
    throw new Error(
      `Pull request file listing is incomplete: expected ${pull.changed_files}, received ${files.length}`,
    );
  }
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    if (!isObjectRecord(entry) || typeof entry.filename !== "string") {
      throw new Error("GitHub returned an invalid pull request file entry");
    }
    const names = [entry.previous_filename, entry.filename].filter(
      (name): name is string => typeof name === "string",
    );
    for (const name of names) {
      assertRepositoryPath(name);
      if (!seen.has(name)) {
        seen.add(name);
        changed.push(name);
      }
    }
  }
  return changed;
}

function assertPullUnchanged(before: PullRequest, after: PullRequest): void {
  if (
    JSON.stringify({ ...pullIdentity(before), changedFiles: before.changed_files }) !==
    JSON.stringify({ ...pullIdentity(after), changedFiles: after.changed_files })
  ) {
    throw new Error("PR changed during preparation");
  }
}

export function expectedSignalShards(
  jobIds: readonly string[],
  workflowPath = ".github/workflows/e2e.yaml",
): Record<string, string[]> {
  const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as unknown;
  const jobs = isObjectRecord(workflow) && isObjectRecord(workflow.jobs) ? workflow.jobs : {};
  const inventory = readFreeStandingJobsInventory(workflowPath);
  return Object.fromEntries(
    jobIds.map((jobId) => {
      const executionJobId = inventory.targetToJob.get(jobId) ?? jobId;
      if (!isObjectRecord(jobs[executionJobId])) {
        throw new Error(`E2E workflow does not define ${executionJobId} for ${jobId}`);
      }
      const job = jobs[executionJobId];
      if (executionJobId !== jobId) {
        if (executionJobId !== SHARED_E2E_JOB_ID) {
          throw new Error(`${jobId} maps to an unknown shared E2E job`);
        }
        return [jobId, ["default"]];
      }
      const strategy = isObjectRecord(job.strategy) ? job.strategy : {};
      const matrix = isObjectRecord(strategy.matrix) ? strategy.matrix : null;
      let shards = ["default"];
      if (matrix) {
        const keys = Object.keys(matrix);
        if (keys.length === 1 && Array.isArray(matrix.agent)) {
          shards = matrix.agent.filter((value): value is string => typeof value === "string");
          if (shards.length !== matrix.agent.length) {
            throw new Error(`${jobId} matrix agent values must be strings`);
          }
        } else if (keys.length === 1 && Array.isArray(matrix.include)) {
          shards = matrix.include.map((entry) => {
            if (!isObjectRecord(entry) || typeof entry.agent !== "string") {
              throw new Error(`${jobId} matrix include entries must name an agent`);
            }
            return entry.agent;
          });
        } else {
          throw new Error(`${jobId} uses an unsupported evidence matrix`);
        }
      }
      if (
        shards.length === 0 ||
        new Set(shards).size !== shards.length ||
        shards.some((shard) => !SHARD_PATTERN.test(shard))
      ) {
        throw new Error(`${jobId} evidence shards must be unique safe identifiers`);
      }
      return [jobId, shards];
    }),
  );
}

export function validateWorkflowDispatchDetails(
  value: unknown,
  repository: string,
): WorkflowDispatchDetails {
  if (!isObjectRecord(value)) throw new Error("GitHub returned invalid workflow dispatch details");
  const runId = value.workflow_run_id;
  if (!Number.isSafeInteger(runId) || (runId as number) < 1) {
    throw new Error("GitHub returned an invalid dispatched workflow run id");
  }
  const expectedApiUrl = `https://api.github.com/repos/${repository}/actions/runs/${runId}`;
  const expectedHtmlUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  if (value.run_url !== expectedApiUrl || value.html_url !== expectedHtmlUrl) {
    throw new Error("GitHub returned mismatched workflow dispatch URLs");
  }
  return value as WorkflowDispatchDetails;
}

function diagnosticValue(value: unknown): string {
  const serialized = JSON.stringify(value) ?? String(value);
  return serialized.length > 256 ? `${serialized.slice(0, 253)}...` : serialized;
}

export function assertCorrelatedWorkflowRun(
  child: WorkflowRun,
  identity: WorkflowRunIdentity,
): void {
  const childRunUrl = `https://github.com/${identity.repository}/actions/runs/${identity.childRunId}`;
  const mismatches: string[] = [];
  const requireEqual = (field: string, expected: unknown, actual: unknown): void => {
    if (actual !== expected) {
      mismatches.push(
        `${field} expected=${diagnosticValue(expected)} actual=${diagnosticValue(actual)}`,
      );
    }
  };
  requireEqual("id", identity.childRunId, child.id);
  requireEqual("path", E2E_WORKFLOW_PATH, child.path);
  requireEqual("event", "workflow_dispatch", child.event);
  requireEqual("html_url", childRunUrl, child.html_url);
  requireEqual(
    "display_title",
    `E2E PR #${identity.prNumber} (${identity.correlationId})`,
    child.display_title,
  );
  requireEqual("head_sha", identity.workflowSha, child.head_sha);
  if (!Number.isSafeInteger(child.workflow_id) || child.workflow_id < 1) {
    mismatches.push(
      `workflow_id expected="positive safe integer" actual=${diagnosticValue(child.workflow_id)}`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      `E2E run identity mismatch: ${mismatches.join("; ")}; observed run_name=${diagnosticValue(child.name)} workflow_id=${diagnosticValue(child.workflow_id)}`,
    );
  }
}

export async function dispatchPrGate(options: {
  repository: string;
  token: string;
  jobs: readonly string[];
  prNumber: number;
  commitSha: string;
  workflowSha: string;
  planHash: string;
  correlationId: string;
}): Promise<number> {
  assertRepository(options.repository, "repository");
  if (
    !options.token ||
    options.jobs.length < 1 ||
    new Set(options.jobs).size !== options.jobs.length ||
    options.jobs.some((job) => !JOB_PATTERN.test(job)) ||
    !Number.isSafeInteger(options.prNumber) ||
    options.prNumber < 1 ||
    !SHA_PATTERN.test(options.commitSha) ||
    !SHA_PATTERN.test(options.workflowSha) ||
    !HASH_PATTERN.test(options.planHash) ||
    !CORRELATION_PATTERN.test(options.correlationId)
  ) {
    throw new Error("Controller dispatch inputs are invalid");
  }
  const main = await githubApi<GitReference>(
    `repos/${options.repository}/git/ref/heads/main`,
    options.token,
    { userAgent: USER_AGENT },
  );
  if (
    !main ||
    main.ref !== "refs/heads/main" ||
    main.object?.type !== "commit" ||
    main.object.sha !== options.workflowSha
  ) {
    throw new Error(`main no longer points to workflow commit ${options.workflowSha}`);
  }
  const details = await githubApi<unknown>(
    `repos/${options.repository}/actions/workflows/${E2E_WORKFLOW}/dispatches`,
    options.token,
    {
      method: "POST",
      body: {
        ref: "main",
        inputs: {
          jobs: options.jobs.join(","),
          pr_number: String(options.prNumber),
          checkout_sha: options.commitSha,
          plan_hash: options.planHash,
          correlation_id: options.correlationId,
        },
        return_run_details: true,
      },
      userAgent: USER_AGENT,
    },
  );
  return validateWorkflowDispatchDetails(details, options.repository).workflow_run_id;
}

async function cancelChildRun(repository: string, token: string, runId: number): Promise<void> {
  try {
    await githubApi(`repos/${repository}/actions/runs/${runId}/cancel`, token, {
      method: "POST",
      userAgent: USER_AGENT,
    });
  } catch (error) {
    if (/failed: 409\b/u.test(controllerErrorMessage(error))) return;
    throw error;
  }
}

export async function startPrGate(
  command: Extract<ControllerCommand, { mode: "start" }>,
): Promise<void> {
  const { token, repository } = tokenAndRepository();
  if (!SHA_PATTERN.test(command.headSha)) throw new Error("PR head SHA is invalid");
  if (!SHA_PATTERN.test(command.workflowSha)) throw new Error("workflow SHA is invalid");
  assertRepository(command.headRepository, "PR head repository");
  assertBranch(command.headBranch);
  if (command.headRepository !== repository) {
    throw new Error("PR branch must be in the base repository");
  }

  const checkRunId = await createCheck(
    repository,
    token,
    command.headSha,
    "Evaluating PR commit",
    "Validating the PR and selecting E2E jobs.",
  );
  appendOutput("check_id", String(checkRunId));

  let finalized = false;
  let childRunId: number | undefined;
  try {
    if (command.ciConclusion !== "success") {
      let jobs: WorkflowJob[] = [];
      let jobDetailsAvailable = true;
      let jobDetailsComplete: boolean;
      try {
        const details = await listNonPassingCiJobs(
          repository,
          token,
          command.ciRunId,
          command.ciRunAttempt,
        );
        jobs = details.jobs;
        jobDetailsComplete = details.complete;
      } catch (error) {
        jobDetailsAvailable = false;
        jobDetailsComplete = false;
        console.warn(`Could not load CI job details: ${controllerErrorMessage(error)}`);
      }
      const report = ciFailureReport({
        repository,
        prNumber: command.prNumber,
        ciRunId: command.ciRunId,
        ciRunAttempt: command.ciRunAttempt,
        ciConclusion: command.ciConclusion,
        jobs,
        jobDetailsAvailable,
        jobDetailsComplete,
      });
      await completeCheck(
        { repository, checkRunId },
        token,
        {
          conclusion: "failure",
          title: command.prNumber
            ? `PR #${command.prNumber} CI did not pass`
            : "PR CI did not pass",
          summary: report.summary,
        },
        report.ciRunUrl,
      );
      appendOutput("dispatched", "false");
      appendOutput("finalized", "true");
      finalized = true;
      throw new PrerequisiteCiError(report.errorMessage);
    }

    const pull = await resolvePullRequest({
      repository,
      token,
      headSha: command.headSha,
      headRepository: command.headRepository,
      headBranch: command.headBranch,
    });
    if (
      command.headRepository !== repository ||
      pull.head.repo?.full_name !== repository ||
      (command.prNumber !== undefined && pull.number !== command.prNumber)
    ) {
      throw new Error("PR identity does not match the triggering workflow run");
    }

    const changedFiles = await pullChangedFiles(repository, pull, token);
    const allowedJobs = new Set(readFreeStandingJobsInventory().allowedJobs);
    const plan = validateRiskPlan(
      buildRiskPlan({ headSha: command.headSha, changedFiles }),
      allowedJobs,
    );
    writePrivateRegularFile(command.planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const jobs = riskPlanRequiredJobIds(plan);
    const currentPull = await resolvePullRequest({
      repository,
      token,
      headSha: command.headSha,
      headRepository: command.headRepository,
      headBranch: command.headBranch,
    });
    assertPullUnchanged(pull, currentPull);
    if (jobs.length === 0) {
      await completeCheck({ repository, checkRunId }, token, {
        conclusion: "success",
        title: "No E2E jobs selected",
        summary: "No changed files matched an E2E risk rule.",
      });
      appendOutput("dispatched", "false");
      appendOutput("finalized", "true");
      finalized = true;
      console.log(`No run dispatched: pr=${pull.number} plan=${plan.planHash}`);
      return;
    }

    const expectedShards = expectedSignalShards(jobs);
    const correlationId = randomUUID();
    if (!CORRELATION_PATTERN.test(correlationId)) {
      throw new Error("generated correlation ID is invalid");
    }
    childRunId = await dispatchPrGate({
      repository,
      token,
      jobs,
      prNumber: pull.number,
      commitSha: command.headSha,
      workflowSha: command.workflowSha,
      planHash: plan.planHash,
      correlationId,
    });
    appendOutput("run_id", String(childRunId));
    const state: PrGateState = {
      version: 1,
      commitSha: command.headSha,
      workflowSha: command.workflowSha,
      planHash: plan.planHash,
      correlationId,
      prNumber: pull.number,
      expectedJobs: jobs,
      expectedShards,
    };
    const serializedState = `${JSON.stringify(state, null, 2)}\n`;
    writePrivateRegularFile(command.statePath, serializedState);
    await updateRunningCheck({ repository, checkRunId }, token, {
      childRunId,
      jobs,
      planHash: plan.planHash,
    });
    appendOutput("state_hash", sha256(serializedState));
    appendOutput("dispatched", "true");
    console.log(
      `Run dispatched: pr=${pull.number} run=${childRunId} plan=${plan.planHash} jobs=${jobs.join(",")} url=https://github.com/${repository}/actions/runs/${childRunId}`,
    );
  } catch (error) {
    let reportedError = error;
    if (!finalized && childRunId) {
      try {
        await cancelChildRun(repository, token, childRunId);
      } catch (cancelError) {
        reportedError = new Error(
          `${controllerErrorMessage(error)}; child cancellation failed: ${controllerErrorMessage(cancelError)}`,
        );
      }
    }
    if (!finalized) {
      const closed = await completeFailureAfterControllerError(
        { repository, checkRunId },
        token,
        "Run could not start",
        { error: reportedError },
      );
      if (closed) appendOutput("finalized", "true");
    }
    throw reportedError;
  }
}

export function findSignalFiles(
  root: string,
  limits: { maxDepth: number; maxEntries: number; maxSignalFiles: number },
): string[] {
  if (!fs.existsSync(root)) return [];
  if (
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 1 ||
    !Number.isSafeInteger(limits.maxSignalFiles) ||
    limits.maxSignalFiles < 1
  ) {
    throw new Error("E2E evidence traversal limits are invalid");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("E2E evidence root must be a directory, not a symlink");
  }
  const files: string[] = [];
  let entriesVisited = 0;
  const visit = (directory: string, depth: number): void => {
    const handle = fs.opendirSync(directory);
    try {
      let entry = handle.readSync();
      while (entry !== null) {
        entriesVisited += 1;
        if (entriesVisited > limits.maxEntries) {
          throw new Error("E2E evidence exceeds the entry limit");
        }
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("E2E evidence must not contain symlinks");
        if (entry.isDirectory()) {
          if (depth >= limits.maxDepth) throw new Error("E2E evidence exceeds the depth limit");
          visit(full, depth + 1);
        } else if (entry.isFile() && entry.name === "risk-signal.json") {
          files.push(full);
          if (files.length > limits.maxSignalFiles) {
            throw new Error("E2E evidence exceeds the signal-file limit");
          }
        }
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
  };
  visit(root, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

export async function finishPrGate(options: {
  statePath: string;
  stateHash: string;
  evidencePath: string;
  checkRunId: number;
  childRunId: number;
}): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const childRunUrl = `https://github.com/${repository}/actions/runs/${options.childRunId}`;
  const context = { repository, checkRunId: options.checkRunId };
  let finalized = false;
  try {
    if (!HASH_PATTERN.test(options.stateHash)) throw new Error("controller state hash is invalid");
    const serializedState = readPrivateRegularFile(options.statePath, {
      maxBytes: MAX_PLAN_BYTES,
    })!;
    if (sha256(serializedState) !== options.stateHash) {
      throw new Error("controller state changed after E2E dispatch");
    }
    const state = validatePrGateState(JSON.parse(serializedState));
    const child = await githubApi<WorkflowRun>(
      `repos/${repository}/actions/runs/${options.childRunId}`,
      token,
      { userAgent: USER_AGENT },
    );
    assertCorrelatedWorkflowRun(child, {
      childRunId: options.childRunId,
      correlationId: state.correlationId,
      prNumber: state.prNumber,
      repository,
      workflowSha: state.workflowSha,
    });
    if (child.status !== "completed") {
      await cancelChildRun(repository, token, options.childRunId);
      console.log(
        `Cancelled unfinished run during finalization: run=${options.childRunId} status=${child.status} url=${childRunUrl}`,
      );
    }
    const workflowConclusion =
      child.status === "completed" ? child.conclusion : `unfinished (${child.status})`;
    const expectedSignalCount = Object.values(state.expectedShards).reduce(
      (total, shards) => total + shards.length,
      0,
    );
    const signals =
      workflowConclusion === "success"
        ? findSignalFiles(options.evidencePath, {
            ...EVIDENCE_LIMITS,
            maxSignalFiles: expectedSignalCount + 1,
          }).map((file) => validateSignal(readRegularJson(file), state))
        : [];
    const verdict = classifyPrGateEvidence({
      workflowConclusion,
      expectedJobs: state.expectedJobs,
      expectedShards: state.expectedShards,
      signals,
    });
    await completeCheck(context, token, verdict, childRunUrl);
    appendOutput("finalized", "true");
    finalized = true;
    console.log(
      `Run completed: run=${options.childRunId} conclusion=${verdict.conclusion} title=${verdict.title} url=${childRunUrl}`,
    );
    if (verdict.conclusion === "failure") {
      throw new Error(`${verdict.title}: ${verdict.summary}`);
    }
  } catch (error) {
    if (!finalized) {
      const closed = await completeFailureAfterControllerError(
        context,
        token,
        "Evidence could not be verified",
        { error, detailsUrl: childRunUrl },
      );
      if (closed) appendOutput("finalized", "true");
    }
    throw error;
  }
}

export async function abandonPrGate(checkRunId: number, childRunId?: number): Promise<void> {
  const { token, repository } = tokenAndRepository();
  let cancellationError: unknown;
  if (childRunId) {
    try {
      await cancelChildRun(repository, token, childRunId);
    } catch (error) {
      cancellationError = error;
    }
  }
  const cancellationSummary = cancellationError
    ? ` Child cancellation also failed: ${controllerErrorMessage(cancellationError)}.`
    : "";
  await completeCheck({ repository, checkRunId }, token, {
    conclusion: "failure",
    title: "Controller stopped early",
    summary: `The controller stopped before it could complete the check.${cancellationSummary}`,
  });
  appendOutput("finalized", "true");
  if (cancellationError) throw cancellationError;
}

export async function cancelPrGate(prNumber: number): Promise<number> {
  const { token, repository } = tokenAndRepository();
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("PR number is invalid");
  const titlePrefix = `E2E PR #${prNumber} (`;
  const active = new Map<number, WorkflowRun>();
  for (const status of ACTIVE_WORKFLOW_RUN_STATUSES) {
    for (let page = 1; page <= MAX_ACTIVE_RUN_PAGES_PER_STATUS; page += 1) {
      const response = await githubApi<WorkflowRunsResponse>(
        `repos/${repository}/actions/workflows/${E2E_WORKFLOW}/runs?event=workflow_dispatch&status=${status}&per_page=100&page=${page}`,
        token,
        { userAgent: USER_AGENT },
      );
      if (!response || !Array.isArray(response.workflow_runs)) {
        throw new Error("GitHub returned an invalid workflow run list");
      }
      for (const run of response.workflow_runs) {
        if (
          !run.display_title.startsWith(titlePrefix) ||
          !ACTIVE_WORKFLOW_RUN_STATUS_SET.has(run.status)
        ) {
          continue;
        }
        if (!Number.isSafeInteger(run.id) || run.id < 1) {
          throw new Error("GitHub returned an invalid active run ID");
        }
        active.set(run.id, run);
      }
      if (response.workflow_runs.length < 100) break;
      if (page === MAX_ACTIVE_RUN_PAGES_PER_STATUS) {
        throw new Error(`${status} run listing exceeded its page limit`);
      }
    }
  }
  for (const run of active.values()) {
    await cancelChildRun(repository, token, run.id);
    console.log(
      `Cancelled superseded run: pr=${prNumber} run=${run.id} url=https://github.com/${repository}/actions/runs/${run.id}`,
    );
  }
  if (active.size === 0) {
    console.log(`No active E2E runs found for PR #${prNumber}`);
  }
  return active.size;
}

export function controllerErrorAnnotationTitle(error: unknown): string {
  return error instanceof PrerequisiteCiError ? "PR CI did not pass" : "Controller failed";
}

function reportControllerError(error: unknown): void {
  const message = controllerErrorMessage(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    const escaped = message.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
    console.error(`::error title=${controllerErrorAnnotationTitle(error)}::${escaped}`);
  }
}

async function main(): Promise<void> {
  const command = parseControllerCommand(process.argv.slice(2));
  if (command.mode === "start") {
    await startPrGate(command);
    return;
  }
  if (command.mode === "finish") {
    await finishPrGate({
      statePath: command.statePath,
      stateHash: command.stateHash,
      evidencePath: command.evidencePath,
      checkRunId: command.checkRunId,
      childRunId: command.childRunId,
    });
    return;
  }
  if (command.mode === "abandon") {
    await abandonPrGate(command.checkRunId, command.childRunId);
    return;
  }
  await cancelPrGate(command.prNumber);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    reportControllerError(error);
    process.exit(1);
  });
}
