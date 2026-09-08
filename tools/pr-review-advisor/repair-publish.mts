#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createVerifiedCommit,
  type GitHubRequest,
  type GraphqlRequest,
  githubClient,
  updateVerifiedRef,
} from "../pull-requests/publication.mts";
export type { GitHubRequest, GraphqlRequest } from "../pull-requests/publication.mts";

import { githubApiWithResponse } from "../advisors/github.mts";
import { buildRiskPlan, riskPlanRequiredJobIds, type RiskPlan } from "../advisors/risk-plan.mts";
import { dispatchWorkflowWithReconciliation } from "../e2e/pr-e2e-dispatch-reconciliation.mts";

import {
  assertLiveRepairState,
  assertValidatedRepair,
  fullSha,
  parseSelection,
  parseValidationReceipt,
  readJson,
  REPAIR_REPOSITORY,
  RepairError,
  sanitizeDiagnostic,
  validateRepairPatch,
} from "./repair-contract.mts";

type LivePullRequest = {
  number?: number;
  base: {
    ref: string;
    sha?: string;
    repo: { full_name: string; node_id?: string };
  };
  head: {
    ref: string;
    sha?: string;
    repo: { full_name: string } | null;
  };
  draft: boolean;
  state: string;
};

export const ADVISOR_REPAIR_HEAD_WORKFLOWS = [
  { workflow: "pr.yaml", checks: ["changes", "checks"] },
  { workflow: "commit-lint.yaml", checks: ["commit-lint"] },
  { workflow: "dco-check.yaml", checks: ["dco-check"] },
  { workflow: "installer-hash-check.yaml", checks: ["check-hash"] },
  { workflow: "code-scanning.yaml", checks: [] },
  { workflow: "pr-review-advisor.yaml", checks: [] },
] as const;

export const ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS = ["openshell-sdk-package-pr.yaml"] as const;

const ADVISOR_REPAIR_E2E_WORKFLOW = "e2e.yaml";
const ADVISOR_REPAIR_E2E_CHECK = "advisor-repair-risk-plan-e2e";

// GitHub exposes resolved job display names, not workflow job IDs. Keep the
// Phase 1 repair allowlist bound to the exact trusted E2E executions that each
// current risk-plan ID selects. An unknown future ID fails closed until this
// evidence map and its regression coverage are deliberately extended.
export const ADVISOR_REPAIR_E2E_JOB_NAMES = {
  "channels-add-remove": [
    "Messaging: adds and removes Telegram configuration (docker) / no provider credential",
  ],
  "channels-stop-start": [
    "Messaging: OpenClaw preserves channels across stop and start (docker) / NVIDIA inference API key",
    "Messaging: Hermes preserves channels across stop and start (docker) / NVIDIA inference API key",
  ],
  "cloud-inference": [
    "Inference: OpenClaw uses hosted inference (docker) / NVIDIA inference API key",
  ],
  "cloud-onboard": ["Cloud onboard (docker)"],
  "full-e2e": [
    "OpenClaw: installs, onboards, and completes an agent turn (docker) / NVIDIA inference API key",
  ],
  "hermes-e2e": ["Hermes E2E (docker)"],
  "hermes-inference-switch": [
    "Inference: Hermes switches to an Anthropic-compatible endpoint (docker) / no provider credential",
  ],
  "inference-routing": [
    "Inference: rejects unsafe routes and proves runtime identities (docker) / no provider credential",
  ],
  "llama-cpp-dgx-spark-qualification": ["Protected llama.cpp on NVIDIA DGX Spark"],
  "managed-image-multiarch-startup": [
    "Protected managed-image startup (linux/amd64)",
    "Protected managed-image startup (linux/arm64)",
  ],
  "managed-image-protected-runtime": ["Protected managed-image GPU and local inference"],
  "network-policy": [
    "Network policy: enforces restricted allow and deny rules (docker) / NVIDIA inference API key",
  ],
  "onboard-repair": [
    "Onboarding: repairs a missing sandbox and rejects conflicting resume input (docker) / no provider credential",
  ],
  "onboard-resume": [
    "Onboarding: resumes interrupted setup from recorded progress (docker) / no provider credential",
  ],
  "rebuild-openclaw": [
    "Rebuild: preserves OpenClaw state and rotates the gateway token (docker) / NVIDIA inference API key",
  ],
  "security-posture": [
    "Security: OpenClaw retains the required sandbox posture (docker) / NVIDIA inference API key",
    "Security: Hermes retains the required sandbox posture (docker) / NVIDIA inference API key",
  ],
  "state-backup-restore": [
    "Backup: restores workspace files and memory (docker) / NVIDIA inference API key",
  ],
} as const satisfies Record<string, readonly string[]>;

type WorkflowRun = {
  id?: unknown;
  event?: unknown;
  path?: unknown;
  status?: unknown;
  conclusion?: unknown;
  display_title?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
  html_url?: unknown;
  run_attempt?: unknown;
};

type WorkflowJob = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  run_attempt?: unknown;
};

type PublishedCheck = {
  id: number;
  name: string;
  url: string;
};

type AdvisorRepairE2eDispatch = {
  correlationId: string;
  runId: number;
  source: "dispatch-response" | "workflow-run-inventory";
};

type AdvisorRepairE2eEvidence = AdvisorRepairE2eDispatch & {
  runAttempt: number;
  url: string;
  receipt: { name: string; url: string };
  generateMatrix: { name: "generate-matrix"; url: string };
  requiredJobs: string[];
  jobs: Array<{ name: string; url: string }>;
};

type AdvisorRepairRiskPlan = {
  version: RiskPlan["version"];
  planHash: string;
  changedPaths: string[];
  requiredJobs: string[];
};

export type AdvisorRepairHeadReceipt = {
  version: 2;
  attemptKey: string;
  sourceHeadSha: string;
  baseSha: string;
  generatedHeadSha: string;
  prNumber: number;
  outcome: "success" | "manual-remediation-required";
  workflows: Array<{
    workflow: string;
    runId: number;
    runAttempt: number;
    url: string;
    receipt: { name: string; url: string };
    jobs: Array<{ name: string; url: string }>;
  }>;
  riskPlan: AdvisorRepairRiskPlan;
  e2e: AdvisorRepairE2eEvidence | null;
  checks: PublishedCheck[];
  failure: string | null;
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new RepairError(`${name} is required`);
  return value;
}

export async function prepareAdvisorRepair(input: {
  request: GitHubRequest;
  sourceRepository: string;
  selectionPath: string;
  patchPath: string;
  receiptPath: string;
  workDirectory: string;
}): Promise<string> {
  const selection = parseSelection(readJson(input.selectionPath));
  if (selection.repository !== REPAIR_REPOSITORY)
    throw new RepairError("Advisor repair target is not NVIDIA/NemoClaw");
  const receipt = parseValidationReceipt(readJson(input.receiptPath));
  const candidate = validateRepairPatch({
    sourceCheckout: input.sourceRepository,
    destination: input.workDirectory,
    selection,
    patchFile: input.patchPath,
    expectedChangedPaths: receipt.changedPaths.map(({ path: file }) => file),
  });
  assertValidatedRepair(selection, receipt, candidate);
  return createVerifiedCommit({
    finalTree: candidate.candidateTreeSha,
    headSha: selection.sourceHeadSha,
    message: `fix: address PR Review Advisor findings\n\n${selection.findingIds.join("\n")}\n\nAdvisor-Repair-Attempt: ${selection.attemptKey}`,
    repository: candidate.repository,
    repositoryName: REPAIR_REPOSITORY,
    request: input.request,
  });
}

export async function publishPreparedAdvisorRepair(input: {
  commitSha: string;
  graphql: GraphqlRequest;
  request: GitHubRequest;
  selectionPath: string;
  state: unknown;
  reviews: unknown;
}): Promise<void> {
  const selection = parseSelection(readJson(input.selectionPath));
  assertLiveRepairState(selection, input.state, input.reviews);
  const commit = (await input.request(
    "GET",
    `/repos/${REPAIR_REPOSITORY}/git/commits/${input.commitSha}`,
  )) as {
    sha?: unknown;
    parents?: Array<{ sha?: unknown }>;
    verification?: { verified?: unknown };
  };
  if (
    commit.sha !== input.commitSha ||
    commit.parents?.length !== 1 ||
    commit.parents[0]?.sha !== selection.sourceHeadSha ||
    commit.verification?.verified !== true
  )
    throw new RepairError("prepared Advisor repair commit is invalid");
  await updateVerifiedRef({
    commitSha: input.commitSha,
    graphql: input.graphql,
    headRef: selection.headRef,
    headSha: selection.sourceHeadSha,
    repositoryId: selection.repositoryId,
  });
}

function repairValidationRunName(attemptKey: string, generatedHeadSha: string): string {
  return `Repair validation ${attemptKey} head ${generatedHeadSha}`;
}

function repairValidationReceiptName(input: {
  attemptKey: string;
  prNumber: number;
  generatedHeadSha: string;
  baseSha: string;
}): string {
  return `Repair receipt ${input.attemptKey} PR ${input.prNumber} head ${input.generatedHeadSha} base ${input.baseSha}`;
}

function repairValidationInputs(
  workflow: string,
  input: {
    prNumber: number;
    sourceHeadSha: string;
    generatedHeadSha: string;
    baseSha: string;
    attemptKey: string;
  },
): Record<string, string> {
  if (workflow === "pr-review-advisor.yaml")
    return {
      target_repo: REPAIR_REPOSITORY,
      target_pr: String(input.prNumber),
      target_base: "main",
      repair_head_sha: input.generatedHeadSha,
      repair_base_sha: input.baseSha,
      repair_finding_ids_json: "[]",
      repair_egress_authorized: "false",
      repair_publish: "false",
      repair_attempt_key: input.attemptKey,
    };
  return {
    repair_pr_number: String(input.prNumber),
    ...(["pr.yaml", "openshell-sdk-package-pr.yaml"].includes(workflow)
      ? { repair_source_head_sha: input.sourceHeadSha }
      : {}),
    repair_head_sha: input.generatedHeadSha,
    repair_base_sha: input.baseSha,
    repair_attempt_key: input.attemptKey,
  };
}

export function advisorRepairRiskPlan(
  generatedHeadSha: string,
  changedPaths: readonly string[],
): AdvisorRepairRiskPlan {
  const plan = buildRiskPlan({ headSha: generatedHeadSha, changedFiles: changedPaths });
  return {
    version: plan.version,
    planHash: plan.planHash,
    changedPaths: [...plan.changedFiles],
    requiredJobs: riskPlanRequiredJobIds(plan),
  };
}

type DispatchAdvisorRepairE2e = (input: {
  prNumber: number;
  generatedHeadSha: string;
  baseSha: string;
  workflowSha: string;
  correlationId: string;
  requiredJobs: readonly string[];
  token: string;
}) => Promise<{ runId: number; source: AdvisorRepairE2eDispatch["source"] }>;

export function advisorRepairE2eDispatchRequest(input: {
  prNumber: number;
  generatedHeadSha: string;
  baseSha: string;
  workflowSha: string;
  correlationId: string;
  requiredJobs: readonly string[];
}): { ref: "main"; inputs: Record<string, string | boolean> } {
  return {
    ref: "main",
    inputs: {
      targets: "",
      jobs: input.requiredJobs.join(","),
      include_staging_brev_launchable: false,
      inference_mode: "mock",
      gateway_runtime: "docker",
      gateway_runtimes: "",
      allow_jetson_dispatch: false,
      allow_dgx_spark_runner_queue: false,
      pr_number: String(input.prNumber),
      post_to_slack: false,
      checkout_sha: input.generatedHeadSha,
      checkout_repository: REPAIR_REPOSITORY,
      base_sha: input.baseSha,
      workflow_sha: input.workflowSha,
      managed_image_revision: "",
      correlation_id: input.correlationId,
    },
  };
}

const defaultDispatchAdvisorRepairE2e: DispatchAdvisorRepairE2e = async (input) =>
  dispatchWorkflowWithReconciliation({
    repository: REPAIR_REPOSITORY,
    token: input.token,
    workflowSha: input.workflowSha,
    correlationId: input.correlationId,
    prNumber: input.prNumber,
    dispatch: (signal) =>
      githubApiWithResponse(
        `repos/${REPAIR_REPOSITORY}/actions/workflows/${ADVISOR_REPAIR_E2E_WORKFLOW}/dispatches`,
        input.token,
        {
          method: "POST",
          signal,
          body: advisorRepairE2eDispatchRequest(input),
        },
      ),
  });

async function dispatchAdvisorRepairE2e(input: {
  prNumber: number;
  generatedHeadSha: string;
  baseSha: string;
  workflowSha: string;
  requiredJobs: readonly string[];
  token: string;
  correlationId?: () => string;
  dispatch?: DispatchAdvisorRepairE2e;
}): Promise<AdvisorRepairE2eDispatch> {
  const correlationId = (input.correlationId ?? randomUUID)();
  const result = await (input.dispatch ?? defaultDispatchAdvisorRepairE2e)({
    ...input,
    correlationId,
  });
  return { correlationId, ...result };
}

async function dispatchRepairValidation(
  workflow: string,
  input: Parameters<typeof repairValidationInputs>[1],
  runName: string,
  request: GitHubRequest,
): Promise<{ workflow: string; priorRunIds: Set<number>; runName: string }> {
  const prior = await listRepairValidationRuns(workflow, request);
  await request("POST", `/repos/${REPAIR_REPOSITORY}/actions/workflows/${workflow}/dispatches`, {
    ref: "main",
    inputs: repairValidationInputs(workflow, input),
  });
  return { workflow, priorRunIds: new Set(prior.map(({ id }) => Number(id))), runName };
}

async function listRepairValidationRuns(
  workflow: string,
  request: GitHubRequest,
): Promise<WorkflowRun[]> {
  const response = (await request(
    "GET",
    `/repos/${REPAIR_REPOSITORY}/actions/workflows/${workflow}/runs?branch=main&event=workflow_dispatch&per_page=100`,
  )) as { workflow_runs?: unknown };
  if (
    !Array.isArray(response.workflow_runs) ||
    response.workflow_runs.length > 100 ||
    response.workflow_runs.some(
      (run: WorkflowRun) => !Number.isSafeInteger(run.id) || Number(run.id) < 1,
    )
  )
    throw new RepairError(`generated-head ${workflow} run listing is invalid`);
  return response.workflow_runs as WorkflowRun[];
}

async function discoverRepairValidationRun(
  pending: Awaited<ReturnType<typeof dispatchRepairValidation>>,
  request: GitHubRequest,
): Promise<{ workflow: string; runId: number; url: string } | null> {
  const matches = (await listRepairValidationRuns(pending.workflow, request)).filter(
    (run) =>
      !pending.priorRunIds.has(Number(run.id)) &&
      run.path === `.github/workflows/${pending.workflow}` &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      run.display_title === pending.runName &&
      run.html_url === `https://github.com/${REPAIR_REPOSITORY}/actions/runs/${run.id}`,
  );
  if (matches.length > 1)
    throw new RepairError(`generated-head ${pending.workflow} run identity is ambiguous`);
  const [match] = matches;
  return match
    ? { workflow: pending.workflow, runId: Number(match.id), url: String(match.html_url) }
    : null;
}

async function completedWorkflowEvidence(
  dispatch: { workflow: string; runId: number; url: string },
  requiredJobs: readonly string[],
  runName: string,
  receiptName: string,
  request: GitHubRequest,
): Promise<AdvisorRepairHeadReceipt["workflows"][number] | null> {
  const run = (await request(
    "GET",
    `/repos/${REPAIR_REPOSITORY}/actions/runs/${dispatch.runId}`,
  )) as WorkflowRun;
  if (
    run.id !== dispatch.runId ||
    run.path !== `.github/workflows/${dispatch.workflow}` ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.display_title !== runName ||
    run.html_url !== dispatch.url ||
    typeof run.head_sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(run.head_sha) ||
    !Number.isSafeInteger(run.run_attempt) ||
    Number(run.run_attempt) < 1
  )
    throw new RepairError(`generated-head ${dispatch.workflow} run evidence is invalid`);
  if (run.status !== "completed") return null;
  if (run.conclusion !== "success")
    throw new RepairError(`generated-head ${dispatch.workflow} run failed`);
  const response = (await request(
    "GET",
    `/repos/${REPAIR_REPOSITORY}/actions/runs/${dispatch.runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
  )) as { jobs?: unknown };
  if (!Array.isArray(response.jobs) || response.jobs.length > 100)
    throw new RepairError(`generated-head ${dispatch.workflow} job listing is invalid`);
  const requireSuccessfulJob = (name: string): { name: string; url: string } => {
    const matches = (response.jobs as WorkflowJob[]).filter((job) => job.name === name);
    if (matches.length !== 1)
      throw new RepairError(`generated-head ${dispatch.workflow} job ${name} is ambiguous`);
    const [job] = matches;
    if (
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      job.run_attempt !== run.run_attempt ||
      !Number.isSafeInteger(job.id) ||
      Number(job.id) < 1 ||
      typeof job.html_url !== "string" ||
      !job.html_url.startsWith(`${dispatch.url}/job/`)
    )
      throw new RepairError(`generated-head ${dispatch.workflow} job ${name} did not succeed`);
    return { name, url: job.html_url };
  };
  const receipt = requireSuccessfulJob(receiptName);
  const jobs = requiredJobs.map(requireSuccessfulJob);
  return { ...dispatch, runAttempt: Number(run.run_attempt), receipt, jobs };
}

async function listE2eJobs(runId: number, request: GitHubRequest): Promise<WorkflowJob[]> {
  const jobs: WorkflowJob[] = [];
  const ids = new Set<number>();
  let totalCount: number | undefined;
  for (let page = 1; page <= 10; page += 1) {
    const response = (await request(
      "GET",
      `/repos/${REPAIR_REPOSITORY}/actions/runs/${runId}/attempts/1/jobs?per_page=100&page=${page}`,
    )) as { total_count?: unknown; jobs?: unknown };
    if (
      !Number.isSafeInteger(response.total_count) ||
      Number(response.total_count) < 1 ||
      Number(response.total_count) > 1_000 ||
      !Array.isArray(response.jobs) ||
      response.jobs.length > 100 ||
      (totalCount !== undefined && response.total_count !== totalCount)
    )
      throw new RepairError("generated-head E2E job listing is invalid");
    totalCount ??= Number(response.total_count);
    for (const job of response.jobs as WorkflowJob[]) {
      if (!Number.isSafeInteger(job.id) || Number(job.id) < 1 || ids.has(Number(job.id)))
        throw new RepairError("generated-head E2E job listing is invalid");
      ids.add(Number(job.id));
      jobs.push(job);
    }
    if (jobs.length === totalCount) return jobs;
    if (jobs.length > totalCount || response.jobs.length < 100)
      throw new RepairError("generated-head E2E job listing is incomplete");
  }
  throw new RepairError("generated-head E2E job listing exceeds one thousand jobs");
}

function requiredE2eJobEvidence(
  jobs: readonly WorkflowJob[],
  requiredJobs: readonly string[],
  runUrl: string,
): Array<{ name: string; url: string }> {
  if (new Set(requiredJobs).size !== requiredJobs.length)
    throw new RepairError("generated-head E2E required job list is invalid");
  const expectedNames = requiredJobs.flatMap((requiredJob) => {
    const names =
      ADVISOR_REPAIR_E2E_JOB_NAMES[requiredJob as keyof typeof ADVISOR_REPAIR_E2E_JOB_NAMES];
    if (!names)
      throw new RepairError(
        `generated-head E2E job ${requiredJob} has no trusted evidence mapping`,
      );
    return [...names];
  });
  if (new Set(expectedNames).size !== expectedNames.length)
    throw new RepairError("generated-head E2E evidence mapping is ambiguous");
  return expectedNames.map((name) => {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1) throw new RepairError(`generated-head E2E job ${name} is ambiguous`);
    const [job] = matches;
    if (
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      job.run_attempt !== 1 ||
      !Number.isSafeInteger(job.id) ||
      Number(job.id) < 1 ||
      typeof job.html_url !== "string" ||
      !job.html_url.startsWith(`${runUrl}/job/`)
    )
      throw new RepairError(`generated-head E2E job ${name} did not succeed`);
    return { name, url: job.html_url };
  });
}

async function completedE2eEvidence(
  dispatch: AdvisorRepairE2eDispatch,
  input: {
    prNumber: number;
    workflowSha: string;
    requiredJobs: readonly string[];
    request: GitHubRequest;
  },
): Promise<AdvisorRepairE2eEvidence | null> {
  const url = `https://github.com/${REPAIR_REPOSITORY}/actions/runs/${dispatch.runId}`;
  const run = (await input.request(
    "GET",
    `/repos/${REPAIR_REPOSITORY}/actions/runs/${dispatch.runId}`,
  )) as WorkflowRun;
  if (
    run.id !== dispatch.runId ||
    run.path !== `.github/workflows/${ADVISOR_REPAIR_E2E_WORKFLOW}` ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.head_sha !== input.workflowSha ||
    run.display_title !== `E2E PR #${input.prNumber} (${dispatch.correlationId})` ||
    run.html_url !== url ||
    run.run_attempt !== 1
  )
    throw new RepairError("generated-head E2E run evidence is invalid");
  if (run.status !== "completed") return null;
  if (run.conclusion !== "success") throw new RepairError("generated-head E2E run failed");
  const jobs = await listE2eJobs(dispatch.runId, input.request);
  const generateMatrixMatches = jobs.filter((job) => job.name === "generate-matrix");
  if (generateMatrixMatches.length !== 1)
    throw new RepairError("generated-head E2E generate-matrix job is ambiguous");
  const [generateMatrixJob] = generateMatrixMatches;
  if (
    generateMatrixJob.status !== "completed" ||
    generateMatrixJob.conclusion !== "success" ||
    generateMatrixJob.run_attempt !== 1 ||
    !Number.isSafeInteger(generateMatrixJob.id) ||
    Number(generateMatrixJob.id) < 1 ||
    typeof generateMatrixJob.html_url !== "string" ||
    !generateMatrixJob.html_url.startsWith(`${url}/job/`)
  )
    throw new RepairError("generated-head E2E generate-matrix job did not succeed");
  const requiredJobEvidence = requiredE2eJobEvidence(jobs, input.requiredJobs, url);
  const artifactName = `e2e-dispatch-${dispatch.runId}-1`;
  return {
    ...dispatch,
    runAttempt: 1,
    url,
    receipt: { name: artifactName, url },
    generateMatrix: { name: "generate-matrix", url: generateMatrixJob.html_url },
    requiredJobs: [...input.requiredJobs],
    jobs: requiredJobEvidence,
  };
}

async function publishRepairChecks(
  generatedHeadSha: string,
  attemptKey: string,
  workflows: AdvisorRepairHeadReceipt["workflows"],
  e2e: AdvisorRepairE2eEvidence | null,
  request: GitHubRequest,
): Promise<PublishedCheck[]> {
  const response = (await request(
    "GET",
    `/repos/${REPAIR_REPOSITORY}/commits/${generatedHeadSha}/check-runs?per_page=100`,
  )) as { check_runs?: unknown };
  if (!Array.isArray(response.check_runs) || response.check_runs.length > 100)
    throw new RepairError("generated-head check listing is invalid");
  const existing = response.check_runs as Array<{
    id?: unknown;
    name?: unknown;
    external_id?: unknown;
    conclusion?: unknown;
    details_url?: unknown;
    html_url?: unknown;
  }>;
  const published: PublishedCheck[] = [];
  const jobs = [
    ...workflows.flatMap(({ jobs }) => jobs),
    ...(e2e ? [{ name: ADVISOR_REPAIR_E2E_CHECK, url: e2e.url }] : []),
  ];
  for (const job of jobs) {
    const externalId = `${attemptKey}:${job.name}`;
    const matches = existing.filter((check) => check.external_id === externalId);
    if (matches.length > 1) throw new RepairError(`generated-head check ${job.name} is ambiguous`);
    let check = matches[0];
    if (!check) {
      check = (await request("POST", `/repos/${REPAIR_REPOSITORY}/check-runs`, {
        name: job.name,
        head_sha: generatedHeadSha,
        status: "completed",
        conclusion: "success",
        details_url: job.url,
        external_id: externalId,
        output: {
          title: "Exact generated-head validation passed",
          summary: `The trusted validation job succeeded for ${generatedHeadSha}. Evidence: ${job.url}`,
        },
      })) as (typeof existing)[number];
      existing.push(check);
    }
    if (
      check.name !== job.name ||
      check.conclusion !== "success" ||
      check.details_url !== job.url ||
      !Number.isSafeInteger(check.id) ||
      Number(check.id) < 1 ||
      typeof check.html_url !== "string" ||
      !check.html_url.startsWith(`https://github.com/${REPAIR_REPOSITORY}/`)
    )
      throw new RepairError(`generated-head check ${job.name} evidence is invalid`);
    published.push({ id: Number(check.id), name: job.name, url: check.html_url });
  }
  return published;
}

export async function waitForAdvisorRepairHead(input: {
  prNumber: number;
  sourceHeadSha: string;
  baseSha: string;
  generatedHeadSha: string;
  workflowSha: string;
  changedPaths: readonly string[];
  attemptKey: string;
  request: GitHubRequest;
  token?: string;
  dispatchE2e?: DispatchAdvisorRepairE2e;
  correlationId?: () => string;
  wait?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}): Promise<AdvisorRepairHeadReceipt> {
  const wait =
    input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = input.attempts ?? 120;
  const runName = repairValidationRunName(input.attemptKey, input.generatedHeadSha);
  const receiptName = repairValidationReceiptName(input);
  const riskPlan = advisorRepairRiskPlan(input.generatedHeadSha, input.changedPaths);
  await Promise.all(
    ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS.map((workflow) =>
      dispatchRepairValidation(workflow, input, runName, input.request),
    ),
  );
  const pendingDispatches = await Promise.all(
    ADVISOR_REPAIR_HEAD_WORKFLOWS.map(({ workflow }) =>
      dispatchRepairValidation(workflow, input, runName, input.request),
    ),
  );
  const e2eDispatch = riskPlan.requiredJobs.length
    ? await dispatchAdvisorRepairE2e({
        prNumber: input.prNumber,
        generatedHeadSha: input.generatedHeadSha,
        baseSha: input.baseSha,
        workflowSha: input.workflowSha,
        requiredJobs: riskPlan.requiredJobs,
        token: required(input.token, "GITHUB_TOKEN"),
        correlationId: input.correlationId,
        dispatch: input.dispatchE2e,
      })
    : null;
  const dispatches = new Map<string, { workflow: string; runId: number; url: string }>();
  let e2e: AdvisorRepairE2eEvidence | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pull = (await input.request(
      "GET",
      `/repos/${REPAIR_REPOSITORY}/pulls/${input.prNumber}`,
    )) as LivePullRequest;
    if (
      pull.number !== input.prNumber ||
      pull.state !== "open" ||
      pull.draft ||
      pull.head.sha !== input.generatedHeadSha ||
      pull.head.repo?.full_name !== REPAIR_REPOSITORY ||
      pull.base.sha !== input.baseSha ||
      pull.base.ref !== "main" ||
      pull.base.repo.full_name !== REPAIR_REPOSITORY
    )
      throw new RepairError("pull request changed during generated-head validation");
    for (const pending of pendingDispatches) {
      if (dispatches.has(pending.workflow)) continue;
      const dispatch = await discoverRepairValidationRun(pending, input.request);
      if (dispatch) dispatches.set(pending.workflow, dispatch);
    }
    const workflows: AdvisorRepairHeadReceipt["workflows"] = [];
    for (const specification of ADVISOR_REPAIR_HEAD_WORKFLOWS) {
      const dispatch = dispatches.get(specification.workflow);
      if (!dispatch) continue;
      const evidence = await completedWorkflowEvidence(
        dispatch,
        specification.checks,
        runName,
        receiptName,
        input.request,
      );
      if (evidence) workflows.push(evidence);
    }
    if (e2eDispatch && !e2e)
      e2e = await completedE2eEvidence(e2eDispatch, {
        prNumber: input.prNumber,
        workflowSha: input.workflowSha,
        requiredJobs: riskPlan.requiredJobs,
        request: input.request,
      });
    if (workflows.length === ADVISOR_REPAIR_HEAD_WORKFLOWS.length && (!e2eDispatch || e2e)) {
      const checks = await publishRepairChecks(
        input.generatedHeadSha,
        input.attemptKey,
        workflows,
        e2e,
        input.request,
      );
      return {
        version: 2,
        attemptKey: input.attemptKey,
        sourceHeadSha: input.sourceHeadSha,
        baseSha: input.baseSha,
        generatedHeadSha: input.generatedHeadSha,
        prNumber: input.prNumber,
        outcome: "success",
        workflows,
        riskPlan,
        e2e,
        checks,
        failure: null,
      };
    }
    if (attempt < attempts) await wait(30_000);
  }
  throw new RepairError("generated-head validation did not finish within sixty minutes");
}

function writeAdvisorRepairHeadReceipt(directory: string, receipt: AdvisorRepairHeadReceipt): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, "generated-head.json"), `${JSON.stringify(receipt)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === "advisor-repair-checks") {
    const selection = parseSelection(
      readJson(required(process.env.SELECTION_FILE, "SELECTION_FILE")),
    );
    const validation = parseValidationReceipt(
      readJson(required(process.env.VALIDATION_FILE, "VALIDATION_FILE")),
    );
    const generatedHeadSha = fullSha(
      required(process.env.GENERATED_HEAD_SHA, "GENERATED_HEAD_SHA"),
      "generated head SHA",
    );
    if (
      validation.attemptKey !== selection.attemptKey ||
      validation.prNumber !== selection.prNumber ||
      validation.sourceHeadSha !== selection.sourceHeadSha ||
      validation.baseSha !== selection.baseSha ||
      validation.workflowSha !== selection.workflowSha ||
      JSON.stringify(validation.findingIds) !== JSON.stringify(selection.findingIds) ||
      JSON.stringify(validation.selectedPaths) !== JSON.stringify(selection.selectedPaths)
    )
      throw new RepairError("generated-head validation receipt does not match the selection");
    const changedPaths = validation.changedPaths.map(({ path: file }) => file);
    const riskPlan = advisorRepairRiskPlan(generatedHeadSha, changedPaths);
    const output = required(process.env.VERIFICATION_OUTPUT_DIR, "VERIFICATION_OUTPUT_DIR");
    try {
      const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
      const receipt = await waitForAdvisorRepairHead({
        prNumber: selection.prNumber,
        sourceHeadSha: selection.sourceHeadSha,
        baseSha: selection.baseSha,
        generatedHeadSha,
        workflowSha: selection.workflowSha,
        changedPaths,
        attemptKey: selection.attemptKey,
        request: githubClient(token).request,
        token,
      });
      writeAdvisorRepairHeadReceipt(output, receipt);
      console.log(`Verified all generated-head workflows on ${generatedHeadSha}.`);
    } catch (error) {
      writeAdvisorRepairHeadReceipt(output, {
        version: 2,
        attemptKey: selection.attemptKey,
        sourceHeadSha: selection.sourceHeadSha,
        baseSha: selection.baseSha,
        generatedHeadSha,
        prNumber: selection.prNumber,
        outcome: "manual-remediation-required",
        workflows: [],
        riskPlan,
        e2e: null,
        checks: [],
        failure: sanitizeDiagnostic(error),
      });
      throw error;
    }
    return;
  }
  if (process.argv[2] === "advisor-repair-prepare") {
    const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
    const commitSha = await prepareAdvisorRepair({
      request: githubClient(token).request,
      sourceRepository: required(process.env.SOURCE_REPOSITORY, "SOURCE_REPOSITORY"),
      selectionPath: required(process.env.SELECTION_FILE, "SELECTION_FILE"),
      patchPath: required(process.env.PATCH_FILE, "PATCH_FILE"),
      receiptPath: required(process.env.RECEIPT_FILE, "RECEIPT_FILE"),
      workDirectory: required(process.env.WORK_DIRECTORY, "WORK_DIRECTORY"),
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `prepared-sha=${commitSha}\n`);
    console.log(`Prepared verified Advisor repair commit ${commitSha}.`);
    return;
  }
  if (process.argv[2] === "advisor-repair-publish") {
    const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
    const client = githubClient(token);
    const commitSha = fullSha(required(process.env.PREPARED_SHA, "PREPARED_SHA"), "prepared SHA");
    await publishPreparedAdvisorRepair({
      commitSha,
      graphql: client.graphql,
      request: client.request,
      selectionPath: required(process.env.SELECTION_FILE, "SELECTION_FILE"),
      state: readJson(required(process.env.STATE_FILE, "STATE_FILE")),
      reviews: readJson(required(process.env.REVIEWS_FILE, "REVIEWS_FILE")),
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `published-sha=${commitSha}\n`);
    console.log(`Published verified Advisor repair commit ${commitSha}.`);
    return;
  }
  throw new RepairError(`Unsupported Advisor repair publish command: ${process.argv[2] ?? ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
