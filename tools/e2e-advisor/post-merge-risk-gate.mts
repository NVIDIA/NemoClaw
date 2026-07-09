#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

import { githubApi } from "../advisors/github.mts";
import { parseArgs } from "../advisors/io.mts";
import { buildRiskPlan, type RiskPlan } from "../advisors/risk-plan.mts";
import { readFreeStandingJobsInventory } from "../e2e/workflow-boundary.mts";
import { readPrivateRegularFile, writePrivateRegularFile } from "./private-file.ts";
import type { E2eRiskSignal } from "./risk-signal.ts";

const E2E_WORKFLOW = "e2e.yaml";
const CHECK_NAME = "E2E / Post-merge Risk Gate (shadow)";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SHARD_PATTERN = /^(?:default|[A-Za-z0-9][A-Za-z0-9_-]*)$/u;
const CORRELATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_PLAN_BYTES = 1024 * 1024;
const DEFAULT_EVIDENCE_LIMITS = {
  maxDepth: 8,
  maxEntries: 4096,
  maxSignalFiles: 12,
} as const;

type ControllerPaths = {
  planPath: string;
  statePath: string;
  evidencePath: string;
};

export type ControllerCommand =
  | ({ mode: "start"; baseSha: string; commitSha: string } & ControllerPaths)
  | ({
      mode: "finish";
      checkRunId: number;
      childRunId: number;
      stateHash: string;
    } & ControllerPaths)
  | { mode: "abandon"; checkRunId: number };

type CheckConclusion = "success" | "failure" | "neutral";

type WorkflowRun = {
  id: number;
  name: string;
  event: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  display_title: string;
  html_url: string;
};

type CheckRun = { id: number };

type WorkflowDispatchDetails = {
  workflow_run_id: number;
  run_url: string;
  html_url: string;
};

export type RiskGateState = {
  version: 1;
  commitSha: string;
  planHash: string;
  correlationId: string;
  expectedJobs: string[];
  expectedShards: Record<string, string[]>;
  requiresManualExpansion: boolean;
};

export type RiskEvidenceVerdict = {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
};

export function assertTrustedMainPush(options: {
  eventName: string | undefined;
  ref: string | undefined;
  sha: string | undefined;
  commitSha: string;
}): void {
  if (
    options.eventName !== "push" ||
    options.ref !== "refs/heads/main" ||
    options.sha !== options.commitSha
  ) {
    throw new Error("post-merge risk dispatch requires the exact trusted main push context");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
    planPath: path.join(resolved, "post-merge-risk-plan.json"),
    statePath: path.join(resolved, "e2e-risk-gate-state.json"),
    evidencePath: path.join(resolved, "evidence"),
  };
}

export function parseControllerCommand(argv: string[]): ControllerCommand {
  const args = parseArgs(argv);
  if (args.mode === "start") {
    return {
      mode: "start",
      baseSha: requiredArgument(args.base, "base"),
      commitSha: requiredArgument(args.commit, "commit"),
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
    };
  }
  throw new Error("--mode must be start, finish, or abandon");
}

function readRegularJson(file: string, maxBytes = MAX_PLAN_BYTES): unknown {
  return JSON.parse(readPrivateRegularFile(file, { maxBytes })!);
}

export function validateRiskGateState(value: unknown): RiskGateState {
  if (!isRecord(value) || value.version !== 1) throw new Error("invalid risk-gate state version");
  if (typeof value.commitSha !== "string" || !SHA_PATTERN.test(value.commitSha)) {
    throw new Error("risk-gate state commit SHA is invalid");
  }
  if (typeof value.planHash !== "string" || !HASH_PATTERN.test(value.planHash)) {
    throw new Error("risk-gate state plan hash is invalid");
  }
  if (typeof value.correlationId !== "string" || !CORRELATION_PATTERN.test(value.correlationId)) {
    throw new Error("risk-gate state correlation id is invalid");
  }
  if (
    !Array.isArray(value.expectedJobs) ||
    value.expectedJobs.length < 1 ||
    value.expectedJobs.length > 3 ||
    !value.expectedJobs.every((job) => typeof job === "string" && JOB_PATTERN.test(job)) ||
    new Set(value.expectedJobs).size !== value.expectedJobs.length
  ) {
    throw new Error("risk-gate state expected jobs are invalid");
  }
  if (!isRecord(value.expectedShards)) throw new Error("risk-gate state shards are invalid");
  const shardJobs = Object.keys(value.expectedShards).sort();
  if (JSON.stringify(shardJobs) !== JSON.stringify([...value.expectedJobs].sort())) {
    throw new Error("risk-gate state shard jobs do not match expected jobs");
  }
  for (const job of value.expectedJobs) {
    const shards = value.expectedShards[job];
    if (
      !Array.isArray(shards) ||
      shards.length < 1 ||
      new Set(shards).size !== shards.length ||
      !shards.every((shard) => typeof shard === "string" && SHARD_PATTERN.test(shard))
    ) {
      throw new Error(`risk-gate state shards are invalid for ${job}`);
    }
  }
  if (typeof value.requiresManualExpansion !== "boolean") {
    throw new Error("risk-gate manual-expansion state is invalid");
  }
  return value as RiskGateState;
}

export function validateRiskPlan(value: unknown, allowedJobs: ReadonlySet<string>): RiskPlan {
  if (!isRecord(value)) throw new Error("risk plan must be an object");
  if (value.version !== 1) throw new Error("unsupported risk-plan version");
  if (typeof value.headSha !== "string" || !SHA_PATTERN.test(value.headSha)) {
    throw new Error("risk plan headSha must be a lowercase 40-character SHA");
  }
  if (
    !Array.isArray(value.changedFiles) ||
    !value.changedFiles.every((file) => typeof file === "string")
  ) {
    throw new Error("risk plan changedFiles must be strings");
  }
  if (value.maxAutomaticJobs !== 3) throw new Error("risk plan automatic-job cap must be 3");
  const rebuilt = buildRiskPlan({
    headSha: value.headSha,
    changedFiles: value.changedFiles,
    maxAutomaticJobs: value.maxAutomaticJobs,
  });
  if (JSON.stringify(value) !== JSON.stringify(rebuilt)) {
    throw new Error("risk plan does not match its deterministic hash and inputs");
  }
  if (!HASH_PATTERN.test(rebuilt.planHash)) throw new Error("risk plan hash is invalid");
  const automatic = new Set(rebuilt.automaticJobs);
  if (automatic.size !== rebuilt.automaticJobs.length) {
    throw new Error("risk plan automatic jobs must be unique");
  }
  for (const job of rebuilt.requiredJobs) {
    if (!JOB_PATTERN.test(job.id) || !allowedJobs.has(job.id)) {
      throw new Error(`risk plan names unknown E2E job: ${job.id}`);
    }
  }
  return rebuilt;
}

export function validateSignal(
  value: unknown,
  state: Pick<
    RiskGateState,
    "commitSha" | "planHash" | "correlationId" | "expectedJobs" | "expectedShards"
  >,
): E2eRiskSignal {
  if (!isRecord(value) || value.version !== 1) throw new Error("invalid risk signal version");
  const signal = value as E2eRiskSignal;
  if (!state.expectedJobs.includes(signal.jobId)) throw new Error("risk signal job is unexpected");
  if (!state.expectedShards[signal.jobId]?.includes(signal.shardId)) {
    throw new Error("risk signal shard is unexpected");
  }
  if (signal.expectedSha !== state.commitSha) throw new Error("risk signal SHA mismatch");
  if (signal.testedSha !== state.commitSha) throw new Error("risk signal tested SHA mismatch");
  if (signal.planHash !== state.planHash) throw new Error("risk signal plan hash mismatch");
  if (signal.correlationId !== state.correlationId) {
    throw new Error("risk signal correlation mismatch");
  }
  for (const key of ["passed", "failed", "skipped", "pending", "unhandledErrors"] as const) {
    if (!Number.isSafeInteger(signal[key]) || signal[key] < 0) {
      throw new Error(`risk signal ${key} must be a non-negative integer`);
    }
  }
  if (!(["passed", "failed", "interrupted"] as const).includes(signal.runReason)) {
    throw new Error("risk signal runReason is invalid");
  }
  return signal;
}

export function classifyRiskEvidence(options: {
  workflowConclusion: string | null;
  expectedJobs: readonly string[];
  expectedShards: Readonly<Record<string, readonly string[]>>;
  signals: readonly E2eRiskSignal[];
  requiresManualExpansion: boolean;
}): RiskEvidenceVerdict {
  if (
    ["failure", "timed_out", "action_required", "startup_failure"].includes(
      options.workflowConclusion ?? "",
    )
  ) {
    return {
      conclusion: "failure",
      title: "Selected E2E workflow failed",
      summary: "The correlated workflow reported a failing terminal conclusion.",
    };
  }
  if (options.workflowConclusion !== "success") {
    return {
      conclusion: "neutral",
      title: "Selected E2E workflow produced no complete signal",
      summary: "The correlated workflow did not report a successful terminal conclusion.",
    };
  }
  const byJobShard = new Map<string, E2eRiskSignal>();
  const duplicates = new Set<string>();
  for (const signal of options.signals) {
    const key = `${signal.jobId}:${signal.shardId}`;
    if (byJobShard.has(key)) duplicates.add(key);
    byJobShard.set(key, signal);
  }
  if (duplicates.size > 0) {
    return {
      conclusion: "neutral",
      title: "Selected E2E jobs produced ambiguous evidence",
      summary: "More than one signal was uploaded for at least one expected job shard.",
    };
  }
  const expectedEvidence = options.expectedJobs.flatMap((job) =>
    (options.expectedShards[job] ?? []).map((shard) => `${job}:${shard}`),
  );
  const jobsWithoutShardPolicy = options.expectedJobs.filter(
    (job) => (options.expectedShards[job]?.length ?? 0) === 0,
  );
  if (jobsWithoutShardPolicy.length > 0) {
    return {
      conclusion: "neutral",
      title: "Selected E2E jobs lack an evidence policy",
      summary: "At least one selected job had no trusted shard policy.",
    };
  }
  const missing = expectedEvidence.filter((key) => !byJobShard.has(key));
  if (missing.length > 0) {
    // Missing bound evidence is unverifiable, not proof that product behavior
    // failed. Shadow checks become green only for complete evidence; neutral
    // keeps incomplete infrastructure evidence from masquerading as a pass.
    return {
      conclusion: "neutral",
      title: "Selected E2E jobs are missing test evidence",
      summary: "At least one expected job shard did not upload a bound risk signal.",
    };
  }
  const failed = expectedEvidence.filter((key) => {
    const signal = byJobShard.get(key)!;
    return signal.failed > 0 || signal.unhandledErrors > 0 || signal.runReason === "failed";
  });
  if (failed.length > 0) {
    return {
      conclusion: "failure",
      title: "Selected E2E jobs reported test failures",
      summary: "At least one selected job shard reported a test failure or unhandled error.",
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
      conclusion: "neutral",
      title: "Selected E2E jobs produced partial or skipped evidence",
      summary: "At least one expected job shard did not produce a complete, unskipped pass.",
    };
  }
  if (options.requiresManualExpansion) {
    return {
      conclusion: "neutral",
      title: "Automatic shadow subset passed; broader evidence is required",
      summary:
        "The risk plan exceeded the three-job automatic cap, so this passing subset is not complete merge evidence.",
    };
  }
  return {
    conclusion: "success",
    title: "All risk-selected E2E jobs passed",
    summary: "Every expected job shard produced complete, unskipped evidence.",
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
  if (!validValue) {
    throw new Error("invalid controller output value");
  }
  const descriptor = fs.openSync(
    output,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("GITHUB_OUTPUT must be a regular file");
    // GitHub supplies this output file; values are restricted above to fixed
    // booleans, positive decimal IDs, or a lowercase SHA-256 digest before the
    // descriptor write.
    // codeql[js/http-to-file-access]
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
    userAgent: "nemoclaw-e2e-risk-gate",
  });
  if (!Number.isSafeInteger(check.id) || check.id < 1)
    throw new Error("GitHub returned an invalid check id");
  return check.id;
}

async function completeCheck(
  context: { repository: string; checkRunId: number },
  token: string,
  verdict: RiskEvidenceVerdict,
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
    userAgent: "nemoclaw-e2e-risk-gate",
  });
}

async function completeNeutralAfterControllerError(
  context: { repository: string; checkRunId: number },
  token: string,
  title: string,
  detailsUrl?: string,
): Promise<boolean> {
  try {
    await completeCheck(
      context,
      token,
      {
        conclusion: "neutral",
        title,
        summary:
          "The shadow controller could not produce complete, trustworthy evidence. Inspect the controller workflow for details.",
      },
      detailsUrl,
    );
    return true;
  } catch (error) {
    console.error(
      `failed to close shadow check after controller error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function changedFilesBetween(
  baseSha: string,
  commitSha: string,
  workspace = process.cwd(),
): string[] {
  if (!SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(commitSha)) {
    throw new Error("base and tested commits must be lowercase 40-character SHAs");
  }
  const checkedOutSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (checkedOutSha !== commitSha) {
    throw new Error("trusted controller checkout does not match the tested commit");
  }
  const output = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", baseSha, commitSha],
    {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const files = output.split("\0").filter(Boolean);
  if (files.length > 5000) throw new Error("post-merge risk plan exceeds 5000 changed files");
  if (files.some((file) => file.startsWith("/") || file.split("/").includes(".."))) {
    throw new Error("post-merge diff contains an unsafe repository path");
  }
  return files;
}

export function expectedRiskSignalShards(
  jobIds: readonly string[],
  workflowPath = ".github/workflows/e2e.yaml",
): Record<string, string[]> {
  const workflow = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as unknown;
  const jobs = isRecord(workflow) && isRecord(workflow.jobs) ? workflow.jobs : {};
  return Object.fromEntries(
    jobIds.map((jobId) => {
      const job = isRecord(jobs[jobId]) ? jobs[jobId] : {};
      const strategy = isRecord(job.strategy) ? job.strategy : {};
      const matrix = isRecord(strategy.matrix) ? strategy.matrix : null;
      let shards = ["default"];
      if (matrix) {
        const keys = Object.keys(matrix);
        if (keys.length === 1 && Array.isArray(matrix.agent)) {
          shards = matrix.agent.filter((value): value is string => typeof value === "string");
          if (shards.length !== matrix.agent.length) {
            throw new Error(`${jobId} risk matrix agent values must be strings`);
          }
        } else if (keys.length === 1 && Array.isArray(matrix.include)) {
          shards = matrix.include.map((entry) => {
            if (!isRecord(entry) || typeof entry.agent !== "string") {
              throw new Error(`${jobId} risk matrix include entries must name an agent`);
            }
            return entry.agent;
          });
        } else {
          throw new Error(`${jobId} uses an unsupported risk-evidence matrix`);
        }
      }
      if (
        shards.length === 0 ||
        new Set(shards).size !== shards.length ||
        shards.some((shard) => !SHARD_PATTERN.test(shard))
      ) {
        throw new Error(`${jobId} risk evidence shards must be unique safe identifiers`);
      }
      return [jobId, shards];
    }),
  );
}

export function validateWorkflowDispatchDetails(
  value: unknown,
  repository: string,
): WorkflowDispatchDetails {
  if (!isRecord(value)) throw new Error("GitHub returned invalid workflow dispatch details");
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

export async function dispatchRiskWorkflow(options: {
  repository: string;
  token: string;
  jobs: readonly string[];
  commitSha: string;
  planHash: string;
  correlationId: string;
}): Promise<number> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository) ||
    !options.token ||
    options.jobs.length < 1 ||
    options.jobs.length > 3 ||
    new Set(options.jobs).size !== options.jobs.length ||
    options.jobs.some((job) => !JOB_PATTERN.test(job)) ||
    !SHA_PATTERN.test(options.commitSha) ||
    !HASH_PATTERN.test(options.planHash) ||
    !CORRELATION_PATTERN.test(options.correlationId)
  ) {
    throw new Error("risk workflow dispatch inputs are invalid");
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
          checkout_sha: options.commitSha,
          risk_plan_hash: options.planHash,
          risk_correlation: options.correlationId,
          risk_shadow: "true",
        },
        // GitHub REST 2022-11-28 otherwise returns no run identity.
        return_run_details: true,
      },
      userAgent: "nemoclaw-e2e-risk-gate",
    },
  );
  return validateWorkflowDispatchDetails(details, options.repository).workflow_run_id;
}

async function start(options: {
  baseSha: string;
  commitSha: string;
  planPath: string;
  statePath: string;
}): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_TOKEN and a safe GITHUB_REPOSITORY are required");
  }
  assertTrustedMainPush({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    commitSha: options.commitSha,
  });

  // The inventory and controller are both read from the exact trusted main
  // commit. A second copied allowlist would drift without adding a trust
  // boundary: compromising this inventory already means compromising main.
  const allowedJobs = new Set(readFreeStandingJobsInventory().allowedJobs);
  const plan = validateRiskPlan(
    buildRiskPlan({
      headSha: options.commitSha,
      changedFiles: changedFilesBetween(options.baseSha, options.commitSha),
    }),
    allowedJobs,
  );
  writePrivateRegularFile(options.planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const checkRunId = await createCheck(
    repository,
    token,
    options.commitSha,
    "Post-merge risk-selected E2E is being dispatched",
    `Plan ${plan.planHash.slice(0, 12)} selected ${plan.automaticJobs.length} automatic job(s).`,
  );
  appendOutput("check_id", String(checkRunId));
  try {
    const expectedShards = expectedRiskSignalShards(plan.automaticJobs);
    if (plan.requiredJobs.length === 0) {
      await completeCheck({ repository, checkRunId }, token, {
        conclusion: "success",
        title: "No post-merge runtime E2E required",
        summary: "The deterministic risk plan matched no runtime regression family.",
      });
      appendOutput("dispatched", "false");
      appendOutput("finalized", "true");
      return;
    }

    const correlationId = randomUUID();
    if (!CORRELATION_PATTERN.test(correlationId)) {
      throw new Error("generated correlation id is invalid");
    }
    const childRunId = await dispatchRiskWorkflow({
      repository,
      token,
      jobs: plan.automaticJobs,
      commitSha: options.commitSha,
      planHash: plan.planHash,
      correlationId,
    });
    const state: RiskGateState = {
      version: 1,
      commitSha: options.commitSha,
      planHash: plan.planHash,
      correlationId,
      expectedJobs: plan.automaticJobs,
      expectedShards,
      requiresManualExpansion: plan.requiresManualExpansion,
    };
    const serializedState = `${JSON.stringify(state, null, 2)}\n`;
    writePrivateRegularFile(options.statePath, serializedState);
    appendOutput("state_hash", sha256(serializedState));
    appendOutput("run_id", String(childRunId));
    appendOutput("dispatched", "true");
  } catch (error) {
    const finalized = await completeNeutralAfterControllerError(
      { repository, checkRunId },
      token,
      "Risk-selected E2E could not be dispatched",
    );
    if (finalized) appendOutput("finalized", "true");
    throw error;
  }
}

export function findSignalFiles(
  root: string,
  limits: {
    maxDepth: number;
    maxEntries: number;
    maxSignalFiles: number;
  } = DEFAULT_EVIDENCE_LIMITS,
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
    throw new Error("risk evidence traversal limits are invalid");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("risk evidence root must be a directory, not a symlink");
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
          throw new Error("risk evidence exceeds the entry limit");
        }
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("risk evidence must not contain symlinks");
        if (entry.isDirectory()) {
          if (depth >= limits.maxDepth) throw new Error("risk evidence exceeds the depth limit");
          visit(full, depth + 1);
        } else if (entry.isFile() && entry.name === "risk-signal.json") {
          files.push(full);
          if (files.length > limits.maxSignalFiles) {
            throw new Error("risk evidence exceeds the signal-file limit");
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

export async function finishRiskGate(options: {
  statePath: string;
  stateHash: string;
  evidencePath: string;
  checkRunId: number;
  childRunId: number;
}): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_TOKEN and a safe GITHUB_REPOSITORY are required");
  }
  const { checkRunId, childRunId } = options;
  const childRunUrl = `https://github.com/${repository}/actions/runs/${childRunId}`;
  const context = { repository, checkRunId };
  try {
    if (!HASH_PATTERN.test(options.stateHash)) throw new Error("controller state hash is invalid");
    const serializedState = readPrivateRegularFile(options.statePath, {
      maxBytes: MAX_PLAN_BYTES,
    })!;
    if (sha256(serializedState) !== options.stateHash) {
      throw new Error("controller state changed after E2E dispatch");
    }
    const state = validateRiskGateState(JSON.parse(serializedState));
    const child = await githubApi<WorkflowRun>(
      `repos/${repository}/actions/runs/${childRunId}`,
      token,
      { userAgent: "nemoclaw-e2e-risk-gate" },
    );
    if (
      child.id !== childRunId ||
      child.name !== "E2E" ||
      child.event !== "workflow_dispatch" ||
      !SHA_PATTERN.test(child.head_sha) ||
      child.html_url !== childRunUrl ||
      child.display_title !== `E2E risk ${state.correlationId}`
    ) {
      throw new Error("correlated E2E workflow identity changed");
    }
    const signals =
      child.conclusion === "success"
        ? findSignalFiles(options.evidencePath).map((file) =>
            validateSignal(readRegularJson(file), state),
          )
        : [];
    const verdict = classifyRiskEvidence({
      workflowConclusion: child.conclusion,
      expectedJobs: state.expectedJobs,
      expectedShards: state.expectedShards,
      signals,
      requiresManualExpansion: state.requiresManualExpansion,
    });
    await completeCheck(context, token, verdict, childRunUrl);
  } catch (error) {
    await completeNeutralAfterControllerError(
      context,
      token,
      "Risk-selected E2E evidence could not be verified",
      childRunUrl,
    );
    throw error;
  }
}

async function abandon(checkRunId: number): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_TOKEN and a safe GITHUB_REPOSITORY are required");
  }
  await completeCheck({ repository, checkRunId }, token, {
    conclusion: "neutral",
    title: "Risk-selected E2E controller stopped early",
    summary:
      "The shadow controller stopped before it could produce complete evidence. Inspect the controller workflow for details.",
  });
}

async function main(): Promise<void> {
  const command = parseControllerCommand(process.argv.slice(2));
  if (command.mode === "start") {
    await start({
      baseSha: command.baseSha,
      commitSha: command.commitSha,
      planPath: command.planPath,
      statePath: command.statePath,
    });
    return;
  }
  if (command.mode === "finish") {
    await finishRiskGate({
      statePath: command.statePath,
      stateHash: command.stateHash,
      evidencePath: command.evidencePath,
      checkRunId: command.checkRunId,
      childRunId: command.childRunId,
    });
    return;
  }
  if (command.mode === "abandon") {
    await abandon(command.checkRunId);
    return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
