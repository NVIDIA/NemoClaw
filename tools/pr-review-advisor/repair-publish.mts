#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

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
import {
  buildE2eWorkflowPlan,
  e2eEvidenceJobNamesForSelectors,
  repairValidationCredentialRequiredE2eJob,
  selectedWorkflowJobs,
} from "../e2e/workflow-plan.mts";
import { dispatchWorkflowWithReconciliation } from "../e2e/pr-e2e-dispatch-reconciliation.mts";
import { readValidatedArtifactZipEntries } from "../../scripts/lib/read-artifact-zip.mts";

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
const MAX_E2E_RECEIPT_ARCHIVE_BYTES = 256 * 1024;
const MAX_E2E_RECEIPT_BYTES = 16 * 1024;
const E2E_WORKFLOW_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "workflows",
  "e2e.yaml",
);

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

type WorkflowArtifact = {
  id?: unknown;
  name?: unknown;
  size_in_bytes?: unknown;
  expired?: unknown;
  digest?: unknown;
  archive_download_url?: unknown;
  workflow_run?: { id?: unknown };
};

type E2eDispatchReceipt = {
  kind?: unknown;
  repository?: unknown;
  prNumber?: unknown;
  candidateRepository?: unknown;
  candidateSha?: unknown;
  baseSha?: unknown;
  workflowSha?: unknown;
  workflowRunId?: unknown;
  workflowRunAttempt?: unknown;
  eventName?: unknown;
  jobs?: unknown;
  targets?: unknown;
  allowDgxSparkRunnerQueue?: unknown;
  allowJetsonDispatch?: unknown;
  allowJetsonRunnerQueue?: unknown;
  includeStagingBrevLaunchable?: unknown;
  repairValidation?: unknown;
  repairAttemptKey?: unknown;
  emptySelectors?: unknown;
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

type AdvisorRepairDispatchCheckpoint = {
  workflow: string;
  runId: number | null;
  url: string | null;
  status: string;
  conclusion: string | null;
};

export type AdvisorRepairHeadCheckpoint = {
  workflows: AdvisorRepairDispatchCheckpoint[];
  e2e: (AdvisorRepairDispatchCheckpoint & { correlationId: string }) | null;
};

type AdvisorRepairE2eEvidence = AdvisorRepairE2eDispatch & {
  runAttempt: number;
  url: string;
  receipt: { id: number; name: string; digest: string; url: string };
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

type ArtifactArchiveRequest = (artifactId: number, maxBytes: number) => Promise<Buffer>;

export type AdvisorRepairHeadReceipt = {
  version: 3;
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
  checkpoint: AdvisorRepairHeadCheckpoint;
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

export function advisorRepairCorrelationId(attemptKey: string, generatedHeadSha: string): string {
  const digest = createHash("sha256").update(`${attemptKey}\0${generatedHeadSha}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function createAdvisorRepairHeadCheckpoint(): AdvisorRepairHeadCheckpoint {
  return { workflows: [], e2e: null };
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

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RepairError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

export function e2eControllerDeadlineMinutesForSelectors(
  requiredJobs: readonly string[],
  marginMinutes = 15,
): number {
  if (requiredJobs.length === 0) return 0;
  const plan = buildE2eWorkflowPlan(
    { jobs: requiredJobs.join(",") },
    { gatewayRuntimes: ["docker"] },
  );
  const workflow = record(YAML.parse(readFileSync(E2E_WORKFLOW_PATH, "utf8")), "E2E workflow");
  const jobs = record(workflow.jobs, "E2E workflow jobs");
  const overrides: Record<string, number> = {};
  if (plan.matrix.length > 0)
    overrides.live = Math.max(...plan.matrix.map(({ timeout_minutes }) => timeout_minutes));
  for (const [profile, rows] of Object.entries(plan.catalogueMatrices)) {
    if (rows.length > 0)
      overrides[`catalogue-${profile}`] = Math.max(
        ...rows.map(({ timeout_minutes }) => timeout_minutes),
      );
  }
  const visiting = new Set<string>();
  const memo = new Map<string, number>();
  const duration = (jobId: string): number => {
    const cached = memo.get(jobId);
    if (cached !== undefined) return cached;
    if (visiting.has(jobId)) throw new RepairError(`E2E workflow dependency cycle at ${jobId}`);
    visiting.add(jobId);
    const job = record(jobs[jobId], `E2E workflow job ${jobId}`);
    const configured = overrides[jobId] ?? job["timeout-minutes"];
    if (!Number.isSafeInteger(configured) || Number(configured) < 1)
      throw new RepairError(`E2E workflow job ${jobId} has no bounded timeout`);
    const rawNeeds = job.needs;
    const needs =
      typeof rawNeeds === "string"
        ? [rawNeeds]
        : Array.isArray(rawNeeds) && rawNeeds.every((entry) => typeof entry === "string")
          ? rawNeeds
          : [];
    const result = Number(configured) + Math.max(0, ...needs.map(duration));
    visiting.delete(jobId);
    memo.set(jobId, result);
    return result;
  };
  return Math.max(...selectedWorkflowJobs(plan).map(duration)) + marginMinutes;
}

type DispatchAdvisorRepairE2e = (input: {
  prNumber: number;
  generatedHeadSha: string;
  baseSha: string;
  workflowSha: string;
  correlationId: string;
  attemptKey: string;
  requiredJobs: readonly string[];
  token: string;
}) => Promise<{ runId: number; source: AdvisorRepairE2eDispatch["source"] }>;

export function advisorRepairE2eDispatchRequest(input: {
  prNumber: number;
  generatedHeadSha: string;
  baseSha: string;
  workflowSha: string;
  correlationId: string;
  attemptKey: string;
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
      repair_validation: true,
      repair_attempt_key: input.attemptKey,
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

export async function dispatchAdvisorRepairE2e(input: {
  prNumber: number;
  generatedHeadSha: string;
  baseSha: string;
  workflowSha: string;
  requiredJobs: readonly string[];
  attemptKey: string;
  token: string;
  request?: GitHubRequest;
  correlationId?: () => string;
  dispatch?: DispatchAdvisorRepairE2e;
}): Promise<AdvisorRepairE2eDispatch> {
  const correlationId =
    input.correlationId?.() ?? advisorRepairCorrelationId(input.attemptKey, input.generatedHeadSha);
  if (!input.dispatch && input.request) {
    const title = `E2E PR #${input.prNumber} (${correlationId})`;
    const matches = (
      await listRepairValidationRuns(ADVISOR_REPAIR_E2E_WORKFLOW, input.request)
    ).filter(
      (run) =>
        run.path === `.github/workflows/${ADVISOR_REPAIR_E2E_WORKFLOW}` &&
        run.event === "workflow_dispatch" &&
        run.head_branch === "main" &&
        run.head_sha === input.workflowSha &&
        run.display_title === title &&
        run.html_url === `https://github.com/${REPAIR_REPOSITORY}/actions/runs/${run.id}`,
    );
    if (matches.length > 1) throw new RepairError("generated-head E2E run identity is ambiguous");
    if (matches.length === 1)
      return {
        correlationId,
        runId: Number(matches[0].id),
        source: "workflow-run-inventory",
      };
  }
  const result = await (input.dispatch ?? defaultDispatchAdvisorRepairE2e)({
    ...input,
    correlationId,
  });
  return { correlationId, ...result };
}

async function dispatchRepairValidation(
  workflow: string,
  input: Parameters<typeof repairValidationInputs>[1] & { workflowSha: string },
  runName: string,
  request: GitHubRequest,
): Promise<{
  workflow: string;
  runName: string;
  workflowSha: string;
  existingRun?: WorkflowRun;
}> {
  const prior = await listRepairValidationRuns(workflow, request);
  const matches = prior.filter(
    (run) =>
      run.path === `.github/workflows/${workflow}` &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      run.head_sha === input.workflowSha &&
      run.display_title === runName &&
      run.html_url === `https://github.com/${REPAIR_REPOSITORY}/actions/runs/${run.id}`,
  );
  if (matches.length > 1)
    throw new RepairError(`generated-head ${workflow} run identity is ambiguous`);
  if (matches.length === 1)
    return { workflow, runName, workflowSha: input.workflowSha, existingRun: matches[0] };
  await request("POST", `/repos/${REPAIR_REPOSITORY}/actions/workflows/${workflow}/dispatches`, {
    ref: "main",
    inputs: repairValidationInputs(workflow, input),
  });
  return { workflow, runName, workflowSha: input.workflowSha };
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
  const inventory = pending.existingRun
    ? [pending.existingRun]
    : await listRepairValidationRuns(pending.workflow, request);
  const matches = inventory.filter(
    (run) =>
      run.path === `.github/workflows/${pending.workflow}` &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      run.head_sha === pending.workflowSha &&
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

async function readRepairValidationRun(
  dispatch: { workflow: string; runId: number; url: string },
  runName: string,
  workflowSha: string,
  request: GitHubRequest,
): Promise<WorkflowRun> {
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
    run.head_sha !== workflowSha ||
    !Number.isSafeInteger(run.run_attempt) ||
    Number(run.run_attempt) < 1
  )
    throw new RepairError(`generated-head ${dispatch.workflow} run evidence is invalid`);
  return run;
}

async function completedWorkflowEvidence(
  dispatch: { workflow: string; runId: number; url: string },
  requiredJobs: readonly string[],
  runName: string,
  receiptName: string,
  workflowSha: string,
  request: GitHubRequest,
  observe?: (run: WorkflowRun) => void,
): Promise<AdvisorRepairHeadReceipt["workflows"][number] | null> {
  const run = await readRepairValidationRun(dispatch, runName, workflowSha, request);
  observe?.(run);
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
  let expectedNames: string[];
  try {
    expectedNames = e2eEvidenceJobNamesForSelectors(requiredJobs);
  } catch (error) {
    throw new RepairError(
      `generated-head E2E evidence plan is invalid: ${sanitizeDiagnostic(error)}`,
    );
  }
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

async function listE2eArtifacts(
  runId: number,
  request: GitHubRequest,
): Promise<WorkflowArtifact[]> {
  const artifacts: WorkflowArtifact[] = [];
  const ids = new Set<number>();
  let totalCount: number | undefined;
  for (let page = 1; page <= 10; page += 1) {
    const response = (await request(
      "GET",
      `/repos/${REPAIR_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
    )) as { total_count?: unknown; artifacts?: unknown };
    if (
      !Number.isSafeInteger(response.total_count) ||
      Number(response.total_count) < 0 ||
      Number(response.total_count) > 1_000 ||
      !Array.isArray(response.artifacts) ||
      response.artifacts.length > 100 ||
      (totalCount !== undefined && response.total_count !== totalCount)
    ) {
      throw new RepairError("generated-head E2E artifact listing is invalid");
    }
    totalCount ??= Number(response.total_count);
    for (const artifact of response.artifacts as WorkflowArtifact[]) {
      if (
        !Number.isSafeInteger(artifact.id) ||
        Number(artifact.id) < 1 ||
        ids.has(Number(artifact.id))
      ) {
        throw new RepairError("generated-head E2E artifact listing is invalid");
      }
      ids.add(Number(artifact.id));
      artifacts.push(artifact);
    }
    if (artifacts.length === totalCount) return artifacts;
    if (artifacts.length > totalCount || response.artifacts.length < 100) {
      throw new RepairError("generated-head E2E artifact listing is incomplete");
    }
  }
  throw new RepairError("generated-head E2E artifact listing exceeds one thousand artifacts");
}

async function githubArtifactArchive(
  artifactId: number,
  maxBytes: number,
  token: string,
): Promise<Buffer> {
  const response = await fetch(
    `https://api.github.com/repos/${REPAIR_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
    },
  );
  if (!response.ok) {
    throw new RepairError(`generated-head E2E receipt download failed: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RepairError("generated-head E2E receipt archive is oversized");
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 1 || archive.length > maxBytes) {
    throw new RepairError("generated-head E2E receipt archive is oversized");
  }
  return archive;
}

async function verifiedE2eDispatchReceipt(
  runId: number,
  input: {
    prNumber: number;
    generatedHeadSha: string;
    baseSha: string;
    workflowSha: string;
    attemptKey: string;
    requiredJobs: readonly string[];
    request: GitHubRequest;
    requestArchive: ArtifactArchiveRequest;
  },
): Promise<AdvisorRepairE2eEvidence["receipt"]> {
  const artifactName = `e2e-dispatch-${runId}-1`;
  const matches = (await listE2eArtifacts(runId, input.request)).filter(
    (artifact) => artifact.name === artifactName,
  );
  if (matches.length !== 1) {
    throw new RepairError("generated-head E2E dispatch receipt is missing or ambiguous");
  }
  const [artifact] = matches;
  const artifactId = Number(artifact.id);
  const digest = artifact.digest;
  const archiveUrl = artifact.archive_download_url;
  if (
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    Number(artifact.size_in_bytes) < 1 ||
    Number(artifact.size_in_bytes) > MAX_E2E_RECEIPT_ARCHIVE_BYTES ||
    typeof digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(digest) ||
    archiveUrl !==
      `https://api.github.com/repos/${REPAIR_REPOSITORY}/actions/artifacts/${artifactId}/zip` ||
    artifact.workflow_run?.id !== runId
  ) {
    throw new RepairError("generated-head E2E dispatch receipt identity is invalid");
  }
  const archive = await input.requestArchive(artifactId, MAX_E2E_RECEIPT_ARCHIVE_BYTES);
  if (`sha256:${createHash("sha256").update(archive).digest("hex")}` !== digest) {
    throw new RepairError("generated-head E2E dispatch receipt digest is invalid");
  }
  const entries = readValidatedArtifactZipEntries(archive, {
    maxEntries: 1,
    maxTotalUncompressedBytes: MAX_E2E_RECEIPT_BYTES,
  });
  if (entries?.length !== 1 || entries[0]?.name !== "dispatch.json") {
    throw new RepairError("generated-head E2E dispatch receipt archive is invalid");
  }
  let receipt: E2eDispatchReceipt;
  try {
    receipt = JSON.parse(entries[0].bytes.toString("utf8")) as E2eDispatchReceipt;
  } catch {
    throw new RepairError("generated-head E2E dispatch receipt is invalid JSON");
  }
  if (
    receipt.kind !== "nemoclaw-e2e-dispatch-v2" ||
    receipt.repository !== REPAIR_REPOSITORY ||
    receipt.prNumber !== input.prNumber ||
    receipt.candidateRepository !== REPAIR_REPOSITORY ||
    receipt.candidateSha !== input.generatedHeadSha ||
    receipt.baseSha !== input.baseSha ||
    receipt.workflowSha !== input.workflowSha ||
    receipt.workflowRunId !== String(runId) ||
    receipt.workflowRunAttempt !== 1 ||
    receipt.eventName !== "workflow_dispatch" ||
    receipt.jobs !== input.requiredJobs.join(",") ||
    receipt.targets !== "" ||
    receipt.allowDgxSparkRunnerQueue !== false ||
    receipt.allowJetsonDispatch !== false ||
    receipt.allowJetsonRunnerQueue !== false ||
    receipt.includeStagingBrevLaunchable !== false ||
    receipt.repairValidation !== true ||
    receipt.repairAttemptKey !== input.attemptKey ||
    receipt.emptySelectors !== false
  ) {
    throw new RepairError("generated-head E2E dispatch receipt content is invalid");
  }
  return {
    id: artifactId,
    name: artifactName,
    digest,
    url: `https://github.com/${REPAIR_REPOSITORY}/actions/runs/${runId}#artifacts`,
  };
}

async function completedE2eEvidence(
  dispatch: AdvisorRepairE2eDispatch,
  input: {
    prNumber: number;
    generatedHeadSha: string;
    baseSha: string;
    workflowSha: string;
    attemptKey: string;
    requiredJobs: readonly string[];
    request: GitHubRequest;
    requestArchive: ArtifactArchiveRequest;
    observe?: (run: WorkflowRun) => void;
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
  input.observe?.(run);
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
  const receipt = await verifiedE2eDispatchReceipt(dispatch.runId, input);
  return {
    ...dispatch,
    runAttempt: 1,
    url,
    receipt,
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
  requestArchive?: ArtifactArchiveRequest;
  correlationId?: () => string;
  wait?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  checkpoint?: AdvisorRepairHeadCheckpoint;
}): Promise<AdvisorRepairHeadReceipt> {
  const wait =
    input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const runName = repairValidationRunName(input.attemptKey, input.generatedHeadSha);
  const receiptName = repairValidationReceiptName(input);
  const riskPlan = advisorRepairRiskPlan(input.generatedHeadSha, input.changedPaths);
  const checkpoint = input.checkpoint ?? createAdvisorRepairHeadCheckpoint();
  const credentialJob = repairValidationCredentialRequiredE2eJob(riskPlan.requiredJobs);
  if (credentialJob)
    throw new RepairError(
      `generated-head repair validation requires credential-bearing E2E job ${credentialJob}`,
    );
  const deadlineMinutes = Math.max(
    60,
    e2eControllerDeadlineMinutesForSelectors(riskPlan.requiredJobs),
  );
  if (deadlineMinutes > 345)
    throw new RepairError(
      `generated-head E2E dependency graph requires ${deadlineMinutes} minutes and exceeds the bounded controller window`,
    );
  const attempts = input.attempts ?? deadlineMinutes * 2;
  const pendingDispatches: Awaited<ReturnType<typeof dispatchRepairValidation>>[] = [];
  for (const workflow of ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS) {
    const observed: AdvisorRepairDispatchCheckpoint = {
      workflow,
      runId: null,
      url: null,
      status: "dispatching",
      conclusion: null,
    };
    checkpoint.workflows.push(observed);
    const pending = await dispatchRepairValidation(workflow, input, runName, input.request);
    pendingDispatches.push(pending);
    const dispatch = await discoverRepairValidationRun(pending, input.request);
    observed.runId = dispatch?.runId ?? null;
    observed.url = dispatch?.url ?? null;
    observed.status = pending.existingRun ? "adopted" : dispatch ? "queued" : "dispatched";
  }
  for (const { workflow } of ADVISOR_REPAIR_HEAD_WORKFLOWS) {
    const observed: AdvisorRepairDispatchCheckpoint = {
      workflow,
      runId: null,
      url: null,
      status: "dispatching",
      conclusion: null,
    };
    checkpoint.workflows.push(observed);
    const pending = await dispatchRepairValidation(workflow, input, runName, input.request);
    pendingDispatches.push(pending);
    const dispatch = await discoverRepairValidationRun(pending, input.request);
    observed.runId = dispatch?.runId ?? null;
    observed.url = dispatch?.url ?? null;
    observed.status = pending.existingRun ? "adopted" : dispatch ? "queued" : "dispatched";
  }
  let e2eDispatch: AdvisorRepairE2eDispatch | null = null;
  if (riskPlan.requiredJobs.length) {
    const correlationId =
      input.correlationId?.() ??
      advisorRepairCorrelationId(input.attemptKey, input.generatedHeadSha);
    checkpoint.e2e = {
      workflow: ADVISOR_REPAIR_E2E_WORKFLOW,
      correlationId,
      runId: null,
      url: null,
      status: "dispatching",
      conclusion: null,
    };
    e2eDispatch = await dispatchAdvisorRepairE2e({
      prNumber: input.prNumber,
      generatedHeadSha: input.generatedHeadSha,
      baseSha: input.baseSha,
      workflowSha: input.workflowSha,
      attemptKey: input.attemptKey,
      requiredJobs: riskPlan.requiredJobs,
      token: required(input.token, "GITHUB_TOKEN"),
      request: input.request,
      correlationId: () => correlationId,
      dispatch: input.dispatchE2e,
    });
    checkpoint.e2e.runId = e2eDispatch.runId;
    checkpoint.e2e.url = `https://github.com/${REPAIR_REPOSITORY}/actions/runs/${e2eDispatch.runId}`;
    checkpoint.e2e.status =
      e2eDispatch.source === "workflow-run-inventory" ? "adopted" : "dispatched";
  }
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
      if (dispatch) {
        dispatches.set(pending.workflow, dispatch);
        const observed = checkpoint.workflows.find(({ workflow }) => workflow === pending.workflow);
        if (observed) {
          observed.runId = dispatch.runId;
          observed.url = dispatch.url;
          observed.status = "queued";
        }
      }
    }
    const workflows: AdvisorRepairHeadReceipt["workflows"] = [];
    for (const workflow of ADVISOR_REPAIR_PREREQUISITE_WORKFLOWS) {
      const dispatch = dispatches.get(workflow);
      if (!dispatch) continue;
      const run = await readRepairValidationRun(
        dispatch,
        runName,
        input.workflowSha,
        input.request,
      );
      const observed = checkpoint.workflows.find((entry) => entry.workflow === workflow);
      if (observed) {
        observed.status = String(run.status);
        observed.conclusion = run.conclusion == null ? null : String(run.conclusion);
      }
      if (run.status === "completed" && run.conclusion !== "success")
        throw new RepairError(`generated-head ${workflow} run failed`);
    }
    for (const specification of ADVISOR_REPAIR_HEAD_WORKFLOWS) {
      const dispatch = dispatches.get(specification.workflow);
      if (!dispatch) continue;
      const evidence = await completedWorkflowEvidence(
        dispatch,
        specification.checks,
        runName,
        receiptName,
        input.workflowSha,
        input.request,
        (run) => {
          const observed = checkpoint.workflows.find(
            ({ workflow }) => workflow === specification.workflow,
          );
          if (observed) {
            observed.status = String(run.status);
            observed.conclusion = run.conclusion == null ? null : String(run.conclusion);
          }
        },
      );
      if (evidence) workflows.push(evidence);
    }
    if (e2eDispatch && !e2e)
      e2e = await completedE2eEvidence(e2eDispatch, {
        prNumber: input.prNumber,
        generatedHeadSha: input.generatedHeadSha,
        baseSha: input.baseSha,
        workflowSha: input.workflowSha,
        attemptKey: input.attemptKey,
        requiredJobs: riskPlan.requiredJobs,
        request: input.request,
        requestArchive:
          input.requestArchive ??
          ((artifactId, maxBytes) =>
            githubArtifactArchive(artifactId, maxBytes, required(input.token, "GITHUB_TOKEN"))),
        observe: (run) => {
          if (checkpoint.e2e) {
            checkpoint.e2e.status = String(run.status);
            checkpoint.e2e.conclusion = run.conclusion == null ? null : String(run.conclusion);
          }
        },
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
        version: 3,
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
        checkpoint,
        failure: null,
      };
    }
    if (attempt < attempts) await wait(30_000);
  }
  throw new RepairError("generated-head validation did not finish before its controller deadline");
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
    const checkpoint = createAdvisorRepairHeadCheckpoint();
    try {
      const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
      const receipt = await waitForAdvisorRepairHead({
        prNumber: selection.prNumber,
        sourceHeadSha: selection.sourceHeadSha,
        baseSha: selection.baseSha,
        generatedHeadSha,
        workflowSha: fullSha(
          required(process.env.VALIDATION_WORKFLOW_SHA, "VALIDATION_WORKFLOW_SHA"),
          "validation workflow SHA",
        ),
        changedPaths,
        attemptKey: selection.attemptKey,
        request: githubClient(token).request,
        token,
        checkpoint,
      });
      writeAdvisorRepairHeadReceipt(output, receipt);
      console.log(`Verified all generated-head workflows on ${generatedHeadSha}.`);
    } catch (error) {
      writeAdvisorRepairHeadReceipt(output, {
        version: 3,
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
        checkpoint,
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
