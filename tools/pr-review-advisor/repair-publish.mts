#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
};

type PublishedCheck = {
  id: number;
  name: string;
  url: string;
};

export type AdvisorRepairHeadReceipt = {
  version: 1;
  attemptKey: string;
  sourceHeadSha: string;
  baseSha: string;
  generatedHeadSha: string;
  prNumber: number;
  outcome: "success" | "manual-remediation-required";
  workflows: Array<{
    workflow: string;
    runId: number;
    url: string;
    jobs: Array<{ name: string; url: string }>;
  }>;
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
    ...(workflow === "pr.yaml" ? { repair_source_head_sha: input.sourceHeadSha } : {}),
    repair_head_sha: input.generatedHeadSha,
    repair_base_sha: input.baseSha,
    repair_attempt_key: input.attemptKey,
  };
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
  generatedHeadSha: string,
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
    `/repos/${REPAIR_REPOSITORY}/actions/runs/${dispatch.runId}/jobs?per_page=100`,
  )) as { jobs?: unknown };
  if (!Array.isArray(response.jobs) || response.jobs.length > 100)
    throw new RepairError(`generated-head ${dispatch.workflow} job listing is invalid`);
  const jobs = requiredJobs.map((name) => {
    const matches = (response.jobs as WorkflowJob[]).filter((job) => job.name === name);
    if (matches.length !== 1)
      throw new RepairError(`generated-head ${dispatch.workflow} job ${name} is ambiguous`);
    const [job] = matches;
    if (
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      !Number.isSafeInteger(job.id) ||
      Number(job.id) < 1 ||
      typeof job.html_url !== "string" ||
      !job.html_url.startsWith(`${dispatch.url}/job/`)
    )
      throw new RepairError(`generated-head ${dispatch.workflow} job ${name} did not succeed`);
    return { name, url: job.html_url };
  });
  return { ...dispatch, jobs };
}

async function publishRepairChecks(
  generatedHeadSha: string,
  attemptKey: string,
  workflows: AdvisorRepairHeadReceipt["workflows"],
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
  for (const job of workflows.flatMap(({ jobs }) => jobs)) {
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
  attemptKey: string;
  request: GitHubRequest;
  wait?: (milliseconds: number) => Promise<void>;
  attempts?: number;
}): Promise<AdvisorRepairHeadReceipt> {
  const wait =
    input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = input.attempts ?? 120;
  const runName = repairValidationRunName(input.attemptKey, input.generatedHeadSha);
  const pendingDispatches = await Promise.all(
    ADVISOR_REPAIR_HEAD_WORKFLOWS.map(({ workflow }) =>
      dispatchRepairValidation(workflow, input, runName, input.request),
    ),
  );
  const dispatches = new Map<string, { workflow: string; runId: number; url: string }>();
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
        input.generatedHeadSha,
        input.request,
      );
      if (evidence) workflows.push(evidence);
    }
    if (workflows.length === ADVISOR_REPAIR_HEAD_WORKFLOWS.length) {
      const checks = await publishRepairChecks(
        input.generatedHeadSha,
        input.attemptKey,
        workflows,
        input.request,
      );
      return {
        version: 1,
        attemptKey: input.attemptKey,
        sourceHeadSha: input.sourceHeadSha,
        baseSha: input.baseSha,
        generatedHeadSha: input.generatedHeadSha,
        prNumber: input.prNumber,
        outcome: "success",
        workflows,
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
    const generatedHeadSha = fullSha(
      required(process.env.GENERATED_HEAD_SHA, "GENERATED_HEAD_SHA"),
      "generated head SHA",
    );
    const output = required(process.env.VERIFICATION_OUTPUT_DIR, "VERIFICATION_OUTPUT_DIR");
    try {
      const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
      const receipt = await waitForAdvisorRepairHead({
        prNumber: selection.prNumber,
        sourceHeadSha: selection.sourceHeadSha,
        baseSha: selection.baseSha,
        generatedHeadSha,
        attemptKey: selection.attemptKey,
        request: githubClient(token).request,
      });
      writeAdvisorRepairHeadReceipt(output, receipt);
      console.log(`Verified all generated-head workflows on ${generatedHeadSha}.`);
    } catch (error) {
      writeAdvisorRepairHeadReceipt(output, {
        version: 1,
        attemptKey: selection.attemptKey,
        sourceHeadSha: selection.sourceHeadSha,
        baseSha: selection.baseSha,
        generatedHeadSha,
        prNumber: selection.prNumber,
        outcome: "manual-remediation-required",
        workflows: [],
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
