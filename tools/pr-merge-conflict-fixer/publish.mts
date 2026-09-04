#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type ConflictMatrixEntry, parseConflictMatrixEntry } from "./discover.mts";
import {
  applyResolutionPatch,
  ConflictFixerError,
  hasTreeChanges,
  prepareMerge,
  replaceWithTree,
  requireSha,
  samePaths,
  writeTree,
} from "./merge.mts";
import {
  assertLiveRepairState,
  assertValidatedRepair,
  parseSelection,
  parseValidationReceipt,
  readJson,
  REPAIR_REPOSITORY,
  sanitizeDiagnostic,
  validateRepairPatch,
} from "../pr-review-advisor/repair-contract.mts";

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

type LiveRef = {
  object: { sha: string };
};

type GitTreeEntry = {
  mode: string;
  path: string;
  sha: string | null;
  type: "blob" | "commit";
};

export type GitHubRequest = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export type GraphqlRequest = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

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
  if (!value) throw new ConflictFixerError(`${name} is required`);
  return value;
}

export function validatePublicationState(
  entry: ConflictMatrixEntry,
  repository: string,
  pullRequest: LivePullRequest,
  mainRef: LiveRef,
): void {
  if (pullRequest.state !== "open") throw new ConflictFixerError("The pull request is not open");
  if (pullRequest.draft) throw new ConflictFixerError("The pull request is a draft");
  if (pullRequest.base.ref !== "main") {
    throw new ConflictFixerError("The pull request no longer targets main");
  }
  if (
    pullRequest.base.repo.full_name !== repository ||
    pullRequest.head.repo?.full_name !== repository
  ) {
    throw new ConflictFixerError("The pull request is not a same-repository pull request");
  }
  if (pullRequest.head.ref !== entry.head_ref) {
    throw new ConflictFixerError("The pull request head ref changed after the scan");
  }
  if (mainRef.object.sha !== entry.base_sha) {
    throw new ConflictFixerError("main changed after the scan");
  }
}

export function validateResolutionPatch(input: {
  entry: ConflictMatrixEntry;
  patchPath: string;
  sourceRepository: string;
  workDirectory: string;
}): {
  finalTree: string;
  repository: string;
} {
  const merge = prepareMerge(
    input.sourceRepository,
    input.workDirectory,
    input.entry.head_sha,
    input.entry.base_sha,
  );
  if (!merge) throw new ConflictFixerError("The recorded revisions no longer conflict");
  if (!samePaths(merge.conflictPaths, input.entry.conflict_paths)) {
    throw new ConflictFixerError("The conflict paths do not match the scan result");
  }

  replaceWithTree(merge.repository, merge.conflictTree);
  applyResolutionPatch(merge.repository, input.patchPath);
  const finalTree = writeTree(merge.repository);
  if (hasTreeChanges(merge.repository, merge.conflictTree, finalTree, ".github/workflows")) {
    throw new ConflictFixerError("The resolution patch changes GitHub workflows");
  }
  return { finalTree, repository: merge.repository };
}

function gitBuffer(repository: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, {
    cwd: repository,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function changedPathStatuses(
  repository: string,
  fromTree: string,
  toTree: string,
): Array<{ path: string; status: string }> {
  const fields = gitBuffer(repository, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    fromTree,
    toTree,
  ])
    .toString("utf8")
    .split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) {
    throw new ConflictFixerError("Git returned an invalid changed-path list");
  }
  const results: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const filePath = fields[index + 1];
    if (!status || !filePath || !/^[ADMT]$/u.test(status)) {
      throw new ConflictFixerError(`Git returned an unsupported tree change status: ${status}`);
    }
    results.push({ path: filePath, status });
  }
  return results;
}

function optionalTreeEntry(
  repository: string,
  tree: string,
  filePath: string,
): GitTreeEntry | null {
  const output = gitBuffer(repository, ["ls-tree", "-z", tree, "--", filePath]).toString("utf8");
  if (!output) return null;
  const separator = output.indexOf("\t");
  if (separator < 0) throw new ConflictFixerError(`Git tree does not contain ${filePath}`);
  const [mode, type, sha] = output.slice(0, separator).split(" ");
  if (!mode || (type !== "blob" && type !== "commit") || !sha || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new ConflictFixerError(`Git returned an invalid tree entry for ${filePath}`);
  }
  return { mode, path: filePath, sha, type };
}

function treeEntry(repository: string, tree: string, filePath: string): GitTreeEntry {
  const entry = optionalTreeEntry(repository, tree, filePath);
  if (!entry) throw new ConflictFixerError(`Git tree does not contain ${filePath}`);
  return entry;
}

function parentContainsBlob(repository: string, parent: string, entry: GitTreeEntry): boolean {
  const parentEntry = optionalTreeEntry(repository, parent, entry.path);
  return parentEntry?.type === "blob" && parentEntry.sha === entry.sha;
}

export async function createGitHubTree(input: {
  baseSha: string;
  finalTree: string;
  headSha: string;
  repository: string;
  repositoryName: string;
  request: GitHubRequest;
}): Promise<string> {
  const entries: GitTreeEntry[] = [];
  for (const change of changedPathStatuses(input.repository, input.baseSha, input.finalTree)) {
    const sourceTree = change.status === "D" ? input.baseSha : input.finalTree;
    const entry = treeEntry(input.repository, sourceTree, change.path);
    if (change.status === "D") {
      entries.push({ ...entry, sha: null });
      continue;
    }
    if (
      entry.type === "blob" &&
      !parentContainsBlob(input.repository, input.headSha, entry) &&
      !parentContainsBlob(input.repository, input.baseSha, entry)
    ) {
      const content = gitBuffer(input.repository, ["cat-file", "blob", entry.sha ?? ""]);
      const created = (await input.request("POST", `/repos/${input.repositoryName}/git/blobs`, {
        content: content.toString("base64"),
        encoding: "base64",
      })) as { sha?: string };
      if (created.sha !== entry.sha) {
        throw new ConflictFixerError(`GitHub returned an unexpected blob SHA for ${entry.path}`);
      }
    }
    entries.push(entry);
  }

  const created = (await input.request("POST", `/repos/${input.repositoryName}/git/trees`, {
    base_tree: input.baseSha,
    tree: entries,
  })) as { sha?: string };
  if (created.sha !== input.finalTree) {
    throw new ConflictFixerError("GitHub returned a tree that differs from the validated tree");
  }
  return input.finalTree;
}

export async function publishVerifiedCommit(input: {
  finalTree: string;
  graphql: GraphqlRequest;
  headRef: string;
  headSha: string;
  message: string;
  repository: string;
  repositoryId: string;
  repositoryName: string;
  request: GitHubRequest;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<string> {
  const tree = await createGitHubTree({
    baseSha: input.headSha,
    finalTree: input.finalTree,
    headSha: input.headSha,
    repository: input.repository,
    repositoryName: input.repositoryName,
    request: input.request,
  });
  const created = (await input.request("POST", `/repos/${input.repositoryName}/git/commits`, {
    message: input.message,
    parents: [input.headSha],
    tree,
  })) as { sha?: string };
  const commitSha = requireSha(created.sha ?? "", "created commit SHA");
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let verified = false;
  let reason = "verification timed out";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const commit = (await input.request(
      "GET",
      `/repos/${input.repositoryName}/git/commits/${commitSha}`,
    )) as { sha?: string; verification?: { reason?: string; verified?: boolean } };
    if (commit.sha !== commitSha) throw new ConflictFixerError("GitHub returned a different commit");
    if (commit.verification?.verified) {
      verified = true;
      break;
    }
    reason = commit.verification?.reason ?? "unknown reason";
    if (attempt < 11) await sleep(5_000);
  }
  if (!verified) throw new ConflictFixerError(`GitHub did not verify the repair commit: ${reason}`);

  const clientMutationId = commitSha;
  const result = (await input.graphql(
    `mutation UpdateAdvisorRepairRef($input: UpdateRefsInput!) {
      updateRefs(input: $input) { clientMutationId }
    }`,
    {
      input: {
        clientMutationId,
        refUpdates: [
          {
            afterOid: commitSha,
            beforeOid: input.headSha,
            force: false,
            name: `refs/heads/${input.headRef}`,
          },
        ],
        repositoryId: input.repositoryId,
      },
    },
  )) as { updateRefs?: { clientMutationId?: string } };
  if (result.updateRefs?.clientMutationId !== clientMutationId) {
    throw new ConflictFixerError("GitHub did not confirm the atomic PR branch update");
  }
  return commitSha;
}

export async function publishAdvisorRepair(input: {
  graphql: GraphqlRequest;
  request: GitHubRequest;
  sourceRepository: string;
  selectionPath: string;
  patchPath: string;
  receiptPath: string;
  state: unknown;
  reviews: unknown;
  workDirectory: string;
}): Promise<string> {
  const selection = parseSelection(readJson(input.selectionPath));
  if (selection.repository !== REPAIR_REPOSITORY)
    throw new ConflictFixerError("Advisor repair target is not NVIDIA/NemoClaw");
  assertLiveRepairState(selection, input.state, input.reviews);
  const receipt = parseValidationReceipt(readJson(input.receiptPath));
  const candidate = validateRepairPatch({
    sourceCheckout: input.sourceRepository,
    destination: input.workDirectory,
    selection,
    patchFile: input.patchPath,
    expectedChangedPaths: receipt.changedPaths.map(({ path: file }) => file),
  });
  assertValidatedRepair(selection, receipt, candidate);
  return publishVerifiedCommit({
    finalTree: candidate.candidateTreeSha,
    graphql: input.graphql,
    headRef: selection.headRef,
    headSha: selection.sourceHeadSha,
    message: `fix: address PR Review Advisor findings\n\n${selection.findingIds.join("\n")}\n\nAdvisor-Repair-Attempt: ${selection.attemptKey}`,
    repository: candidate.repository,
    repositoryId: selection.repositoryId,
    repositoryName: REPAIR_REPOSITORY,
    request: input.request,
  });
}

async function publishValidatedTree(input: {
  entry: ConflictMatrixEntry;
  finalTree: string;
  graphql: GraphqlRequest;
  pullRequest: LivePullRequest;
  repository: string;
  repositoryName: string;
  request: GitHubRequest;
}): Promise<string> {
  const tree = await createGitHubTree({
    baseSha: input.entry.base_sha,
    finalTree: input.finalTree,
    headSha: input.entry.head_sha,
    repository: input.repository,
    repositoryName: input.repositoryName,
    request: input.request,
  });
  const commit = (await input.request("POST", `/repos/${input.repositoryName}/git/commits`, {
    message: "merge: resolve conflicts with main",
    parents: [input.entry.head_sha, input.entry.base_sha],
    tree,
  })) as {
    sha?: string;
    verification?: { reason?: string; verified?: boolean };
  };
  const commitSha = requireSha(commit.sha ?? "", "created commit SHA");
  if (commit.verification?.verified !== true) {
    throw new ConflictFixerError(
      `GitHub did not verify the merge commit: ${commit.verification?.reason ?? "unknown reason"}`,
    );
  }

  const clientMutationId = commitSha;
  const mutation = `
    mutation UpdateConflictFixerRef($input: UpdateRefsInput!) {
      updateRefs(input: $input) {
        clientMutationId
      }
    }
  `;
  const result = (await input.graphql(mutation, {
    input: {
      clientMutationId,
      refUpdates: [
        {
          afterOid: commitSha,
          beforeOid: input.entry.head_sha,
          force: false,
          name: `refs/heads/${input.entry.head_ref}`,
        },
      ],
      repositoryId: input.pullRequest.base.repo.node_id,
    },
  })) as {
    updateRefs?: { clientMutationId?: string };
  };
  if (result.updateRefs?.clientMutationId !== clientMutationId) {
    throw new ConflictFixerError("GitHub did not confirm the atomic PR branch update");
  }
  return commitSha;
}

export function githubClient(token: string): { graphql: GraphqlRequest; request: GitHubRequest } {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  const parse = async (response: Response): Promise<unknown> => {
    const body = (await response.json()) as {
      data?: unknown;
      errors?: Array<{ message?: string }>;
      message?: string;
    };
    if (!response.ok || body.errors?.length) {
      const message =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") ||
        body.message ||
        `HTTP ${response.status}`;
      throw new ConflictFixerError(`GitHub API request failed: ${message}`);
    }
    return body.data ?? body;
  };
  return {
    graphql: async (query, variables) =>
      parse(
        await fetch("https://api.github.com/graphql", {
          body: JSON.stringify({ query, variables }),
          headers,
          method: "POST",
        }),
      ),
    request: async (method, apiPath, body) =>
      parse(
        await fetch(`https://api.github.com${apiPath}`, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers,
          method,
        }),
      ),
  };
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
  request: GitHubRequest,
): Promise<{ workflow: string; runId: number; url: string }> {
  const response = (await request(
    "POST",
    `/repos/${REPAIR_REPOSITORY}/actions/workflows/${workflow}/dispatches`,
    { ref: "main", inputs: repairValidationInputs(workflow, input) },
  )) as { workflow_run_id?: unknown; run_url?: unknown; html_url?: unknown };
  if (
    !Number.isSafeInteger(response.workflow_run_id) ||
    Number(response.workflow_run_id) < 1 ||
    response.run_url !==
      `https://api.github.com/repos/${REPAIR_REPOSITORY}/actions/runs/${response.workflow_run_id}` ||
    response.html_url !==
      `https://github.com/${REPAIR_REPOSITORY}/actions/runs/${response.workflow_run_id}`
  )
    throw new ConflictFixerError(`generated-head ${workflow} dispatch identity is invalid`);
  return { workflow, runId: Number(response.workflow_run_id), url: response.html_url };
}

async function completedWorkflowEvidence(
  dispatch: { workflow: string; runId: number; url: string },
  requiredJobs: readonly string[],
  runName: string,
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
    throw new ConflictFixerError(`generated-head ${dispatch.workflow} run evidence is invalid`);
  if (run.status !== "completed") return null;
  if (run.conclusion !== "success")
    throw new ConflictFixerError(`generated-head ${dispatch.workflow} run failed`);
  const response = (await request(
    "GET",
    `/repos/${REPAIR_REPOSITORY}/actions/runs/${dispatch.runId}/jobs?per_page=100`,
  )) as { jobs?: unknown };
  if (!Array.isArray(response.jobs) || response.jobs.length > 100)
    throw new ConflictFixerError(`generated-head ${dispatch.workflow} job listing is invalid`);
  const jobs = requiredJobs.map((name) => {
    const matches = (response.jobs as WorkflowJob[]).filter((job) => job.name === name);
    if (matches.length !== 1)
      throw new ConflictFixerError(`generated-head ${dispatch.workflow} job ${name} is ambiguous`);
    const [job] = matches;
    if (
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      !Number.isSafeInteger(job.id) ||
      Number(job.id) < 1 ||
      typeof job.html_url !== "string" ||
      !job.html_url.startsWith(`${dispatch.url}/job/`)
    )
      throw new ConflictFixerError(
        `generated-head ${dispatch.workflow} job ${name} did not succeed`,
      );
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
    throw new ConflictFixerError("generated-head check listing is invalid");
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
    if (matches.length > 1)
      throw new ConflictFixerError(`generated-head check ${job.name} is ambiguous`);
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
      throw new ConflictFixerError(`generated-head check ${job.name} evidence is invalid`);
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
  const wait = input.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = input.attempts ?? 120;
  const runName = repairValidationRunName(input.attemptKey, input.generatedHeadSha);
  const dispatches = await Promise.all(
    ADVISOR_REPAIR_HEAD_WORKFLOWS.map(({ workflow }) =>
      dispatchRepairValidation(workflow, input, input.request),
    ),
  );
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
      throw new ConflictFixerError("pull request changed during generated-head validation");
    const workflows: AdvisorRepairHeadReceipt["workflows"] = [];
    for (const dispatch of dispatches) {
      const specification = ADVISOR_REPAIR_HEAD_WORKFLOWS.find(
        ({ workflow }) => workflow === dispatch.workflow,
      );
      if (!specification) throw new ConflictFixerError("unknown generated-head workflow");
      const evidence = await completedWorkflowEvidence(
        dispatch,
        specification.checks,
        runName,
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
  throw new ConflictFixerError("generated-head validation did not finish within sixty minutes");
}

function writeAdvisorRepairHeadReceipt(
  directory: string,
  receipt: AdvisorRepairHeadReceipt,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(directory, "generated-head.json"),
    `${JSON.stringify(receipt)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

export async function publishResolution(input: {
  entry: ConflictMatrixEntry;
  graphql: GraphqlRequest;
  patchPath: string;
  repositoryName: string;
  request: GitHubRequest;
  sourceRepository: string;
}): Promise<string> {
  const pullRequest = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/pulls/${input.entry.pr_number}`,
  )) as LivePullRequest;
  const mainRef = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/git/ref/heads/main`,
  )) as LiveRef;
  validatePublicationState(input.entry, input.repositoryName, pullRequest, mainRef);

  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "nemoclaw-publish-"));
  try {
    const validated = validateResolutionPatch({
      entry: input.entry,
      patchPath: input.patchPath,
      sourceRepository: input.sourceRepository,
      workDirectory: path.join(temporaryDirectory, "repository"),
    });
    return await publishValidatedTree({
      entry: input.entry,
      finalTree: validated.finalTree,
      graphql: input.graphql,
      pullRequest,
      repository: validated.repository,
      repositoryName: input.repositoryName,
      request: input.request,
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "advisor-repair-checks") {
    const selection = parseSelection(
      readJson(required(process.env.SELECTION_FILE, "SELECTION_FILE")),
    );
    const generatedHeadSha = requireSha(
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
  if (process.argv[2] === "advisor-repair") {
    const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
    const client = githubClient(token);
    const commitSha = await publishAdvisorRepair({
      graphql: client.graphql,
      request: client.request,
      sourceRepository: required(process.env.SOURCE_REPOSITORY, "SOURCE_REPOSITORY"),
      selectionPath: required(process.env.SELECTION_FILE, "SELECTION_FILE"),
      patchPath: required(process.env.PATCH_FILE, "PATCH_FILE"),
      receiptPath: required(process.env.RECEIPT_FILE, "RECEIPT_FILE"),
      state: readJson(required(process.env.STATE_FILE, "STATE_FILE")),
      reviews: readJson(required(process.env.REVIEWS_FILE, "REVIEWS_FILE")),
      workDirectory: required(process.env.WORK_DIRECTORY, "WORK_DIRECTORY"),
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `published-sha=${commitSha}\n`);
    console.log(`Published verified Advisor repair commit ${commitSha}.`);
    return;
  }
  const entry = parseConflictMatrixEntry(required(process.env.MATRIX_ENTRY, "MATRIX_ENTRY"));
  const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const repositoryName = required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const artifactDirectory = required(process.env.ARTIFACT_DIR, "ARTIFACT_DIR");
  const patchPath = path.join(artifactDirectory, "resolution.patch");
  const client = githubClient(token);
  const commitSha = await publishResolution({
    entry,
    graphql: client.graphql,
    patchPath,
    repositoryName,
    request: client.request,
    sourceRepository: required(process.env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
  });
  console.log(`Published verified merge commit ${commitSha} to ${entry.head_ref}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
