#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

export type RiskGateState = {
  version: 1;
  repository: string;
  commitSha: string;
  planHash: string;
  correlationId: string;
  expectedJobs: string[];
  expectedShards: Record<string, string[]>;
  requiresManualExpansion: boolean;
  checkRunId: number;
  childRunId: number;
  childRunUrl: string;
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

function readRegularJson(file: string, maxBytes = MAX_PLAN_BYTES): unknown {
  return JSON.parse(readPrivateRegularFile(file, { maxBytes })!);
}

export function validateRiskGateState(value: unknown, expectedRepository: string): RiskGateState {
  if (!isRecord(value) || value.version !== 1) throw new Error("invalid risk-gate state version");
  if (
    value.repository !== expectedRepository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expectedRepository)
  ) {
    throw new Error("risk-gate state repository does not match this workflow");
  }
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
  if (!Number.isSafeInteger(value.checkRunId) || Number(value.checkRunId) < 1) {
    throw new Error("risk-gate check id is invalid");
  }
  if (!Number.isSafeInteger(value.childRunId) || Number(value.childRunId) < 1) {
    throw new Error("risk-gate child run id is invalid");
  }
  const expectedUrl = `https://github.com/${expectedRepository}/actions/runs/${value.childRunId}`;
  if (value.childRunUrl !== expectedUrl) throw new Error("risk-gate child run URL is invalid");
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
      summary: `The correlated workflow concluded ${options.workflowConclusion}.`,
    };
  }
  if (options.workflowConclusion !== "success") {
    return {
      conclusion: "neutral",
      title: "Selected E2E workflow produced no complete signal",
      summary: `The correlated workflow concluded ${options.workflowConclusion ?? "without a conclusion"}.`,
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
      summary: `Multiple risk signals were uploaded for: ${[...duplicates].sort().join(", ")}.`,
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
      summary: `No trusted shard policy was found for: ${jobsWithoutShardPolicy.join(", ")}.`,
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
      summary: `No risk signal was uploaded for: ${missing.join(", ")}.`,
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
      summary: `Failed exact-SHA evidence was reported for: ${failed.join(", ")}.`,
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
      summary: `The following jobs did not produce an unskipped pass: ${partial.join(", ")}.`,
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
    summary: `${expectedEvidence.length} exact-SHA job shard(s) produced complete, unskipped evidence.`,
  };
}

function appendOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  if (!/^(?:check_id|dispatched|finalized|run_id)$/u.test(name)) {
    throw new Error("invalid controller output name");
  }
  if (!/^(?:true|false|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("invalid controller output value");
  }
  const descriptor = fs.openSync(
    output,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("GITHUB_OUTPUT must be a regular file");
    // GitHub supplies this output file; values are restricted above to fixed
    // booleans or positive decimal IDs before the descriptor write.
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
  state: Pick<RiskGateState, "repository" | "checkRunId">,
  token: string,
  verdict: RiskEvidenceVerdict,
  detailsUrl?: string,
): Promise<void> {
  await githubApi(`repos/${state.repository}/check-runs/${state.checkRunId}`, token, {
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
  state: Pick<RiskGateState, "repository" | "checkRunId">,
  token: string,
  title: string,
  detailsUrl?: string,
): Promise<boolean> {
  try {
    await completeCheck(
      state,
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

async function findCorrelatedRun(
  repository: string,
  token: string,
  correlationId: string,
  dispatchedAt: number,
): Promise<WorkflowRun> {
  const expectedTitle = `E2E risk ${correlationId}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const payload = await githubApi<{ workflow_runs: WorkflowRun[] }>(
      `repos/${repository}/actions/workflows/${E2E_WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=50`,
      token,
      { userAgent: "nemoclaw-e2e-risk-gate" },
    );
    const match = payload.workflow_runs.find(
      (run) =>
        run.display_title === expectedTitle &&
        run.name === "E2E" &&
        run.event === "workflow_dispatch" &&
        SHA_PATTERN.test(run.head_sha) &&
        Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        run.html_url === `https://github.com/${repository}/actions/runs/${run.id}` &&
        Date.parse(run.created_at) >= dispatchedAt - 5000,
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("timed out locating the correlated E2E workflow run");
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
    const dispatchedAt = Date.now();
    await githubApi(`repos/${repository}/actions/workflows/${E2E_WORKFLOW}/dispatches`, token, {
      method: "POST",
      body: {
        ref: "main",
        inputs: {
          jobs: plan.automaticJobs.join(","),
          checkout_sha: options.commitSha,
          risk_plan_hash: plan.planHash,
          risk_correlation: correlationId,
          risk_shadow: "true",
        },
      },
      userAgent: "nemoclaw-e2e-risk-gate",
    });
    const child = await findCorrelatedRun(repository, token, correlationId, dispatchedAt);
    const state: RiskGateState = {
      version: 1,
      repository,
      commitSha: options.commitSha,
      planHash: plan.planHash,
      correlationId,
      expectedJobs: plan.automaticJobs,
      expectedShards,
      requiresManualExpansion: plan.requiresManualExpansion,
      checkRunId,
      childRunId: child.id,
      childRunUrl: child.html_url,
    };
    writePrivateRegularFile(options.statePath, `${JSON.stringify(state, null, 2)}\n`);
    appendOutput("dispatched", "true");
    appendOutput("run_id", String(child.id));
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

async function finish(options: { statePath: string; evidencePath: string }): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const state = validateRiskGateState(readRegularJson(options.statePath), repository);
  if (!token) {
    throw new Error("valid gate state and GITHUB_TOKEN are required");
  }
  try {
    const child = await githubApi<WorkflowRun>(
      `repos/${state.repository}/actions/runs/${state.childRunId}`,
      token,
      { userAgent: "nemoclaw-e2e-risk-gate" },
    );
    if (
      child.id !== state.childRunId ||
      child.name !== "E2E" ||
      child.event !== "workflow_dispatch" ||
      !SHA_PATTERN.test(child.head_sha) ||
      child.html_url !== state.childRunUrl ||
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
    await completeCheck(state, token, verdict, state.childRunUrl);
  } catch (error) {
    await completeNeutralAfterControllerError(
      state,
      token,
      "Risk-selected E2E evidence could not be verified",
      state.childRunUrl,
    );
    throw error;
  }
}

async function abandon(checkId: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (
    !token ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^[1-9][0-9]*$/u.test(checkId)
  ) {
    throw new Error("GITHUB_TOKEN, a safe GITHUB_REPOSITORY, and numeric --check-id are required");
  }
  await completeCheck({ repository, checkRunId: Number(checkId) }, token, {
    conclusion: "neutral",
    title: "Risk-selected E2E controller stopped early",
    summary:
      "The shadow controller stopped before it could produce complete evidence. Inspect the controller workflow for details.",
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode;
  if (mode === "start") {
    await start({
      baseSha: args.base || "",
      commitSha: args.commit || "",
      planPath: args.plan || "/tmp/post-merge-risk-plan.json",
      statePath: args.state || "/tmp/e2e-risk-gate-state.json",
    });
    return;
  }
  if (mode === "finish") {
    await finish({
      statePath: args.state || "/tmp/e2e-risk-gate-state.json",
      evidencePath: args.evidence || "/tmp/e2e-risk-evidence",
    });
    return;
  }
  if (mode === "abandon") {
    await abandon(args["check-id"] || "");
    return;
  }
  throw new Error("--mode must be start, finish, or abandon");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
