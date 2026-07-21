#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnOptions, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

import { githubApi, githubRestPaginated } from "../advisors/github.mts";
import { parseArgs } from "../advisors/io.mts";
import {
  buildRiskPlan,
  isPrE2eTypedTargetId,
  RISK_PLAN_VERSION,
  type RiskPlan,
  requiresCredentialedE2eAuthorization,
  riskPlanRequiredJobIds,
  riskPlanRequiredTargetIds,
} from "../advisors/risk-plan.mts";
import { SHARED_E2E_JOB_ID } from "./credential-free-tests.mts";
import { readPrivateRegularFile, writePrivateRegularFile } from "./private-file.mts";
import type { E2eRiskSignal } from "./risk-signal.ts";
import {
  decideRetry,
  detectRunnerLoss,
  type WorkflowAttemptEvidence,
} from "./runner-pressure-core.mts";
import {
  focusedE2eJobsForChangedFiles,
  readFreeStandingJobsInventory,
} from "./workflow-boundary.mts";

const E2E_WORKFLOW = "e2e.yaml";
const E2E_WORKFLOW_PATH = `.github/workflows/${E2E_WORKFLOW}`;
const PR_GATE_WORKFLOW_PATH = ".github/workflows/pr-e2e-gate.yaml";
const PR_GATE_APPROVAL_ENVIRONMENT = "approve-credentialed-e2e-skip-for-fork-pr";
const CHECK_NAME = "E2E / PR Gate Coordination";
const WORKFLOW_NAME = "E2E / PR Gate Controller";
const CONTROL_PLANE_AUTHORIZATION_TITLE = "Maintainer authorization required to run E2E";
const RETRYABLE_FAILURE_MARKER_PREFIX = "<!-- nemoclaw-pr-e2e-retry:v1:";
const RETRYABLE_FAILURE_MARKER_SUFFIX = " -->";
const RETRYABLE_FAILURE_REASONS = new Set([
  "prerequisite-ci",
  "child-cancelled",
  "evidence-download",
] as const);
const NEVER_RETRY_FAILURE_TITLES = new Set([
  "Authorized E2E run requires reconciliation",
  "PR base changed",
  "Controller stopped early",
  "Run could not start",
]);
const CHECK_EXTERNAL_ID_PREFIX = "nemoclaw-pr-e2e:v2";
const LEGACY_CHECK_EXTERNAL_ID_PREFIX = "nemoclaw-pr-e2e:v1";
const GITHUB_ACTIONS_APP_ID = 15368;
const USER_AGENT = "nemoclaw-pr-e2e-gate";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CI_DISPLAY_TITLE_PATTERN =
  /^CI PR #([1-9][0-9]*) head ([a-f0-9]{40}) base ([a-f0-9]{40}) gate true$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SHARD_PATTERN = /^(?:default|[A-Za-z0-9][A-Za-z0-9_-]*)$/u;
const CORRELATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RUN_REASONS = new Set(["passed", "failed", "interrupted"]);
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_CONTROLLER_ERROR_CHARS = 512;
const MAX_PR_FILES = 3000;
const MAX_COMPATIBILITY_FILES = 300;
const MAX_ACTIVE_RUN_PAGES_PER_STATUS = 10;
const MAX_WORKFLOW_JOB_PAGES = 10;
const MAX_REPORTED_WORKFLOW_JOBS = 10;
const MAX_WAIVER_REASON_CHARS = 500;
const MAX_APPROVAL_REVIEWS = 20;
const MAINTAINER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const EVIDENCE_URL_PATTERN =
  /^https:\/\/github\.com\/NVIDIA\/NemoClaw\/actions\/runs\/[1-9][0-9]*$/u;
const ACTIVE_WORKFLOW_RUN_STATUSES = [
  "requested",
  "waiting",
  "pending",
  "queued",
  "in_progress",
] as const;
const ACTIVE_WORKFLOW_RUN_STATUS_SET = new Set<string>(ACTIVE_WORKFLOW_RUN_STATUSES);
const TERMINAL_WORKFLOW_RUN_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
] as const;
const TERMINAL_WORKFLOW_RUN_CONCLUSION_SET = new Set<string>(TERMINAL_WORKFLOW_RUN_CONCLUSIONS);
const WAIT_POLL_INTERVAL_MS = 10_000;
const WAIT_TIMEOUT_MS = 105 * 60_000;
const EVIDENCE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const EVIDENCE_DOWNLOAD_KILL_GRACE_MS = 30_000;
const EVIDENCE_LIMITS = {
  maxDepth: 8,
  maxEntries: 4096,
} as const;

type ControllerPaths = {
  planPath: string;
  statePath: string;
  evidencePath: string;
};

type EvidenceStepOutcome = "success" | "failure" | "cancelled" | "skipped";

type ManualForkSkipCommandBase = {
  prNumber: number;
  headSha: string;
  baseSha: string;
  workflowSha: string;
  maintainer: string;
  reason: string;
  evidenceUrl?: string;
};

type ManualForkSkipCommand = ManualForkSkipCommandBase & { mode: "record-fork-e2e-skip" };

type ApprovedForkSkipCommand = {
  mode: "record-approved-fork-e2e-skip";
  prNumber: number;
  headSha: string;
  baseSha: string;
  workflowSha: string;
  approvalRunId: number;
  approvalRunAttempt: number;
};

type ControlPlaneDispatchCommand = {
  mode: "start-control-plane";
  prNumber: number;
  headSha: string;
  baseSha: string;
  workflowSha: string;
  maintainer: string;
  reason: string;
  gateRunId: number;
  workflowRunAttempt: number;
} & ControllerPaths;

type ForkSkipCommand = ManualForkSkipCommand & {
  validatedApproval?: {
    environment: typeof PR_GATE_APPROVAL_ENVIRONMENT;
    runUrl: string;
  };
};

export type ControllerCommand =
  | { mode: "seed"; prNumber: number; headSha: string; baseSha: string }
  | ({
      mode: "start";
      headSha: string;
      headRepository: string;
      headBranch: string;
      workflowSha: string;
      ciConclusion: string;
      ciDisplayTitle: string;
      ciRunId: number;
      ciRunAttempt: number;
      gateRunId: number;
      prNumber?: number;
    } & ControllerPaths)
  | ({
      mode: "finish";
      checkRunId: number;
      childRunId: number;
      stateHash: string;
      evidenceOutcome: EvidenceStepOutcome;
    } & ControllerPaths)
  | { mode: "abandon"; checkRunId: number; childRunId?: number }
  | { mode: "cancel"; prNumber: number }
  | { mode: "wait"; childRunId: number }
  | ({ mode: "download"; childRunId: number } & ControllerPaths)
  | ControlPlaneDispatchCommand
  | ManualForkSkipCommand
  | ApprovedForkSkipCommand;

type CheckConclusion = "success" | "failure" | "cancelled";

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
  status?: string;
  conclusion: string | null;
  runnerId?: number | null;
  runnerName?: string | null;
  labels?: string[];
  steps: Array<{ name: string; status?: string; conclusion: string | null }>;
};
type WorkflowJobsPage = { totalCount: number; jobs: WorkflowJob[] };
type CheckRun = {
  id: number;
  name?: string;
  head_sha?: string;
  external_id?: string | null;
  status?: string;
  conclusion?: string | null;
  details_url?: string | null;
  output?: { title?: string; summary?: string };
  app?: { id?: number } | null;
};
type CheckRunsResponse = { total_count: number; check_runs: CheckRun[] };
type PrGateCheckContext = {
  repository: string;
  checkRunId: number;
  prNumber: number;
  headSha: string;
  baseSha: string;
};
type CollaboratorPermission = {
  role_name?: string;
  permission?: string;
  user?: { login?: string };
};

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
  version: 3;
  commitSha: string;
  baseSha: string;
  workflowSha: string;
  planHash: string;
  correlationId: string;
  prNumber: number;
  expectedJobs: string[];
  expectedTargets: string[];
  expectedShards: Record<string, string[]>;
};

export type PrGateVerdict = {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  retryableFailureReason?: RetryableFailureReason;
};

type RetryableFailureReason = "prerequisite-ci" | "child-cancelled" | "evidence-download";

class ObsoleteExactDiffError extends Error {
  readonly verdict: PrGateVerdict;

  constructor(verdict: PrGateVerdict) {
    super(`${verdict.title}: ${verdict.summary}`);
    this.name = "ObsoleteExactDiffError";
    this.verdict = verdict;
  }
}

class DispatchedChildRunError extends Error {
  readonly childRunId: number;

  constructor(message: string, childRunId: number) {
    super(message);
    this.name = "DispatchedChildRunError";
    this.childRunId = childRunId;
  }
}

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

function parseEvidenceStepOutcome(value: string | undefined): EvidenceStepOutcome {
  const outcome = requiredArgument(value, "evidence-outcome");
  if (!["success", "failure", "cancelled", "skipped"].includes(outcome)) {
    throw new Error("--evidence-outcome must be success, failure, cancelled, or skipped");
  }
  return outcome as EvidenceStepOutcome;
}

export function parseCiRunIdentity(displayTitle: string): {
  prNumber: number;
  headSha: string;
  baseSha: string;
} {
  const match = CI_DISPLAY_TITLE_PATTERN.exec(displayTitle);
  if (!match) throw new Error("CI run title does not contain a valid PR and base identity");
  return {
    prNumber: parsePositiveId(match[1]!, "CI run PR number"),
    headSha: match[2]!,
    baseSha: match[3]!,
  };
}

function normalizedWaiverReason(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  if (normalized.length < 10 || normalized.length > MAX_WAIVER_REASON_CHARS) {
    throw new Error(`--reason must contain 10-${MAX_WAIVER_REASON_CHARS} printable characters`);
  }
  return normalized;
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
  if (args.mode === "seed") {
    return {
      mode: "seed",
      prNumber: parsePositiveId(requiredArgument(args.pr, "pr"), "--pr"),
      headSha: requiredArgument(args.head, "head"),
      baseSha: requiredArgument(args.base, "base"),
    };
  }
  if (args.mode === "start") {
    return {
      mode: "start",
      headSha: requiredArgument(args.head, "head"),
      headRepository: requiredArgument(args.headRepo, "head-repo"),
      headBranch: requiredArgument(args.headBranch, "head-branch"),
      workflowSha: requiredArgument(args.workflowSha, "workflow-sha"),
      ciConclusion: requiredArgument(args.ciConclusion, "ci-conclusion"),
      ciDisplayTitle: requiredArgument(args.ciDisplayTitle, "ci-display-title"),
      ciRunId: parsePositiveId(requiredArgument(args.ciRunId, "ci-run-id"), "--ci-run-id"),
      ciRunAttempt: parsePositiveId(
        requiredArgument(args.ciRunAttempt, "ci-run-attempt"),
        "--ci-run-attempt",
      ),
      gateRunId: parsePositiveId(requiredArgument(args.gateRunId, "gate-run-id"), "--gate-run-id"),
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
      evidenceOutcome: parseEvidenceStepOutcome(args.evidenceOutcome),
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
  if (args.mode === "wait") {
    return {
      mode: "wait",
      childRunId: parsePositiveId(requiredArgument(args.runId, "run-id"), "--run-id"),
    };
  }
  if (args.mode === "download") {
    return {
      mode: "download",
      childRunId: parsePositiveId(requiredArgument(args.runId, "run-id"), "--run-id"),
      ...privateControllerPaths(requiredArgument(args.workDir, "work-dir")),
    };
  }
  if (args.mode === "start-control-plane") {
    const maintainer = requiredArgument(args.maintainer, "maintainer");
    if (!MAINTAINER_PATTERN.test(maintainer)) throw new Error("--maintainer is invalid");
    const workflowRunAttempt = parsePositiveId(
      requiredArgument(args.workflowRunAttempt, "workflow-run-attempt"),
      "--workflow-run-attempt",
    );
    if (workflowRunAttempt !== 1) {
      throw new Error("--workflow-run-attempt must be exactly 1");
    }
    return {
      mode: "start-control-plane",
      prNumber: parsePositiveId(requiredArgument(args.pr, "pr"), "--pr"),
      headSha: requiredArgument(args.head, "head"),
      baseSha: requiredArgument(args.base, "base"),
      workflowSha: requiredArgument(args.workflowSha, "workflow-sha"),
      maintainer,
      reason: normalizedWaiverReason(requiredArgument(args.reason, "reason")),
      gateRunId: parsePositiveId(requiredArgument(args.gateRunId, "gate-run-id"), "--gate-run-id"),
      workflowRunAttempt,
      ...privateControllerPaths(requiredArgument(args.workDir, "work-dir")),
    };
  }
  if (args.mode === "record-fork-e2e-skip") {
    const maintainer = requiredArgument(args.maintainer, "maintainer");
    if (!MAINTAINER_PATTERN.test(maintainer)) throw new Error("--maintainer is invalid");
    const evidenceUrl = args.evidenceUrl?.trim();
    if (evidenceUrl && !EVIDENCE_URL_PATTERN.test(evidenceUrl)) {
      throw new Error(
        "Evidence URL must be an Actions run URL such as https://github.com/NVIDIA/NemoClaw/actions/runs/123. PR, issue, comment, job, and external URLs are not accepted. Leave the field blank if no run exists.",
      );
    }
    return {
      mode: args.mode,
      prNumber: parsePositiveId(requiredArgument(args.pr, "pr"), "--pr"),
      headSha: requiredArgument(args.head, "head"),
      baseSha: requiredArgument(args.base, "base"),
      workflowSha: requiredArgument(args.workflowSha, "workflow-sha"),
      maintainer,
      reason: normalizedWaiverReason(requiredArgument(args.reason, "reason")),
      ...(evidenceUrl ? { evidenceUrl } : {}),
    };
  }
  if (args.mode === "record-approved-fork-e2e-skip") {
    const approvalRunAttempt = parsePositiveId(
      requiredArgument(args.approvalRunAttempt, "approval-run-attempt"),
      "--approval-run-attempt",
    );
    if (approvalRunAttempt !== 1) {
      throw new Error("--approval-run-attempt must be exactly 1");
    }
    return {
      mode: "record-approved-fork-e2e-skip",
      prNumber: parsePositiveId(requiredArgument(args.pr, "pr"), "--pr"),
      headSha: requiredArgument(args.head, "head"),
      baseSha: requiredArgument(args.base, "base"),
      workflowSha: requiredArgument(args.workflowSha, "workflow-sha"),
      approvalRunId: parsePositiveId(
        requiredArgument(args.approvalRunId, "approval-run-id"),
        "--approval-run-id",
      ),
      approvalRunAttempt,
    };
  }
  throw new Error(
    "--mode must be seed, start, start-control-plane, finish, abandon, cancel, wait, download, record-fork-e2e-skip, or record-approved-fork-e2e-skip",
  );
}

function readRegularJson(file: string, maxBytes = MAX_PLAN_BYTES): unknown {
  return JSON.parse(readPrivateRegularFile(file, { maxBytes })!);
}

export function validatePrGateState(value: unknown): PrGateState {
  if (!isObjectRecord(value) || value.version !== 3) {
    throw new Error("State version is invalid");
  }
  if (typeof value.commitSha !== "string" || !SHA_PATTERN.test(value.commitSha)) {
    throw new Error("State commit SHA is invalid");
  }
  if (typeof value.baseSha !== "string" || !SHA_PATTERN.test(value.baseSha)) {
    throw new Error("State base SHA is invalid");
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
    !value.expectedJobs.every((job) => typeof job === "string" && JOB_PATTERN.test(job)) ||
    new Set(value.expectedJobs).size !== value.expectedJobs.length
  ) {
    throw new Error("State jobs are invalid");
  }
  if (
    !Array.isArray(value.expectedTargets) ||
    !value.expectedTargets.every(
      (target) =>
        typeof target === "string" && JOB_PATTERN.test(target) && isPrE2eTypedTargetId(target),
    ) ||
    new Set(value.expectedTargets).size !== value.expectedTargets.length
  ) {
    throw new Error("State targets are invalid");
  }
  const expectedSelections = [...value.expectedJobs, ...value.expectedTargets];
  if (
    expectedSelections.length < 1 ||
    new Set(expectedSelections).size !== expectedSelections.length
  ) {
    throw new Error("State E2E selections are invalid");
  }
  if (!isObjectRecord(value.expectedShards)) {
    throw new Error("State shards are invalid");
  }
  const shardJobs = Object.keys(value.expectedShards).sort();
  if (JSON.stringify(shardJobs) !== JSON.stringify([...expectedSelections].sort())) {
    throw new Error("State shard selections do not match expected jobs and targets");
  }
  for (const selection of expectedSelections) {
    const shards = value.expectedShards[selection];
    if (
      !Array.isArray(shards) ||
      shards.length < 1 ||
      new Set(shards).size !== shards.length ||
      !shards.every((shard) => typeof shard === "string" && SHARD_PATTERN.test(shard))
    ) {
      throw new Error(`State shards are invalid for ${selection}`);
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
    focusedE2eJobs: focusedE2eJobsForChangedFiles(value.changedFiles as string[]),
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
  const selectedTargets = riskPlanRequiredTargetIds(rebuilt);
  if (new Set(selectedTargets).size !== selectedTargets.length) {
    throw new Error("risk plan required targets must be unique");
  }
  for (const target of selectedTargets) {
    if (!JOB_PATTERN.test(target) || !isPrE2eTypedTargetId(target)) {
      throw new Error(`risk plan names unknown PR E2E target: ${target}`);
    }
  }
  return rebuilt;
}

function riskPlanSelectionIds(plan: RiskPlan): string[] {
  return [...riskPlanRequiredJobIds(plan), ...riskPlanRequiredTargetIds(plan)];
}

function riskPlanSelectionSummary(plan: RiskPlan): string {
  const jobs = riskPlanRequiredJobIds(plan);
  const targets = riskPlanRequiredTargetIds(plan);
  return [
    jobs.length > 0 ? `jobs: ${jobs.join(", ")}` : "",
    targets.length > 0 ? `targets: ${targets.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function validateSignal(
  value: unknown,
  state: Pick<
    PrGateState,
    | "commitSha"
    | "planHash"
    | "correlationId"
    | "expectedJobs"
    | "expectedTargets"
    | "expectedShards"
  >,
): E2eRiskSignal {
  if (!isObjectRecord(value) || value.version !== 1) {
    throw new Error("invalid E2E signal version");
  }
  const signal = value as E2eRiskSignal;
  if (![...state.expectedJobs, ...state.expectedTargets].includes(signal.jobId)) {
    throw new Error("E2E signal job or target is unexpected");
  }
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
  expectedTargets?: readonly string[];
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
  const expectedSelections = [...options.expectedJobs, ...(options.expectedTargets ?? [])];
  const expectedEvidence = expectedSelections.flatMap((selection) =>
    (options.expectedShards[selection] ?? []).map((shard) => `${selection}:${shard}`),
  );
  if (
    expectedSelections.length === 0 ||
    expectedSelections.some((selection) => (options.expectedShards[selection]?.length ?? 0) === 0)
  ) {
    return {
      conclusion: "failure",
      title: "Evidence policy is incomplete",
      summary: "At least one selected E2E check has no configured shard policy.",
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
    title: "All selected E2E checks passed",
    summary: "Every expected E2E check shard passed with no skips or pending tests.",
  };
}

function appendOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const validators: Readonly<Record<string, (candidate: string) => boolean>> = {
    check_id: (candidate) => /^[1-9][0-9]*$/u.test(candidate),
    dispatched: (candidate) => /^(?:true|false)$/u.test(candidate),
    fork_skip_base_sha: (candidate) => SHA_PATTERN.test(candidate),
    fork_skip_head_sha: (candidate) => SHA_PATTERN.test(candidate),
    fork_skip_mode: (candidate) => candidate === "record-fork-e2e-skip",
    fork_skip_pr_number: (candidate) => /^[1-9][0-9]*$/u.test(candidate),
    finalized: (candidate) => /^(?:true|false)$/u.test(candidate),
    run_id: (candidate) => /^[1-9][0-9]*$/u.test(candidate),
    state_hash: (candidate) => HASH_PATTERN.test(candidate),
  };
  const validator = validators[name];
  if (!validator) throw new Error("invalid controller output name");
  const validValue = validator(value);
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

export function prGateExternalId(prNumber: number, headSha: string, baseSha: string): string {
  if (
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !SHA_PATTERN.test(headSha) ||
    !SHA_PATTERN.test(baseSha)
  ) {
    throw new Error("PR gate check identity is invalid");
  }
  return `${CHECK_EXTERNAL_ID_PREFIX}:${prNumber}:${headSha}:${baseSha}`;
}

function emitForkSkipOutputs(
  mode: ManualForkSkipCommand["mode"],
  prNumber: number,
  headSha: string,
  baseSha: string,
): void {
  appendOutput("fork_skip_mode", mode);
  appendOutput("fork_skip_pr_number", String(prNumber));
  appendOutput("fork_skip_head_sha", headSha);
  appendOutput("fork_skip_base_sha", baseSha);
}

function validateCheckRunsResponse(value: unknown): CheckRunsResponse {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.check_runs)
  ) {
    throw new Error("GitHub returned an invalid check-run listing");
  }
  const checkRuns = value.check_runs.map((check) => {
    if (!isObjectRecord(check) || !Number.isSafeInteger(check.id) || (check.id as number) < 1) {
      throw new Error("GitHub returned an invalid check run");
    }
    return check as CheckRun;
  });
  if (checkRuns.length !== value.total_count) {
    throw new Error("GitHub returned an incomplete check-run listing");
  }
  return { total_count: value.total_count as number, check_runs: checkRuns };
}

async function listPrGateChecks(options: {
  repository: string;
  token: string;
  headSha: string;
}): Promise<CheckRun[]> {
  const response = validateCheckRunsResponse(
    await githubApi<unknown>(
      `repos/${options.repository}/commits/${options.headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`,
      options.token,
      { userAgent: USER_AGENT },
    ),
  );
  return response.check_runs.filter(
    (check) => check.name === CHECK_NAME && check.head_sha === options.headSha,
  );
}

function isPrGateLineage(check: CheckRun, prNumber: number, headSha: string): boolean {
  const externalId = check.external_id;
  return (
    externalId === `${LEGACY_CHECK_EXTERNAL_ID_PREFIX}:${prNumber}:${headSha}` ||
    (typeof externalId === "string" &&
      externalId.startsWith(`${CHECK_EXTERNAL_ID_PREFIX}:${prNumber}:${headSha}:`))
  );
}

function retryableFailureMarker(reason: RetryableFailureReason): string {
  return `${RETRYABLE_FAILURE_MARKER_PREFIX}${reason}${RETRYABLE_FAILURE_MARKER_SUFFIX}`;
}

function retryableFailureReason(check: CheckRun): RetryableFailureReason | undefined {
  if (check.status !== "completed" || check.conclusion !== "failure") return undefined;
  if (NEVER_RETRY_FAILURE_TITLES.has(check.output?.title ?? "")) return undefined;
  const summary = check.output?.summary;
  if (typeof summary !== "string") return undefined;
  const markerBoundary = `\n\n${RETRYABLE_FAILURE_MARKER_PREFIX}`;
  const markerStart = summary.lastIndexOf(markerBoundary);
  if (markerStart < 0) return undefined;
  const marker = summary.slice(markerStart + 2);
  if (!marker.endsWith(RETRYABLE_FAILURE_MARKER_SUFFIX)) return undefined;
  const reason = marker.slice(
    RETRYABLE_FAILURE_MARKER_PREFIX.length,
    -RETRYABLE_FAILURE_MARKER_SUFFIX.length,
  );
  if (!RETRYABLE_FAILURE_REASONS.has(reason as RetryableFailureReason)) return undefined;
  if (marker !== retryableFailureMarker(reason as RetryableFailureReason)) return undefined;
  return reason as RetryableFailureReason;
}

function priorRunnerLossRunUrls(
  repository: string,
  history: readonly CheckRun[],
  currentCheckId: number,
): string[] {
  const prefix = `https://github.com/${repository}/actions/runs/`;
  const priorRunnerLossChecks = history.filter(
    (check) => check.id !== currentCheckId && retryableFailureReason(check) === "child-cancelled",
  );
  if (priorRunnerLossChecks.length > 1) {
    throw new Error("Runner-loss retry history exceeds the single permitted retry");
  }
  return priorRunnerLossChecks.map((check) => {
    const url = check.details_url;
    if (
      typeof url !== "string" ||
      !url.startsWith(prefix) ||
      !/^[1-9][0-9]*$/u.test(url.slice(prefix.length))
    ) {
      throw new Error("Runner-loss retry history has an invalid child-run URL");
    }
    return url;
  });
}

function withRunnerLossLineage(
  verdict: PrGateVerdict,
  priorRunUrls: readonly string[],
  currentRunUrl: string,
): PrGateVerdict {
  if (priorRunUrls.length === 0) return verdict;
  const links = [...priorRunUrls, currentRunUrl].map(
    (url, index) => `[attempt ${index + 1}](${url})`,
  );
  return {
    ...verdict,
    summary: `${verdict.summary}\nRunner-loss retry lineage: ${links.join(" → ")}.`,
  };
}

function currentExactDiffCheck(checks: CheckRun[]): CheckRun | undefined {
  if (checks.length === 0) return undefined;
  const ordered = [...checks].sort((left, right) => left.id - right.id);
  if (new Set(ordered.map((check) => check.id)).size !== ordered.length) {
    throw new Error("Duplicate PR gate check IDs exist for one PR/base SHA pair");
  }
  const active = ordered.filter((check) => check.status !== "completed");
  if (active.length > 1)
    throw new Error("Multiple active PR gate checks exist for one PR/base SHA pair");
  const history = ordered.slice(0, -1);
  if (history.some((check) => retryableFailureReason(check) === undefined)) {
    throw new Error("PR gate history contains a non-retryable older check for one PR/base SHA pair");
  }
  const current = ordered.at(-1)!;
  if (active[0] && active[0].id !== current.id) {
    throw new Error("PR gate history for one PR/base SHA pair contains an older active check");
  }
  return current;
}

async function matchingPrGateHistory(options: {
  repository: string;
  token: string;
  headSha: string;
  baseSha: string;
  prNumber: number;
}): Promise<CheckRun[]> {
  const externalId = prGateExternalId(options.prNumber, options.headSha, options.baseSha);
  const sameIdentity = (await listPrGateChecks(options)).filter(
    (check) => check.external_id === externalId,
  );
  if (sameIdentity.some((check) => check.app?.id !== GITHUB_ACTIONS_APP_ID)) {
    throw new Error("PR gate check identity was claimed by an unexpected GitHub App");
  }
  const history = sameIdentity
    .filter((check) => check.app?.id === GITHUB_ACTIONS_APP_ID)
    .sort((left, right) => left.id - right.id);
  currentExactDiffCheck(history);
  return history;
}

async function matchingPrGateChecks(options: {
  repository: string;
  token: string;
  headSha: string;
  baseSha: string;
  prNumber: number;
}): Promise<CheckRun[]> {
  const history = await matchingPrGateHistory(options);
  const current = history.at(-1);
  return current ? [current] : [];
}

function validatePrGateMutationResponse(
  value: unknown,
  expected: {
    checkRunId?: number;
    status: string;
    conclusion: string | null;
    prNumber?: number;
    headSha?: string;
    baseSha?: string;
    title?: string;
    summary?: string;
  },
): CheckRun {
  if (!isObjectRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) < 1) {
    throw new Error("GitHub returned an invalid PR gate check mutation response");
  }
  const check = value as CheckRun;
  if (
    (expected.checkRunId !== undefined && check.id !== expected.checkRunId) ||
    check.name !== CHECK_NAME ||
    check.app?.id !== GITHUB_ACTIONS_APP_ID ||
    check.status !== expected.status ||
    check.conclusion !== expected.conclusion ||
    (expected.title !== undefined && check.output?.title !== expected.title) ||
    (expected.summary !== undefined && check.output?.summary !== expected.summary)
  ) {
    throw new Error("GitHub did not persist the expected PR gate check state");
  }
  if (
    expected.prNumber !== undefined &&
    expected.headSha !== undefined &&
    expected.baseSha !== undefined &&
    (check.head_sha !== expected.headSha ||
      check.external_id !== prGateExternalId(expected.prNumber, expected.headSha, expected.baseSha))
  ) {
    throw new Error("GitHub returned a mismatched PR gate check identity");
  }
  return check;
}

async function createPrGateCheck(options: {
  repository: string;
  token: string;
  headSha: string;
  baseSha: string;
  prNumber: number;
}): Promise<CheckRun> {
  const externalId = prGateExternalId(options.prNumber, options.headSha, options.baseSha);
  const title = "Waiting for PR CI";
  const summary =
    "This PR SHA and base SHA are reserved for deterministic E2E planning after CI completes.";
  const check = await githubApi<unknown>(`repos/${options.repository}/check-runs`, options.token, {
    method: "POST",
    body: {
      name: CHECK_NAME,
      head_sha: options.headSha,
      external_id: externalId,
      status: "in_progress",
      output: {
        title,
        summary,
      },
    },
    userAgent: USER_AGENT,
  });
  return validatePrGateMutationResponse(check, {
    status: "in_progress",
    conclusion: null,
    prNumber: options.prNumber,
    headSha: options.headSha,
    baseSha: options.baseSha,
    title,
    summary,
  });
}

async function ensurePrGateCheck(options: {
  repository: string;
  token: string;
  headSha: string;
  baseSha: string;
  prNumber: number;
  replaceRetryableCompleted?: boolean;
}): Promise<number> {
  const checks = await listPrGateChecks(options);
  const lineage = checks.filter((check) =>
    isPrGateLineage(check, options.prNumber, options.headSha),
  );
  if (lineage.some((check) => check.app?.id !== GITHUB_ACTIONS_APP_ID)) {
    throw new Error("PR gate check identity was claimed by an unexpected GitHub App");
  }
  const externalId = prGateExternalId(options.prNumber, options.headSha, options.baseSha);
  const existing = lineage.filter((check) => check.external_id === externalId);
  const current = currentExactDiffCheck(existing);
  for (const stale of lineage.filter((check) => check.external_id !== externalId)) {
    if (stale.status === "completed") continue;
    await completeCheck({ repository: options.repository, checkRunId: stale.id }, options.token, {
      conclusion: "failure",
      title: "PR base changed",
      summary:
        "This check was computed for an earlier PR base and cannot authorize the current diff.",
    });
  }
  if (
    current &&
    !(options.replaceRetryableCompleted && retryableFailureReason(current) !== undefined)
  ) {
    return current.id;
  }
  const check = await createPrGateCheck(options);
  return check.id;
}

export async function seedPrGate(
  prNumber: number,
  headSha: string,
  baseSha: string,
): Promise<number> {
  const { token, repository } = tokenAndRepository();
  if (!SHA_PATTERN.test(headSha)) throw new Error("PR head SHA is invalid");
  if (!SHA_PATTERN.test(baseSha)) throw new Error("PR base SHA is invalid");
  await requireLiveExactDiff({ repository, token, prNumber, headSha, baseSha });
  const checkRunId = await ensurePrGateCheck({
    repository,
    token,
    headSha,
    baseSha,
    prNumber,
  });
  console.log(
    `PR gate reserved: pr=${prNumber} pr_sha=${headSha} base_sha=${baseSha} check=${checkRunId}`,
  );
  return checkRunId;
}

async function markCheckInProgress(
  context: PrGateCheckContext,
  token: string,
  title: string,
  summary: string,
): Promise<void> {
  const check = await githubApi<unknown>(
    `repos/${context.repository}/check-runs/${context.checkRunId}`,
    token,
    {
      method: "PATCH",
      body: { status: "in_progress", output: { title, summary } },
      userAgent: USER_AGENT,
    },
  );
  validatePrGateMutationResponse(check, {
    checkRunId: context.checkRunId,
    status: "in_progress",
    conclusion: null,
    prNumber: context.prNumber,
    headSha: context.headSha,
    baseSha: context.baseSha,
    title,
    summary,
  });
}

function assertCheckCanStart(check: CheckRun | undefined, ciConclusion: string): void {
  if (!check) return;
  if (check.status === "in_progress" && check.conclusion === null) return;
  const reason = retryableFailureReason(check);
  if (ciConclusion === "success" && reason) return;
  const title = normalizedCiMetadata(check.output?.title ?? "untitled", "untitled");
  throw new Error(
    `Existing PR gate state for this PR/base SHA pair is not retryable: status=${check.status ?? "unknown"} conclusion=${check.conclusion ?? "none"} title=${title}`,
  );
}

async function completeCheck(
  context: { repository: string; checkRunId: number },
  token: string,
  verdict: PrGateVerdict,
  detailsUrl?: string,
): Promise<void> {
  const summary = verdict.retryableFailureReason
    ? `${verdict.summary}\n\n${retryableFailureMarker(verdict.retryableFailureReason)}`
    : verdict.summary;
  const check = await githubApi<unknown>(
    `repos/${context.repository}/check-runs/${context.checkRunId}`,
    token,
    {
      method: "PATCH",
      body: {
        status: "completed",
        conclusion: verdict.conclusion,
        completed_at: new Date().toISOString(),
        details_url: detailsUrl,
        output: {
          title: verdict.title,
          summary,
        },
      },
      userAgent: USER_AGENT,
    },
  );
  validatePrGateMutationResponse(check, {
    checkRunId: context.checkRunId,
    status: "completed",
    conclusion: verdict.conclusion,
    title: verdict.title,
    summary,
  });
}

async function updateRunningCheck(
  context: PrGateCheckContext,
  token: string,
  options: {
    childRunId: number;
    jobs: readonly string[];
    targets: readonly string[];
    planHash: string;
  },
): Promise<void> {
  const childRunUrl = `https://github.com/${context.repository}/actions/runs/${options.childRunId}`;
  const selectionCount = options.jobs.length + options.targets.length;
  const title = `Running ${selectionCount} E2E ${selectionCount === 1 ? "check" : "checks"}`;
  const summary = `Risk plan ${options.planHash} selected jobs: ${options.jobs.join(", ") || "none"}; targets: ${options.targets.join(", ") || "none"}.`;
  const check = await githubApi<unknown>(
    `repos/${context.repository}/check-runs/${context.checkRunId}`,
    token,
    {
      method: "PATCH",
      body: {
        status: "in_progress",
        details_url: childRunUrl,
        output: {
          title,
          summary,
        },
      },
      userAgent: USER_AGENT,
    },
  );
  validatePrGateMutationResponse(check, {
    checkRunId: context.checkRunId,
    status: "in_progress",
    conclusion: null,
    prNumber: context.prNumber,
    headSha: context.headSha,
    baseSha: context.baseSha,
    title,
    summary,
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
  options: {
    error: unknown;
    detailsUrl?: string;
    recovery?: string;
    retryableFailureReason?: RetryableFailureReason;
  },
): Promise<boolean> {
  const reason = controllerErrorMessage(options.error).replace(/`/gu, "'");
  try {
    await completeCheck(
      context,
      token,
      {
        conclusion: "failure",
        title,
        summary: [
          "The controller could not complete the check.",
          options.recovery,
          `Controller error: \`${reason}\``,
        ]
          .filter((paragraph): paragraph is string => Boolean(paragraph))
          .join("\n\n"),
        retryableFailureReason: options.retryableFailureReason,
      },
      options.detailsUrl,
    );
    return true;
  } catch (error) {
    console.error(`Failed to close check after controller error: ${controllerErrorMessage(error)}`);
    return false;
  }
}

function validatePullRequestIdentity(
  value: unknown,
  options: { allowClosed?: boolean } = {},
): PullRequestListItem {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1
  ) {
    throw new Error("GitHub returned an invalid pull request number");
  }
  if (value.state !== "open" && (!options.allowClosed || value.state !== "closed")) {
    throw new Error("GitHub returned invalid pull request state");
  }
  if (!isObjectRecord(value.head) || !isObjectRecord(value.base)) {
    throw new Error("GitHub returned invalid pull request refs");
  }
  const head = value.head;
  const base = value.base;
  const validHeadRepository =
    isObjectRecord(head.repo) &&
    typeof head.repo.full_name === "string" &&
    REPOSITORY_PATTERN.test(head.repo.full_name);
  const closedWithDeletedHeadRepository =
    options.allowClosed === true && value.state === "closed" && head.repo === null;
  if (
    typeof head.ref !== "string" ||
    typeof head.sha !== "string" ||
    !SHA_PATTERN.test(head.sha) ||
    (!validHeadRepository && !closedWithDeletedHeadRepository) ||
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

function validatePullRequest(value: unknown, options: { allowClosed?: boolean } = {}): PullRequest {
  const identity = validatePullRequestIdentity(value, options);
  if (!isObjectRecord(value) || !Number.isSafeInteger(value.changed_files)) {
    throw new Error("GitHub returned an invalid pull request changed-file count");
  }
  return { ...identity, changed_files: value.changed_files as number };
}

async function requireLiveExactDiff(options: {
  repository: string;
  token: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}): Promise<PullRequest> {
  const pull = validatePullRequest(
    await githubApi<unknown>(
      `repos/${options.repository}/pulls/${options.prNumber}`,
      options.token,
      {
        userAgent: USER_AGENT,
      },
    ),
    { allowClosed: true },
  );
  if (pull.number !== options.prNumber || pull.base.repo.full_name !== options.repository) {
    throw new Error("GitHub returned mismatched pull request identity");
  }
  const prUrl = `https://github.com/${options.repository}/pull/${options.prNumber}`;
  if (pull.state === "closed") {
    throw new ObsoleteExactDiffError({
      conclusion: "cancelled",
      title: "PR closed — gate no longer applies",
      summary: `[PR #${options.prNumber}](${prUrl}) closed before this gate completed. This check for head \`${options.headSha.slice(0, 7)}\` on base \`${options.baseSha.slice(0, 7)}\` no longer applies.`,
    });
  }
  if (!pull.head.repo || pull.head.sha !== options.headSha || pull.base.sha !== options.baseSha) {
    throw new ObsoleteExactDiffError({
      conclusion: "cancelled",
      title: "Superseded by PR update",
      summary: `[PR #${options.prNumber}](${prUrl}) moved from head \`${options.headSha.slice(0, 7)}\` on base \`${options.baseSha.slice(0, 7)}\` to head \`${pull.head.sha.slice(0, 7)}\` on base \`${pull.base.sha.slice(0, 7)}\`. No result from this run was accepted; review the gate on the current PR revision.`,
    });
  }
  return pull;
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
    .map((candidate) => validatePullRequestIdentity(candidate))
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

async function listNonPassingWorkflowJobs(
  repository: string,
  token: string,
  runId: number,
  runAttempt?: number,
): Promise<{ jobs: WorkflowJob[]; complete: boolean }> {
  const jobs: WorkflowJob[] = [];
  let totalCount: number | undefined;
  for (let page = 1; page <= MAX_WORKFLOW_JOB_PAGES; page += 1) {
    const runPath = runAttempt ? `runs/${runId}/attempts/${runAttempt}` : `runs/${runId}`;
    const response = validateWorkflowJobsPage(
      await githubApi<unknown>(
        `repos/${repository}/actions/${runPath}/jobs?per_page=100&page=${page}`,
        token,
        { userAgent: USER_AGENT },
      ),
    );
    totalCount ??= response.totalCount;
    if (response.totalCount !== totalCount || jobs.length + response.jobs.length > totalCount) {
      throw new Error("GitHub returned an invalid workflow job count");
    }
    jobs.push(...response.jobs);
    if (jobs.length === totalCount) {
      return {
        jobs: jobs.filter(
          (job) => !["success", "skipped", "neutral"].includes(job.conclusion ?? ""),
        ),
        complete: true,
      };
    }
    if (response.jobs.length < 100) break;
  }
  return {
    jobs: jobs.filter((job) => !["success", "skipped", "neutral"].includes(job.conclusion ?? "")),
    complete: jobs.length === totalCount,
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

function nonPassingJobDetails(options: {
  runUrl: string;
  runLabel: string;
  jobs: readonly WorkflowJob[];
  available: boolean;
  complete: boolean;
}): { lines: string[]; reportedJobs: readonly WorkflowJob[] } {
  const reportedJobs = options.jobs.slice(0, MAX_REPORTED_WORKFLOW_JOBS);
  const lines: string[] = [];
  if (reportedJobs.length > 0) {
    lines.push("", "Jobs that did not pass:");
    for (const job of reportedJobs) {
      const jobUrl = `${options.runUrl}/job/${job.id}`;
      const failedSteps = job.steps.filter((step) => step.conclusion === "failure");
      const detail =
        failedSteps.length > 0
          ? `${failedSteps.length === 1 ? "failed step" : "failed steps"}: ${failedSteps
              .slice(0, 3)
              .map((step) => markdownCode(step.name, "unnamed step"))
              .join(", ")}${failedSteps.length > 3 ? ` and ${failedSteps.length - 3} more` : ""}`
          : `concluded ${markdownCode(job.conclusion ?? "without a result", "without a result")}`;
      lines.push(`- [${markdownLinkText(job.name)}](${jobUrl}) — ${detail}.`);
    }
    if (options.jobs.length > reportedJobs.length) {
      lines.push(
        `- ${options.jobs.length - reportedJobs.length} more; open the ${options.runLabel} for details.`,
      );
    }
    if (!options.complete) {
      lines.push(
        `- The job listing was truncated; open the ${options.runLabel} for the full result.`,
      );
    }
  } else if (options.available) {
    lines.push(
      "",
      options.complete
        ? `GitHub reported no non-passing job. Open the ${options.runLabel} for details.`
        : `The job listing was truncated before a non-passing job was found. Open the ${options.runLabel} for details.`,
    );
  } else {
    lines.push("", `Job details could not be loaded. Open the ${options.runLabel} for details.`);
  }
  return { lines, reportedJobs };
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
  const runUrl = `https://github.com/${options.repository}/actions/runs/${options.ciRunId}`;
  const conclusion = normalizedCiMetadata(options.ciConclusion, "without a result");
  const ciLink = `[CI / Pull Request attempt ${options.ciRunAttempt}](${ciRunUrl})`;
  const summary = options.prNumber
    ? [
        `[PR #${options.prNumber}](${prUrl}) did not pass ${ciLink} (${markdownCode(conclusion, "without a result")}), so no E2E run was dispatched.`,
      ]
    : [
        `${ciLink} concluded ${markdownCode(conclusion, "without a result")}, so no E2E run was dispatched. The triggering PR was not present in the workflow event.`,
      ];
  const details = nonPassingJobDetails({
    runUrl,
    runLabel: "CI run",
    jobs: options.jobs,
    available: options.jobDetailsAvailable,
    complete: options.jobDetailsComplete,
  });
  summary.push(...details.lines);

  const conciseJobs = details.reportedJobs.slice(0, 3).map((job) => {
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

const GITHUB_HOSTED_RUNNER_NAME_PATTERN = /^GitHub Actions [1-9][0-9]*$/u;

/**
 * GitHub records a lost hosted runner as a completed failed job whose active
 * step never received a terminal conclusion. This is stronger than a
 * cancellation: user and concurrency cancellations finish the active step and
 * run cleanup, while the release-run failures tracked by #7146 retained one
 * `in_progress` step after the job itself became terminal.
 */
function hasTrustedHostedRunnerLossMarker(job: WorkflowJob): boolean {
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

function verifiedRunnerLossEvidence(options: {
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
    (job) => job.conclusion === "failure" && !hasTrustedHostedRunnerLossMarker(job),
  );
  return {
    terminalClassificationPresent: ordinaryFailureEvidencePresent,
    jobConclusion: options.workflowConclusion as "failure" | "cancelled",
    runnerLostMarkerCount,
  };
}

export function e2eFailureReport(options: {
  repository: string;
  runId: number;
  workflowConclusion: string | null;
  jobs: readonly WorkflowJob[];
  jobDetailsAvailable: boolean;
  jobDetailsComplete: boolean;
  runnerLossAttempt: number;
  runnerLossEvidence: WorkflowAttemptEvidence | null;
}): PrGateVerdict {
  const runUrl = `https://github.com/${options.repository}/actions/runs/${options.runId}`;
  const conclusion = normalizedCiMetadata(
    options.workflowConclusion ?? "without a result",
    "without a result",
  );
  const summary = [
    `[Selected E2E run ${options.runId}](${runUrl}) concluded ${markdownCode(conclusion, "without a result")}. No passing result was accepted.`,
  ];
  const details = nonPassingJobDetails({
    runUrl,
    runLabel: "E2E run",
    jobs: options.jobs,
    available: options.jobDetailsAvailable,
    complete: options.jobDetailsComplete,
  });
  summary.push(...details.lines);
  const title =
    details.reportedJobs.length === 1
      ? `${normalizedCiMetadata(details.reportedJobs[0]!.name, "Selected E2E job")} ${details.reportedJobs[0]!.conclusion === "failure" ? "failed" : "did not pass"}`
      : "Selected E2E did not pass";
  const conclusivelyCancelled =
    options.workflowConclusion === "cancelled" ||
    (options.jobDetailsAvailable &&
      options.jobDetailsComplete &&
      options.jobs.length > 0 &&
      options.jobs.every((job) => job.conclusion === "cancelled"));
  const retryDecision = options.runnerLossEvidence
    ? decideRetry({
        runnerLoss: detectRunnerLoss(options.runnerLossEvidence),
        classification: null,
        attempt: options.runnerLossAttempt,
      })
    : {
        retry: false,
        reason: "no verified hosted-runner-loss marker was available",
      };
  if (conclusivelyCancelled || (options.runnerLossEvidence?.runnerLostMarkerCount ?? 0) > 0) {
    summary.push(`Runner-loss policy: ${retryDecision.reason}.`);
  }
  return {
    conclusion: "failure",
    title,
    summary: summary.join("\n"),
    ...(retryDecision.retry ? { retryableFailureReason: "child-cancelled" as const } : {}),
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
  targetIds: readonly string[] = [],
): Record<string, string[]> {
  const selections = [...jobIds, ...targetIds];
  if (new Set(selections).size !== selections.length) {
    throw new Error("E2E evidence jobs and targets must be unique");
  }
  for (const targetId of targetIds) {
    if (!isPrE2eTypedTargetId(targetId)) {
      throw new Error(`PR E2E target is not approved: ${targetId}`);
    }
  }
  const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as unknown;
  const jobs = isObjectRecord(workflow) && isObjectRecord(workflow.jobs) ? workflow.jobs : {};
  const inventory = readFreeStandingJobsInventory(workflowPath);
  const jobShards = Object.fromEntries(
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
          const env = isObjectRecord(job.env) ? job.env : {};
          const configuredShard = env.NEMOCLAW_E2E_SHARD;
          let shardKey = "agent";
          if (configuredShard !== undefined) {
            const match =
              typeof configuredShard === "string"
                ? /^\$\{\{\s*matrix\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/u.exec(configuredShard)
                : null;
            if (!match) {
              throw new Error(`${jobId} NEMOCLAW_E2E_SHARD must name one matrix include field`);
            }
            shardKey = match[1]!;
          }
          shards = matrix.include.map((entry) => {
            if (!isObjectRecord(entry) || !Object.hasOwn(entry, shardKey)) {
              throw new Error(`${jobId} matrix include entries must name a ${shardKey} shard`);
            }
            const shard = entry[shardKey];
            if (typeof shard !== "string") {
              throw new Error(`${jobId} matrix include entries must name a ${shardKey} shard`);
            }
            return shard;
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
  return {
    ...jobShards,
    ...Object.fromEntries(targetIds.map((targetId) => [targetId, ["default"]])),
  };
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

function validateMainReference(value: unknown): string {
  if (
    !isObjectRecord(value) ||
    value.ref !== "refs/heads/main" ||
    !isObjectRecord(value.object) ||
    value.object.type !== "commit" ||
    typeof value.object.sha !== "string" ||
    !SHA_PATTERN.test(value.object.sha)
  ) {
    throw new Error("GitHub returned an invalid main branch reference");
  }
  return value.object.sha;
}

function validateCompatibleMainComparison(
  value: unknown,
  workflowSha: string,
  mainSha: string,
): void {
  if (
    !isObjectRecord(value) ||
    value.status !== "ahead" ||
    !Number.isSafeInteger(value.ahead_by) ||
    (value.ahead_by as number) < 1 ||
    value.behind_by !== 0 ||
    !isObjectRecord(value.base_commit) ||
    value.base_commit.sha !== workflowSha ||
    !isObjectRecord(value.merge_base_commit) ||
    value.merge_base_commit.sha !== workflowSha ||
    !isObjectRecord(value.head_commit) ||
    value.head_commit.sha !== mainSha ||
    !Array.isArray(value.files)
  ) {
    throw new Error(`main is not a validated descendant of workflow commit ${workflowSha}`);
  }
  if (value.files.length >= MAX_COMPATIBILITY_FILES) {
    throw new Error("main advance changed too many files to validate completely");
  }
  const changedFiles = new Set<string>();
  for (const entry of value.files) {
    if (
      !isObjectRecord(entry) ||
      typeof entry.filename !== "string" ||
      (entry.previous_filename !== undefined && typeof entry.previous_filename !== "string")
    ) {
      throw new Error("GitHub returned an invalid main comparison file");
    }
    for (const file of [entry.previous_filename, entry.filename]) {
      if (typeof file !== "string") continue;
      assertRepositoryPath(file);
      changedFiles.add(file);
    }
  }
  const plan = buildRiskPlan({ headSha: mainSha, changedFiles: [...changedFiles] });
  if (plan.families.some((family) => family.id === "e2e-control-plane")) {
    throw new Error(`main advanced through trusted E2E control-plane changes after ${workflowSha}`);
  }
}

async function readMainWorkflowCommit(repository: string, token: string): Promise<string> {
  return validateMainReference(
    await githubApi<unknown>(`repos/${repository}/git/ref/heads/main`, token, {
      userAgent: USER_AGENT,
    }),
  );
}

async function compatibleMainWorkflowCommit(
  repository: string,
  token: string,
  workflowSha: string,
): Promise<string> {
  const mainSha = await readMainWorkflowCommit(repository, token);
  if (mainSha === workflowSha) return mainSha;
  const comparison = await githubApi<unknown>(
    `repos/${repository}/compare/${workflowSha}...${mainSha}`,
    token,
    { userAgent: USER_AGENT },
  );
  validateCompatibleMainComparison(comparison, workflowSha, mainSha);
  const confirmedMainSha = await readMainWorkflowCommit(repository, token);
  if (confirmedMainSha !== mainSha) {
    throw new Error(`main changed again while validating workflow commit ${workflowSha}`);
  }
  return mainSha;
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
  targets?: readonly string[];
  prNumber: number;
  commitSha: string;
  baseSha: string;
  workflowSha: string;
  planHash: string;
  correlationId: string;
}): Promise<{ runId: number; workflowSha: string }> {
  assertRepository(options.repository, "repository");
  const targets = options.targets ?? [];
  if (
    !options.token ||
    options.jobs.length + targets.length < 1 ||
    new Set(options.jobs).size !== options.jobs.length ||
    options.jobs.some((job) => !JOB_PATTERN.test(job)) ||
    new Set(targets).size !== targets.length ||
    targets.some((target) => !JOB_PATTERN.test(target) || !isPrE2eTypedTargetId(target)) ||
    options.jobs.some((job) => targets.includes(job)) ||
    !Number.isSafeInteger(options.prNumber) ||
    options.prNumber < 1 ||
    !SHA_PATTERN.test(options.commitSha) ||
    !SHA_PATTERN.test(options.baseSha) ||
    !SHA_PATTERN.test(options.workflowSha) ||
    !HASH_PATTERN.test(options.planHash) ||
    !CORRELATION_PATTERN.test(options.correlationId)
  ) {
    throw new Error("Controller dispatch inputs are invalid");
  }
  const workflowSha = await compatibleMainWorkflowCommit(
    options.repository,
    options.token,
    options.workflowSha,
  );
  const details = await githubApi<unknown>(
    `repos/${options.repository}/actions/workflows/${E2E_WORKFLOW}/dispatches`,
    options.token,
    {
      method: "POST",
      body: {
        ref: "main",
        inputs: {
          jobs: options.jobs.join(","),
          targets: targets.join(","),
          pr_number: String(options.prNumber),
          checkout_sha: options.commitSha,
          base_sha: options.baseSha,
          workflow_sha: workflowSha,
          plan_hash: options.planHash,
          correlation_id: options.correlationId,
        },
        return_run_details: true,
      },
      userAgent: USER_AGENT,
    },
  );
  const runId = validateWorkflowDispatchDetails(details, options.repository).workflow_run_id;
  return { runId, workflowSha };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForChildRun(
  childRunId: number,
  deps: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const wait = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? WAIT_TIMEOUT_MS;
  const runUrl = `https://github.com/${repository}/actions/runs/${childRunId}`;
  const deadline = now() + timeoutMs;
  let lastState = "";
  while (true) {
    let run: WorkflowRun;
    try {
      run = await githubApi<WorkflowRun>(`repos/${repository}/actions/runs/${childRunId}`, token, {
        userAgent: USER_AGENT,
        signal: AbortSignal.timeout(Math.max(1, deadline - now())),
      });
    } catch (error) {
      throw new Error(
        `Run status query failed: unable to query run ${childRunId}. ${runUrl} (${controllerErrorMessage(error)})`,
      );
    }
    const conclusion = run.conclusion && run.conclusion.length > 0 ? run.conclusion : "none";
    const state = `${run.status}:${conclusion}`;
    const active = ACTIVE_WORKFLOW_RUN_STATUS_SET.has(run.status) && conclusion === "none";
    const completed =
      run.status === "completed" && TERMINAL_WORKFLOW_RUN_CONCLUSION_SET.has(conclusion);
    if (state !== lastState) {
      if (active) {
        console.log(`Run ${childRunId} status=${run.status} url=${runUrl}`);
      } else if (completed) {
        console.log(`Run ${childRunId} status=completed conclusion=${conclusion} url=${runUrl}`);
      }
      lastState = state;
    }
    if (completed) return;
    if (!active) {
      throw new Error(
        `Unexpected run state: run ${childRunId} returned an unsupported status/conclusion pair (${state}). ${runUrl}`,
      );
    }
    if (now() >= deadline) {
      console.log(
        `Run ${childRunId} did not complete within ${Math.round(timeoutMs / 60_000)} minutes; finalization will cancel it and report the PR gate outcome. ${runUrl}`,
      );
      return;
    }
    await wait(pollIntervalMs);
  }
}

type EvidenceDownloadResult = { code: number | null; timedOut: boolean };

interface SpawnedEvidenceProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

type SpawnEvidenceImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedEvidenceProcess;

function spawnEvidenceDownload(
  args: string[],
  timeoutMs: number,
  killGraceMs: number,
  spawnImpl: SpawnEvidenceImpl = spawn,
): Promise<EvidenceDownloadResult> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("gh", args, {
      stdio: "inherit",
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "" },
    });
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, timedOut });
    });
  });
}

export async function downloadChildRunEvidence(
  childRunId: number,
  evidencePath: string,
  deps: {
    timeoutMs?: number;
    killGraceMs?: number;
    spawn?: SpawnEvidenceImpl;
  } = {},
): Promise<void> {
  const { repository } = tokenAndRepository();
  const timeoutMs = deps.timeoutMs ?? EVIDENCE_DOWNLOAD_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? EVIDENCE_DOWNLOAD_KILL_GRACE_MS;
  const runUrl = `https://github.com/${repository}/actions/runs/${childRunId}`;
  const result = await spawnEvidenceDownload(
    ["run", "download", String(childRunId), "--repo", repository, "--dir", evidencePath],
    timeoutMs,
    killGraceMs,
    deps.spawn,
  );
  if (result.timedOut) {
    throw new Error(
      `Evidence download timed out: artifact download for run ${childRunId} exceeded ${Math.round(timeoutMs / 60_000)} minutes. ${runUrl}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `Evidence download failed: artifact download for run ${childRunId} exited with status ${result.code}. ${runUrl}`,
    );
  }
}

async function dispatchSelectedPrGate(options: {
  repository: string;
  token: string;
  pull: PullRequest;
  baseSha: string;
  workflowSha: string;
  plan: RiskPlan;
  checkRunId: number;
  paths: ControllerPaths;
}): Promise<void> {
  const jobs = riskPlanRequiredJobIds(options.plan);
  const targets = riskPlanRequiredTargetIds(options.plan);
  const expectedShards = expectedSignalShards(jobs, E2E_WORKFLOW_PATH, targets);
  const correlationId = randomUUID();
  if (!CORRELATION_PATTERN.test(correlationId)) {
    throw new Error("generated correlation ID is invalid");
  }
  const dispatch = await dispatchPrGate({
    repository: options.repository,
    token: options.token,
    jobs,
    targets,
    prNumber: options.pull.number,
    commitSha: options.pull.head.sha,
    baseSha: options.baseSha,
    workflowSha: options.workflowSha,
    planHash: options.plan.planHash,
    correlationId,
  });
  const childRunId = dispatch.runId;
  try {
    appendOutput("run_id", String(childRunId));
    const state: PrGateState = {
      version: 3,
      commitSha: options.pull.head.sha,
      baseSha: options.baseSha,
      workflowSha: dispatch.workflowSha,
      planHash: options.plan.planHash,
      correlationId,
      prNumber: options.pull.number,
      expectedJobs: jobs,
      expectedTargets: targets,
      expectedShards,
    };
    const serializedState = `${JSON.stringify(state, null, 2)}\n`;
    writePrivateRegularFile(options.paths.statePath, serializedState);
    await updateRunningCheck(
      {
        repository: options.repository,
        checkRunId: options.checkRunId,
        prNumber: options.pull.number,
        headSha: options.pull.head.sha,
        baseSha: options.baseSha,
      },
      options.token,
      {
        childRunId,
        jobs,
        targets,
        planHash: options.plan.planHash,
      },
    );
    appendOutput("state_hash", sha256(serializedState));
    appendOutput("dispatched", "true");
    console.log(
      `Run dispatched: pr=${options.pull.number} run=${childRunId} plan=${options.plan.planHash} jobs=${jobs.join(",")} targets=${targets.join(",")} url=https://github.com/${options.repository}/actions/runs/${childRunId}`,
    );
  } catch (error) {
    try {
      await cancelChildRun(options.repository, options.token, childRunId);
    } catch (cancelError) {
      throw new DispatchedChildRunError(
        `${controllerErrorMessage(error)}; child cancellation failed: ${controllerErrorMessage(cancelError)}`,
        childRunId,
      );
    }
    throw new DispatchedChildRunError(
      `${controllerErrorMessage(error)}; child cancellation requested`,
      childRunId,
    );
  }
}

export async function startPrGate(
  command: Extract<ControllerCommand, { mode: "start" }>,
): Promise<void> {
  const { token, repository } = tokenAndRepository();
  if (!SHA_PATTERN.test(command.headSha)) throw new Error("PR head SHA is invalid");
  if (!SHA_PATTERN.test(command.workflowSha)) throw new Error("workflow SHA is invalid");
  if (!Number.isSafeInteger(command.gateRunId) || command.gateRunId < 1) {
    throw new Error("gate run ID is invalid");
  }
  assertRepository(command.headRepository, "PR head repository");
  assertBranch(command.headBranch);
  const ciIdentity = parseCiRunIdentity(command.ciDisplayTitle);
  if (
    ciIdentity.headSha !== command.headSha ||
    (command.prNumber !== undefined && command.prNumber !== ciIdentity.prNumber)
  ) {
    throw new Error("CI run identity does not match the triggering workflow run");
  }
  const existingChecks = await matchingPrGateChecks({
    repository,
    token,
    headSha: command.headSha,
    baseSha: ciIdentity.baseSha,
    prNumber: ciIdentity.prNumber,
  });
  if (existingChecks.length > 1) {
    throw new Error("Multiple PR gate checks already exist for this PR/base SHA pair");
  }
  const existingCheckRunId =
    existingChecks[0]?.status === "in_progress" ? existingChecks[0].id : undefined;
  if (existingCheckRunId) appendOutput("check_id", String(existingCheckRunId));
  let pull: PullRequest;
  try {
    pull = await requireLiveExactDiff({
      repository,
      token,
      prNumber: ciIdentity.prNumber,
      headSha: ciIdentity.headSha,
      baseSha: ciIdentity.baseSha,
    });
  } catch (error) {
    if (!(error instanceof ObsoleteExactDiffError)) throw error;
    if (existingCheckRunId) {
      await completeCheck({ repository, checkRunId: existingCheckRunId }, token, error.verdict);
    }
    appendOutput("dispatched", "false");
    appendOutput("finalized", "true");
    console.log(
      `Ignored obsolete CI event: pr=${ciIdentity.prNumber} head=${ciIdentity.headSha} base=${ciIdentity.baseSha} reason=${error.verdict.title}`,
    );
    return;
  }
  if (
    pull.head.repo?.full_name !== command.headRepository ||
    pull.head.ref !== command.headBranch
  ) {
    throw new Error("PR repository or branch does not match the triggering CI run");
  }
  assertCheckCanStart(existingChecks[0], command.ciConclusion);
  const checkRunId = await ensurePrGateCheck({
    repository,
    token,
    headSha: command.headSha,
    baseSha: ciIdentity.baseSha,
    prNumber: ciIdentity.prNumber,
    replaceRetryableCompleted: command.ciConclusion === "success",
  });
  if (checkRunId !== existingCheckRunId) appendOutput("check_id", String(checkRunId));
  await markCheckInProgress(
    {
      repository,
      checkRunId,
      prNumber: ciIdentity.prNumber,
      headSha: command.headSha,
      baseSha: ciIdentity.baseSha,
    },
    token,
    "Evaluating PR commit",
    "Validating the PR SHA and selecting deterministic E2E jobs and typed targets.",
  );

  let finalized = false;
  try {
    if (command.ciConclusion !== "success") {
      let jobs: WorkflowJob[] = [];
      let jobDetailsAvailable = true;
      let jobDetailsComplete: boolean;
      try {
        const details = await listNonPassingWorkflowJobs(
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
        prNumber: ciIdentity.prNumber,
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
          title: `PR #${ciIdentity.prNumber} CI did not pass`,
          summary: report.summary,
          retryableFailureReason: "prerequisite-ci",
        },
        report.ciRunUrl,
      );
      appendOutput("dispatched", "false");
      appendOutput("finalized", "true");
      finalized = true;
      console.log(report.errorMessage);
      return;
    }

    const changedFiles = await pullChangedFiles(repository, pull, token);
    const inventory = readFreeStandingJobsInventory();
    const allowedJobs = new Set(inventory.allowedJobs);
    const plan = validateRiskPlan(
      buildRiskPlan({
        headSha: command.headSha,
        changedFiles,
        focusedE2eJobs: focusedE2eJobsForChangedFiles(changedFiles, inventory),
      }),
      allowedJobs,
    );
    writePrivateRegularFile(command.planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const jobs = riskPlanRequiredJobIds(plan);
    const targets = riskPlanRequiredTargetIds(plan);
    const selections = riskPlanSelectionIds(plan);
    const selectionSummary = riskPlanSelectionSummary(plan);
    const currentPull = await resolvePullRequest({
      repository,
      token,
      headSha: command.headSha,
      headRepository: command.headRepository,
      headBranch: command.headBranch,
    });
    assertPullUnchanged(pull, currentPull);
    if (command.headRepository !== repository && selections.length > 0) {
      const gateRunUrl = `https://github.com/${repository}/actions/runs/${command.gateRunId}`;
      const gateRunLink = `[${WORKFLOW_NAME} run ${command.gateRunId}](${gateRunUrl})`;
      await completeCheck(
        { repository, checkRunId },
        token,
        {
          conclusion: "failure",
          title: "Maintainer approval required to skip credentialed E2E",
          summary: [
            `This fork PR diff (head ${command.headSha}, base ${ciIdentity.baseSha}) selected credential-bearing E2E checks (${selectionSummary}).`,
            "The selected jobs and targets were not run. No fork code received repository secrets.",
            `Open ${gateRunLink}, choose Review deployments, and approve the \`${PR_GATE_APPROVAL_ENVIRONMENT}\` environment to record this skip. If Review deployments is absent, the environment is unprotected or the run is no longer waiting; configure it, update the PR to create a new head, and trigger fresh PR CI. GitHub records the reviewer and optional comment. The manual \`approve-fork-e2e-skip\` workflow operation remains available as fallback.`,
          ].join("\n\n"),
        },
        gateRunUrl,
      );
      emitForkSkipOutputs("record-fork-e2e-skip", pull.number, command.headSha, ciIdentity.baseSha);
      appendOutput("dispatched", "false");
      appendOutput("finalized", "true");
      finalized = true;
      console.log(
        `Fork not dispatched: pr=${pull.number} sha=${command.headSha} plan=${plan.planHash} jobs=${jobs.join(",")} targets=${targets.join(",")}`,
      );
      return;
    }
    const controlPlaneFamily = plan.families.find((family) => family.id === "e2e-control-plane");
    if (controlPlaneFamily && requiresCredentialedE2eAuthorization(plan)) {
      const workflowUrl = `https://github.com/${repository}/actions/workflows/${PR_GATE_WORKFLOW_PATH}`;
      await markCheckInProgress(
        {
          repository,
          checkRunId,
          prNumber: ciIdentity.prNumber,
          headSha: command.headSha,
          baseSha: ciIdentity.baseSha,
        },
        token,
        CONTROL_PLANE_AUTHORIZATION_TITLE,
        [
          `This internal diff (PR SHA \`${command.headSha}\`, base SHA \`${ciIdentity.baseSha}\`) changes code that the selected credential-bearing E2E jobs or targets execute or trust (${selectionSummary}).`,
          "No selected E2E job or target ran and no repository secret was exposed.",
          `A repository maintainer or administrator must review PR SHA \`${command.headSha}\` against base SHA \`${ciIdentity.baseSha}\`. Then, they must open the [${WORKFLOW_NAME}](${workflowUrl}) workflow and run \`run-control-plane\` with the PR number, PR SHA, base SHA, and a review reason. That run dispatches the selected jobs and targets in one workflow run. This gate passes only if the evidence references both SHAs and verifies successfully.`,
          `Deterministic plan: \`${plan.planHash}\`.`,
        ].join("\n\n"),
      );
      appendOutput("dispatched", "false");
      appendOutput("finalized", "true");
      finalized = true;
      console.log(
        `Control-plane authorization required: pr=${pull.number} sha=${command.headSha} plan=${plan.planHash} jobs=${jobs.join(",")} targets=${targets.join(",")}`,
      );
      return;
    }
    if (selections.length === 0) {
      await completeCheck({ repository, checkRunId }, token, {
        conclusion: "success",
        title: "No E2E checks selected",
        summary: "No changed files matched an E2E risk rule.",
      });
      appendOutput("dispatched", "false");
      appendOutput("finalized", "true");
      finalized = true;
      console.log(`No run dispatched: pr=${pull.number} plan=${plan.planHash}`);
      return;
    }

    await dispatchSelectedPrGate({
      repository,
      token,
      pull,
      baseSha: ciIdentity.baseSha,
      workflowSha: command.workflowSha,
      plan,
      checkRunId,
      paths: command,
    });
  } catch (error) {
    if (!finalized) {
      const closed = await completeFailureAfterControllerError(
        { repository, checkRunId },
        token,
        "Run could not start",
        { error },
      );
      if (closed) appendOutput("finalized", "true");
    }
    throw error;
  }
}

export async function startControlPlanePrGate(command: ControlPlaneDispatchCommand): Promise<void> {
  const { token, repository } = tokenAndRepository();
  if (!SHA_PATTERN.test(command.headSha)) throw new Error("PR head SHA is invalid");
  if (!SHA_PATTERN.test(command.baseSha)) throw new Error("PR base SHA is invalid");
  if (!SHA_PATTERN.test(command.workflowSha)) throw new Error("workflow SHA is invalid");
  if (!MAINTAINER_PATTERN.test(command.maintainer)) throw new Error("maintainer login is invalid");
  if (!Number.isSafeInteger(command.gateRunId) || command.gateRunId < 1) {
    throw new Error("gate run ID is invalid");
  }
  if (command.workflowRunAttempt !== 1) {
    throw new Error("control-plane authorization must use the first workflow run attempt");
  }
  const reason = normalizedWaiverReason(command.reason);
  await requireMaintainerPermission(
    repository,
    token,
    command.maintainer,
    "Control-plane E2E authorization",
  );

  let checkRunId: number | undefined;
  try {
    const pull = await requireLiveExactDiff({
      repository,
      token,
      prNumber: command.prNumber,
      headSha: command.headSha,
      baseSha: command.baseSha,
    });
    if (pull.head.repo?.full_name !== repository) {
      throw new Error("control-plane E2E authorization requires an internal pull request");
    }
    const changedFiles = await pullChangedFiles(repository, pull, token);
    const inventory = readFreeStandingJobsInventory();
    const plan = validateRiskPlan(
      buildRiskPlan({
        headSha: command.headSha,
        changedFiles,
        focusedE2eJobs: focusedE2eJobsForChangedFiles(changedFiles, inventory),
      }),
      new Set(inventory.allowedJobs),
    );
    if (!requiresCredentialedE2eAuthorization(plan)) {
      throw new Error("pull request does not require credentialed E2E authorization");
    }
    const jobs = riskPlanRequiredJobIds(plan);
    const targets = riskPlanRequiredTargetIds(plan);
    if (jobs.length + targets.length === 0) {
      throw new Error("authorized control-plane plan selected no E2E jobs or targets");
    }
    writePrivateRegularFile(command.planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const currentPull = await requireLiveExactDiff({
      repository,
      token,
      prNumber: command.prNumber,
      headSha: command.headSha,
      baseSha: command.baseSha,
    });
    assertPullUnchanged(pull, currentPull);

    const matchingChecks = await matchingPrGateChecks({
      repository,
      token,
      headSha: command.headSha,
      baseSha: command.baseSha,
      prNumber: command.prNumber,
    });
    if (matchingChecks.length !== 1) {
      throw new Error(
        `Expected one PR gate check for the PR/base SHA pair; found ${matchingChecks.length}`,
      );
    }
    const check = matchingChecks[0]!;
    const pendingAuthorization = check.status === "in_progress" && check.conclusion === null;
    if (!pendingAuthorization || check.output?.title !== CONTROL_PLANE_AUTHORIZATION_TITLE) {
      throw new Error("PR gate must have the matching pending control-plane authorization state");
    }
    checkRunId = check.id;
    appendOutput("check_id", String(checkRunId));

    await compatibleMainWorkflowCommit(repository, token, command.workflowSha);
    const finalPull = await requireLiveExactDiff({
      repository,
      token,
      prNumber: command.prNumber,
      headSha: command.headSha,
      baseSha: command.baseSha,
    });
    assertPullUnchanged(pull, finalPull);
    await markCheckInProgress(
      {
        repository,
        checkRunId,
        prNumber: command.prNumber,
        headSha: command.headSha,
        baseSha: command.baseSha,
      },
      token,
      `E2E execution authorized by @${command.maintainer}`,
      `Running the exact reviewed head and base revision. Review reason: ${reason.replace(/`/gu, "'")}`,
    );
    await dispatchSelectedPrGate({
      repository,
      token,
      pull: finalPull,
      baseSha: command.baseSha,
      workflowSha: command.workflowSha,
      plan,
      checkRunId,
      paths: command,
    });
  } catch (error) {
    if (checkRunId) {
      if (error instanceof DispatchedChildRunError) {
        const closed = await completeFailureAfterControllerError(
          { repository, checkRunId },
          token,
          "Authorized E2E run requires reconciliation",
          {
            error,
            detailsUrl: `https://github.com/${repository}/actions/runs/${error.childRunId}`,
            recovery:
              "A credential-bearing child run was dispatched, so this authorization for the PR/base SHA pair cannot be retried. Inspect the linked run, then update the PR and run fresh CI before authorizing again.",
          },
        );
        if (closed) appendOutput("finalized", "true");
      } else {
        const reason = controllerErrorMessage(error).replace(/`/gu, "'");
        try {
          await markCheckInProgress(
            {
              repository,
              checkRunId,
              prNumber: command.prNumber,
              headSha: command.headSha,
              baseSha: command.baseSha,
            },
            token,
            CONTROL_PLANE_AUTHORIZATION_TITLE,
            [
              `The authorized E2E attempt did not produce an accepted result: \`${reason}\`.`,
              "Review the controller error and any linked child run. Then, launch a first-attempt `run-control-plane` workflow for the PR/base SHA pair.",
            ].join("\n\n"),
          );
          appendOutput("finalized", "true");
        } catch (restoreError) {
          console.error(
            `Failed to restore control-plane authorization after controller error: ${controllerErrorMessage(restoreError)}`,
          );
        }
      }
    }
    throw error;
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
  evidenceOutcome: EvidenceStepOutcome;
}): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const childRunUrl = `https://github.com/${repository}/actions/runs/${options.childRunId}`;
  const context = { repository, checkRunId: options.checkRunId };
  let finalized = false;
  let controllerFailureRetryReason: RetryableFailureReason | undefined;
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
    const matchingHistory = await matchingPrGateHistory({
      repository,
      token,
      headSha: state.commitSha,
      baseSha: state.baseSha,
      prNumber: state.prNumber,
    });
    if (matchingHistory.at(-1)?.id !== options.checkRunId) {
      throw new Error("controller state does not match the PR gate check");
    }
    const priorRunnerLossUrls = priorRunnerLossRunUrls(
      repository,
      matchingHistory,
      options.checkRunId,
    );
    const runnerLossAttempt = priorRunnerLossUrls.length + 1;
    const finalizeObsoleteExactDiff = async (): Promise<boolean> => {
      try {
        await requireLiveExactDiff({
          repository,
          token,
          prNumber: state.prNumber,
          headSha: state.commitSha,
          baseSha: state.baseSha,
        });
        return false;
      } catch (error) {
        if (!(error instanceof ObsoleteExactDiffError)) throw error;
        await completeCheck(context, token, error.verdict, childRunUrl);
        appendOutput("finalized", "true");
        finalized = true;
        console.log(
          `Run superseded: run=${options.childRunId} title=${error.verdict.title} url=${childRunUrl}`,
        );
        return true;
      }
    };
    if (await finalizeObsoleteExactDiff()) return;
    const expectedSignalCount = Object.values(state.expectedShards).reduce(
      (total, shards) => total + shards.length,
      0,
    );
    let verdict: PrGateVerdict;
    if (workflowConclusion === "success") {
      if (options.evidenceOutcome !== "success") {
        controllerFailureRetryReason = "evidence-download";
        const error = new Error(
          `Evidence download did not complete (outcome: ${options.evidenceOutcome}) after selected E2E run ${options.childRunId} succeeded. The controller could not verify its artifacts; inspect the Download evidence step and rerun the gate.`,
        );
        const closed = await completeFailureAfterControllerError(
          context,
          token,
          "Evidence could not be verified",
          {
            error,
            detailsUrl: childRunUrl,
            retryableFailureReason: controllerFailureRetryReason,
          },
        );
        if (closed) {
          appendOutput("finalized", "true");
          finalized = true;
        }
        throw error;
      }
      const signals = findSignalFiles(options.evidencePath, {
        ...EVIDENCE_LIMITS,
        maxSignalFiles: expectedSignalCount + 1,
      }).map((file) => validateSignal(readRegularJson(file), state));
      verdict = classifyPrGateEvidence({
        workflowConclusion,
        expectedJobs: state.expectedJobs,
        expectedTargets: state.expectedTargets,
        expectedShards: state.expectedShards,
        signals,
      });
      if (verdict.conclusion === "failure") {
        verdict = {
          ...verdict,
          summary: `[Selected E2E run ${options.childRunId}](${childRunUrl}) completed, but its evidence did not satisfy the gate.\n\n${verdict.summary}`,
        };
      }
    } else {
      let jobs: WorkflowJob[] = [];
      let jobDetailsAvailable = true;
      let jobDetailsComplete = false;
      try {
        const details = await listNonPassingWorkflowJobs(repository, token, options.childRunId);
        jobs = details.jobs;
        jobDetailsComplete = details.complete;
      } catch (error) {
        jobDetailsAvailable = false;
        console.warn(`Could not load E2E job details: ${controllerErrorMessage(error)}`);
      }
      verdict = e2eFailureReport({
        repository,
        runId: options.childRunId,
        workflowConclusion,
        jobs,
        jobDetailsAvailable,
        jobDetailsComplete,
        runnerLossAttempt,
        runnerLossEvidence: verifiedRunnerLossEvidence({
          workflowConclusion,
          jobs,
          jobDetailsAvailable,
          jobDetailsComplete,
        }),
      });
    }
    verdict = withRunnerLossLineage(verdict, priorRunnerLossUrls, childRunUrl);
    if (await finalizeObsoleteExactDiff()) return;
    await completeCheck(context, token, verdict, childRunUrl);
    appendOutput("finalized", "true");
    finalized = true;
    console.log(
      `Run completed: run=${options.childRunId} conclusion=${verdict.conclusion} title=${verdict.title} url=${childRunUrl}`,
    );
  } catch (error) {
    if (!finalized) {
      const closed = await completeFailureAfterControllerError(
        context,
        token,
        "Evidence could not be verified",
        {
          error,
          detailsUrl: childRunUrl,
          retryableFailureReason: controllerFailureRetryReason,
        },
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

function validateApprovalWorkflowRun(
  value: unknown,
  options: {
    repository: string;
    runId: number;
    runAttempt: number;
    workflowSha: string;
  },
): string {
  if (!isObjectRecord(value)) throw new Error("GitHub returned an invalid approval workflow run");
  const expectedUrl = `https://github.com/${options.repository}/actions/runs/${options.runId}`;
  const valid =
    value.id === options.runId &&
    value.name === WORKFLOW_NAME &&
    value.event === "workflow_run" &&
    value.path === PR_GATE_WORKFLOW_PATH &&
    value.head_branch === "main" &&
    value.head_sha === options.workflowSha &&
    value.status === "in_progress" &&
    value.conclusion === null &&
    options.runAttempt === 1 &&
    value.run_attempt === options.runAttempt &&
    value.html_url === expectedUrl;
  if (!valid) {
    throw new Error("approval workflow run does not match the trusted first-attempt gate run");
  }
  return expectedUrl;
}

function validateApprovalReview(value: unknown): { maintainer: string; comment: string | null } {
  if (!Array.isArray(value)) {
    throw new Error("GitHub returned malformed environment approval history");
  }
  if (value.length === 0) {
    throw new Error(
      `No required-reviewer approval was recorded for ${PR_GATE_APPROVAL_ENVIRONMENT}. If Review deployments was absent, the environment may be missing or unprotected, or the run may no longer be waiting; configure it, update the PR to create a new head, then trigger fresh PR CI, or use the manual approve-fork-e2e-skip fallback.`,
    );
  }
  if (value.length > MAX_APPROVAL_REVIEWS) {
    throw new Error(
      `GitHub returned more than ${MAX_APPROVAL_REVIEWS} environment approval reviews; refusing ambiguous approval history`,
    );
  }
  const reviews = value.map((candidate) => {
    if (
      !isObjectRecord(candidate) ||
      typeof candidate.state !== "string" ||
      (typeof candidate.comment !== "string" && candidate.comment !== null) ||
      !Array.isArray(candidate.environments) ||
      candidate.environments.length < 1 ||
      candidate.environments.length > MAX_APPROVAL_REVIEWS ||
      !candidate.environments.every(
        (environment) => isObjectRecord(environment) && typeof environment.name === "string",
      ) ||
      !isObjectRecord(candidate.user) ||
      typeof candidate.user.login !== "string" ||
      !MAINTAINER_PATTERN.test(candidate.user.login)
    ) {
      throw new Error("GitHub returned malformed environment approval history");
    }
    return {
      state: candidate.state,
      comment: candidate.comment,
      environments: candidate.environments as Array<{ name: string }>,
      maintainer: candidate.user.login,
    };
  });
  const matching = reviews.filter((review) =>
    review.environments.some((environment) => environment.name === PR_GATE_APPROVAL_ENVIRONMENT),
  );
  if (matching.length !== 1) {
    throw new Error("expected exactly one protected-environment approval review");
  }
  const review = matching[0]!;
  if (
    review.environments.length !== 1 ||
    review.environments[0]!.name !== PR_GATE_APPROVAL_ENVIRONMENT ||
    review.state !== "approved"
  ) {
    throw new Error("protected-environment review did not approve only the skip environment");
  }
  return { maintainer: review.maintainer, comment: review.comment };
}

function approvedWaiverReason(comment: string | null): string {
  const normalizedComment = (comment ?? "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  const baseReason = "Protected environment approval confirmed for this credentialed E2E skip.";
  const commentPrefix = " Reviewer comment: ";
  const maxCommentChars = MAX_WAIVER_REASON_CHARS - baseReason.length - commentPrefix.length;
  const boundedComment = normalizedComment.slice(0, maxCommentChars);
  const reason = boundedComment ? `${baseReason}${commentPrefix}${boundedComment}` : baseReason;
  return normalizedWaiverReason(reason);
}

async function requireMaintainerPermission(
  repository: string,
  token: string,
  maintainer: string,
  operation: string,
): Promise<void> {
  const permission = await githubApi<CollaboratorPermission>(
    `repos/${repository}/collaborators/${encodeURIComponent(maintainer)}/permission`,
    token,
    { userAgent: USER_AGENT },
  );
  if (
    !permission ||
    !["maintain", "admin"].includes(permission.role_name ?? "") ||
    permission.user?.login?.toLowerCase() !== maintainer.toLowerCase()
  ) {
    throw new Error(`${operation} requires a repository maintainer or administrator`);
  }
}

async function completeForkE2ESkip(command: ForkSkipCommand): Promise<void> {
  const { token, repository } = tokenAndRepository();
  if (!SHA_PATTERN.test(command.headSha)) throw new Error("PR head SHA is invalid");
  if (!SHA_PATTERN.test(command.baseSha)) throw new Error("PR base SHA is invalid");
  if (!SHA_PATTERN.test(command.workflowSha)) throw new Error("workflow SHA is invalid");
  if (!MAINTAINER_PATTERN.test(command.maintainer)) throw new Error("maintainer login is invalid");
  const reason = normalizedWaiverReason(command.reason);
  if (command.evidenceUrl && !EVIDENCE_URL_PATTERN.test(command.evidenceUrl)) {
    throw new Error("evidence URL must name an NVIDIA/NemoClaw Actions run");
  }

  await requireMaintainerPermission(
    repository,
    token,
    command.maintainer,
    "credentialed E2E skip approvals",
  );

  const pull = validatePullRequest(
    await githubApi<unknown>(`repos/${repository}/pulls/${command.prNumber}`, token, {
      userAgent: USER_AGENT,
    }),
  );
  if (
    pull.state !== "open" ||
    pull.base.repo.full_name !== repository ||
    !pull.head.repo ||
    pull.head.sha !== command.headSha ||
    pull.base.sha !== command.baseSha
  ) {
    throw new Error("pull request no longer matches the reviewed PR SHA and base SHA");
  }
  const isFork = pull.head.repo.full_name !== repository;
  if (!isFork) {
    throw new Error("credentialed E2E skips require a fork pull request");
  }

  const changedFiles = await pullChangedFiles(repository, pull, token);
  const inventory = readFreeStandingJobsInventory();
  const allowedJobs = new Set(inventory.allowedJobs);
  const plan = validateRiskPlan(
    buildRiskPlan({
      headSha: command.headSha,
      changedFiles,
      focusedE2eJobs: focusedE2eJobsForChangedFiles(changedFiles, inventory),
    }),
    allowedJobs,
  );
  const jobs = riskPlanRequiredJobIds(plan);
  const targets = riskPlanRequiredTargetIds(plan);
  if (jobs.length + targets.length === 0) {
    throw new Error("pull request does not require a credentialed E2E skip");
  }
  const currentPull = validatePullRequest(
    await githubApi<unknown>(`repos/${repository}/pulls/${command.prNumber}`, token, {
      userAgent: USER_AGENT,
    }),
  );
  assertPullUnchanged(pull, currentPull);

  const matchingChecks = await matchingPrGateChecks({
    repository,
    token,
    headSha: command.headSha,
    baseSha: command.baseSha,
    prNumber: command.prNumber,
  });
  if (matchingChecks.length !== 1) {
    throw new Error(
      `Expected one PR gate check for the PR/base SHA pair; found ${matchingChecks.length}`,
    );
  }
  const check = matchingChecks[0]!;
  if (
    check.status !== "completed" ||
    check.conclusion !== "failure" ||
    check.output?.title !== "Maintainer approval required to skip credentialed E2E"
  ) {
    throw new Error("PR gate must first complete with the matching skip-approval failure");
  }

  const safeReason = reason.replace(/`/gu, "'");
  const evidence = command.validatedApproval
    ? `Validated environment approval run for \`${command.validatedApproval.environment}\`: [${command.validatedApproval.runUrl}](${command.validatedApproval.runUrl}).`
    : command.evidenceUrl
      ? `Maintainer-supplied Actions reference (not validated by this controller): [${command.evidenceUrl}](${command.evidenceUrl}).`
      : "Approval source: manual fallback; no supporting Actions run was supplied.";
  const title = `Credentialed E2E skipped for fork PR — approved by @${command.maintainer}`;
  const approval = `Maintainer @${command.maintainer} approved skipping credentialed E2E for fork head \`${command.headSha}\` on base \`${command.baseSha}\`.`;
  const nonExecution = `Selected jobs and targets not run: ${riskPlanSelectionSummary(plan)}.`;
  await compatibleMainWorkflowCommit(repository, token, command.workflowSha);
  const finalPull = await requireLiveExactDiff({
    repository,
    token,
    prNumber: command.prNumber,
    headSha: command.headSha,
    baseSha: command.baseSha,
  });
  assertPullUnchanged(pull, finalPull);
  await completeCheck(
    { repository, checkRunId: check.id },
    token,
    {
      conclusion: "success",
      title,
      summary: [
        "**Outcome: APPROVED SKIP — credentialed E2E did not run.**",
        approval,
        nonExecution,
        `Reason: ${safeReason}`,
        evidence,
        `Deterministic plan: \`${plan.planHash}\`.`,
      ].join("\n\n"),
    },
    command.validatedApproval?.runUrl ??
      command.evidenceUrl ??
      `https://github.com/${repository}/pull/${pull.number}`,
  );
  console.log(
    `Credentialed E2E skip recorded: mode=${command.mode} pr=${pull.number} head=${command.headSha} base=${command.baseSha} maintainer=${command.maintainer} plan=${plan.planHash}`,
  );
}

export async function recordManualForkE2ESkip(
  command: Extract<ManualForkSkipCommand, { mode: "record-fork-e2e-skip" }>,
): Promise<void> {
  await completeForkE2ESkip(command);
}

export async function recordApprovedForkE2ESkip(command: ApprovedForkSkipCommand): Promise<void> {
  const { token, repository } = tokenAndRepository();
  if (!Number.isSafeInteger(command.prNumber) || command.prNumber < 1) {
    throw new Error("PR number is invalid");
  }
  if (!SHA_PATTERN.test(command.headSha)) throw new Error("PR head SHA is invalid");
  if (!SHA_PATTERN.test(command.baseSha)) throw new Error("PR base SHA is invalid");
  if (!SHA_PATTERN.test(command.workflowSha)) throw new Error("workflow SHA is invalid");
  if (!Number.isSafeInteger(command.approvalRunId) || command.approvalRunId < 1) {
    throw new Error("approval run ID is invalid");
  }
  if (command.approvalRunAttempt !== 1) {
    throw new Error("approval run attempt must be exactly 1");
  }

  const runUrl = validateApprovalWorkflowRun(
    await githubApi<unknown>(`repos/${repository}/actions/runs/${command.approvalRunId}`, token, {
      userAgent: USER_AGENT,
    }),
    {
      repository,
      runId: command.approvalRunId,
      runAttempt: command.approvalRunAttempt,
      workflowSha: command.workflowSha,
    },
  );
  const review = validateApprovalReview(
    await githubApi<unknown>(
      `repos/${repository}/actions/runs/${command.approvalRunId}/approvals`,
      token,
      { userAgent: USER_AGENT },
    ),
  );
  await completeForkE2ESkip({
    mode: "record-fork-e2e-skip",
    prNumber: command.prNumber,
    headSha: command.headSha,
    baseSha: command.baseSha,
    workflowSha: command.workflowSha,
    maintainer: review.maintainer,
    reason: approvedWaiverReason(review.comment),
    validatedApproval: {
      environment: PR_GATE_APPROVAL_ENVIRONMENT,
      runUrl,
    },
  });
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

function reportControllerError(error: unknown): void {
  const message = controllerErrorMessage(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    const escaped = message.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
    console.error(`::error title=Controller failed::${escaped}`);
  }
}

async function main(): Promise<void> {
  const command = parseControllerCommand(process.argv.slice(2));
  if (command.mode === "seed") {
    await seedPrGate(command.prNumber, command.headSha, command.baseSha);
    return;
  }
  if (command.mode === "start") {
    await startPrGate(command);
    return;
  }
  if (command.mode === "start-control-plane") {
    await startControlPlanePrGate(command);
    return;
  }
  if (command.mode === "finish") {
    await finishPrGate({
      statePath: command.statePath,
      stateHash: command.stateHash,
      evidencePath: command.evidencePath,
      checkRunId: command.checkRunId,
      childRunId: command.childRunId,
      evidenceOutcome: command.evidenceOutcome,
    });
    return;
  }
  if (command.mode === "abandon") {
    await abandonPrGate(command.checkRunId, command.childRunId);
    return;
  }
  if (command.mode === "wait") {
    await waitForChildRun(command.childRunId);
    return;
  }
  if (command.mode === "download") {
    await downloadChildRunEvidence(command.childRunId, command.evidencePath);
    return;
  }
  if (command.mode === "record-fork-e2e-skip") {
    await completeForkE2ESkip(command);
    return;
  }
  if (command.mode === "record-approved-fork-e2e-skip") {
    await recordApprovedForkE2ESkip(command);
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
