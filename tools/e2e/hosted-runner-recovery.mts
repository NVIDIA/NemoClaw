#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import { type HostedRunnerLossPolicy, verifiedRunnerLossEvidence } from "./hosted-runner-loss.mts";
import {
  listNonPassingWorkflowJobs,
  workflowJobEvidenceFingerprint,
} from "./hosted-runner-loss-github.mts";
import { detectRunnerLoss } from "./runner-pressure-core.mts";

const TRUSTED_REPOSITORY = "NVIDIA/NemoClaw";
const USER_AGENT = "nemoclaw-hosted-runner-recovery";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const GITHUB_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const MAX_WORKFLOW_RUN_PAGES = 10;
const PLATFORM_INTERNAL_ERROR_POLICY: HostedRunnerLossPolicy = {
  githubInternalError: {
    approvedRunnerLabels: ["windows-latest", "macos-26"],
    approvedJobConclusions: ["cancelled"],
  },
};

const SOURCE_WORKFLOW = {
  workflowName: "CI / Platform Compatibility",
  path: ".github/workflows/platform-vitest-main.yaml",
  runName: "CI / Platform Compatibility",
  events: ["push"],
  policy: PLATFORM_INTERNAL_ERROR_POLICY,
  allowedRunnerLabels: ["ubuntu-latest", "windows-latest", "macos-26"],
} as const;

type SourceWorkflowRun = {
  id: number;
  runName: string;
  path: string;
  workflowId: number;
  createdAt: string;
  event: string;
  headBranch: string;
  headSha: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  displayTitle: string;
  htmlUrl: string;
  repository: string;
  headRepository: string;
};

type SourceWorkflow = {
  id: number;
  name: string;
  path: string;
  state: string;
};

type RecoverySnapshot = {
  fingerprint: string;
};

type WorkflowRunsPage = {
  totalCount: number;
  runs: SourceWorkflowRun[];
};

type LatestEligibleRunEvidence = {
  runs: SourceWorkflowRun[];
  totalCount: number;
};

export type HostedRunnerRecoveryResult =
  | { action: "ignored"; reason: string }
  | { action: "rerun-requested"; reason: string };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateSourceWorkflowRun(value: unknown): SourceWorkflowRun {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.workflow_id) ||
    (value.workflow_id as number) < 1 ||
    typeof value.created_at !== "string" ||
    !GITHUB_TIMESTAMP_PATTERN.test(value.created_at) ||
    typeof value.event !== "string" ||
    typeof value.head_branch !== "string" ||
    typeof value.head_sha !== "string" ||
    !SHA_PATTERN.test(value.head_sha) ||
    !Number.isSafeInteger(value.run_attempt) ||
    (value.run_attempt as number) < 1 ||
    typeof value.status !== "string" ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    typeof value.display_title !== "string" ||
    typeof value.html_url !== "string" ||
    !isObjectRecord(value.repository) ||
    typeof value.repository.full_name !== "string" ||
    !isObjectRecord(value.head_repository) ||
    typeof value.head_repository.full_name !== "string"
  ) {
    throw new Error("GitHub returned an invalid source workflow run");
  }
  return {
    id: value.id as number,
    runName: value.name,
    path: value.path,
    workflowId: value.workflow_id as number,
    createdAt: value.created_at,
    event: value.event,
    headBranch: value.head_branch,
    headSha: value.head_sha,
    runAttempt: value.run_attempt as number,
    status: value.status,
    conclusion: value.conclusion,
    displayTitle: value.display_title,
    htmlUrl: value.html_url,
    repository: value.repository.full_name,
    headRepository: value.head_repository.full_name,
  };
}

function validateSourceWorkflow(value: unknown): SourceWorkflow {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.state !== "string"
  ) {
    throw new Error("GitHub returned an invalid source workflow");
  }
  return {
    id: value.id as number,
    name: value.name,
    path: value.path,
    state: value.state,
  };
}

async function readSourceWorkflowRun(
  repository: string,
  token: string,
  sourceRunId: number,
): Promise<SourceWorkflowRun> {
  return validateSourceWorkflowRun(
    await githubApi<unknown>(`repos/${repository}/actions/runs/${sourceRunId}`, token, {
      userAgent: USER_AGENT,
    }),
  );
}

async function readSourceWorkflow(
  repository: string,
  token: string,
  workflowId: number,
): Promise<SourceWorkflow> {
  return validateSourceWorkflow(
    await githubApi<unknown>(`repos/${repository}/actions/workflows/${workflowId}`, token, {
      userAgent: USER_AGENT,
    }),
  );
}

function eligibleRunDefinition(
  source: SourceWorkflowRun,
  workflow: SourceWorkflow,
  repository: string,
): typeof SOURCE_WORKFLOW | null {
  const definition = SOURCE_WORKFLOW;
  const exactRunUrl = `https://github.com/${repository}/actions/runs/${source.id}`;
  if (
    definition.workflowName !== workflow.name ||
    definition.path !== workflow.path ||
    definition.path !== source.path ||
    definition.runName !== source.runName ||
    workflow.id !== source.workflowId ||
    workflow.state !== "active" ||
    source.repository !== repository ||
    source.headRepository !== repository ||
    source.headBranch !== "main" ||
    source.htmlUrl !== exactRunUrl ||
    !(definition.events as readonly string[]).includes(source.event)
  ) {
    return null;
  }
  return definition;
}

function eligibleSourceDefinition(
  source: SourceWorkflowRun,
  workflow: SourceWorkflow,
  repository: string,
  sourceRunId: number,
): typeof SOURCE_WORKFLOW | null {
  const definition = eligibleRunDefinition(source, workflow, repository);
  return definition &&
    source.id === sourceRunId &&
    source.runAttempt === 1 &&
    source.status === "completed" &&
    source.conclusion === "failure"
    ? definition
    : null;
}

function validateWorkflowRunsPage(value: unknown): WorkflowRunsPage {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.workflow_runs) ||
    value.workflow_runs.length > 100
  ) {
    throw new Error("GitHub returned an invalid workflow run listing");
  }
  return {
    totalCount: value.total_count as number,
    runs: value.workflow_runs.map(validateSourceWorkflowRun),
  };
}

function isStrictlyOlderRun(previous: SourceWorkflowRun, current: SourceWorkflowRun): boolean {
  return (
    current.createdAt < previous.createdAt ||
    (current.createdAt === previous.createdAt && current.id < previous.id)
  );
}

async function latestEligibleRunEvidence(options: {
  repository: string;
  token: string;
  source: SourceWorkflowRun;
  workflow: SourceWorkflow;
}): Promise<LatestEligibleRunEvidence | null> {
  const runs: SourceWorkflowRun[] = [];
  const runIds = new Set<number>();
  let totalCount: number | undefined;
  for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page += 1) {
    const response = validateWorkflowRunsPage(
      await githubApi<unknown>(
        `repos/${options.repository}/actions/workflows/${options.workflow.id}/runs?branch=main&per_page=100&page=${page}`,
        options.token,
        { userAgent: USER_AGENT },
      ),
    );
    totalCount ??= response.totalCount;
    if (response.totalCount !== totalCount || runs.length + response.runs.length > totalCount) {
      throw new Error("GitHub returned an unstable workflow run count");
    }
    for (const run of response.runs) {
      if (run.workflowId !== options.workflow.id) {
        throw new Error("workflow run listing crossed its authenticated workflow boundary");
      }
      if (runIds.has(run.id)) {
        throw new Error("GitHub returned duplicate workflow run IDs");
      }
      if (runs.length > 0 && !isStrictlyOlderRun(runs.at(-1)!, run)) {
        throw new Error("GitHub returned an ambiguously ordered workflow run listing");
      }
      runIds.add(run.id);
      runs.push(run);
    }

    const sourceIndex = runs.findIndex((run) => run.id === options.source.id);
    if (sourceIndex >= 0) {
      if (JSON.stringify(runs[sourceIndex]) !== JSON.stringify(options.source)) {
        throw new Error("source run did not match its workflow run listing");
      }
      if (response.runs.length < 100 && runs.length < totalCount) {
        throw new Error("workflow run listing was incomplete before its reported total");
      }
      const newerEligibleRun = runs
        .slice(0, sourceIndex)
        .find((run) => eligibleRunDefinition(run, options.workflow, options.repository) !== null);
      return newerEligibleRun ? null : { runs, totalCount };
    }
    if (runs.length === totalCount) {
      throw new Error("source run was not found in its workflow run listing");
    }
    if (response.runs.length < 100) {
      throw new Error("workflow run listing was incomplete before the source run");
    }
  }
  throw new Error("workflow run listing exceeded its page limit before the source run");
}

async function collectRecoverySnapshot(options: {
  repository: string;
  token: string;
  sourceRunId: number;
}): Promise<RecoverySnapshot | null> {
  const source = await readSourceWorkflowRun(
    options.repository,
    options.token,
    options.sourceRunId,
  );
  const workflow = await readSourceWorkflow(options.repository, options.token, source.workflowId);
  const definition = eligibleSourceDefinition(
    source,
    workflow,
    options.repository,
    options.sourceRunId,
  );
  if (!definition) return null;
  const latestRuns = await latestEligibleRunEvidence({
    repository: options.repository,
    token: options.token,
    source,
    workflow,
  });
  if (!latestRuns) return null;
  const jobDetails = await listNonPassingWorkflowJobs(
    options.repository,
    options.token,
    options.sourceRunId,
    1,
    {
      includeAnnotations: true,
      hostedRunnerLossPolicy: definition.policy,
    },
  );
  if (!jobDetails.complete || jobDetails.jobs.length === 0) return null;
  const exactAllowedLabels = jobDetails.jobs.every(
    (job) =>
      job.labels?.length === 1 &&
      (definition.allowedRunnerLabels as readonly string[]).includes(job.labels[0]!),
  );
  if (!exactAllowedLabels) return null;
  const evidence = verifiedRunnerLossEvidence({
    repository: options.repository,
    workflowSha: source.headSha,
    workflowConclusion: source.conclusion,
    jobs: jobDetails.jobs,
    jobDetailsAvailable: true,
    jobDetailsComplete: jobDetails.complete,
    policy: definition.policy,
  });
  if (
    !evidence ||
    !detectRunnerLoss(evidence) ||
    evidence.runnerLostMarkerCount !== jobDetails.jobs.length
  ) {
    return null;
  }
  const confirmedSource = await readSourceWorkflowRun(
    options.repository,
    options.token,
    options.sourceRunId,
  );
  const confirmedWorkflow = await readSourceWorkflow(
    options.repository,
    options.token,
    confirmedSource.workflowId,
  );
  const confirmedDefinition = eligibleSourceDefinition(
    confirmedSource,
    confirmedWorkflow,
    options.repository,
    options.sourceRunId,
  );
  if (!confirmedDefinition) {
    throw new Error("source workflow identity changed during runner-loss evidence collection");
  }
  const confirmedLatestRuns = await latestEligibleRunEvidence({
    repository: options.repository,
    token: options.token,
    source: confirmedSource,
    workflow: confirmedWorkflow,
  });
  if (
    !confirmedLatestRuns ||
    JSON.stringify(confirmedDefinition) !== JSON.stringify(definition) ||
    JSON.stringify(confirmedSource) !== JSON.stringify(source) ||
    JSON.stringify(confirmedWorkflow) !== JSON.stringify(workflow) ||
    JSON.stringify(confirmedLatestRuns) !== JSON.stringify(latestRuns)
  ) {
    throw new Error("source workflow evidence changed during runner-loss evidence collection");
  }
  return {
    fingerprint: sha256(
      JSON.stringify({
        jobs: workflowJobEvidenceFingerprint(jobDetails),
        latestRuns: confirmedLatestRuns,
        source: confirmedSource,
        workflow: confirmedWorkflow,
      }),
    ),
  };
}

export async function recoverHostedRunnerLoss(options: {
  repository: string;
  token: string;
  controllerRunAttempt: number;
  sourceRunId: number;
}): Promise<HostedRunnerRecoveryResult> {
  if (options.repository !== TRUSTED_REPOSITORY) {
    throw new Error(`hosted-runner recovery is restricted to ${TRUSTED_REPOSITORY}`);
  }
  if (!options.token) throw new Error("GitHub token is required");
  if (
    !Number.isSafeInteger(options.controllerRunAttempt) ||
    options.controllerRunAttempt < 1 ||
    !Number.isSafeInteger(options.sourceRunId) ||
    options.sourceRunId < 1
  ) {
    throw new Error("controller attempt and source run ID must be positive safe integers");
  }
  if (options.controllerRunAttempt !== 1) {
    return {
      action: "ignored",
      reason: "controller reruns cannot request source workflow reruns",
    };
  }

  const initial = await collectRecoverySnapshot(options);
  if (!initial) {
    return {
      action: "ignored",
      reason: "source run did not provide exact latest-eligible hosted-runner-loss evidence",
    };
  }
  const confirmed = await collectRecoverySnapshot(options);
  if (!confirmed || confirmed.fingerprint !== initial.fingerprint) {
    throw new Error("hosted-runner-loss evidence changed before rerun");
  }

  await githubApi<undefined>(
    `repos/${options.repository}/actions/runs/${options.sourceRunId}/rerun`,
    options.token,
    {
      method: "POST",
      userAgent: USER_AGENT,
    },
  );
  return {
    action: "rerun-requested",
    reason: "exact hosted-runner-loss evidence remained stable across both reads",
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} exceeds the safe integer range`);
  return parsed;
}

async function main(): Promise<void> {
  const result = await recoverHostedRunnerLoss({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    token: requiredEnvironment("GITHUB_TOKEN"),
    controllerRunAttempt: positiveIntegerEnvironment("GITHUB_RUN_ATTEMPT"),
    sourceRunId: positiveIntegerEnvironment("SOURCE_RUN_ID"),
  });
  console.log(
    result.action === "rerun-requested"
      ? "Requested one full hosted-runner recovery rerun."
      : "No hosted-runner recovery rerun was requested.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
