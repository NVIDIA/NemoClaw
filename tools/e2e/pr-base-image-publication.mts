// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  baseImageInputsChanged,
  collectPaginated,
  githubRequest,
  parseBaseImagePushPaths,
  type PublicationRun,
  validatePublisherJobs,
  validateWorkflow,
  writePublicationRunOutputs,
} from "./base-image-publication.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_PATH = ".github/workflows/base-image.yaml";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

type RecordValue = Record<string, unknown>;
type ReadGit = (args: string[]) => string;

export interface PrBaseImagePublicationInput {
  readonly baseSha: string;
  readonly candidateRepository: string;
  readonly candidateSha: string;
  readonly prNumber: number;
  readonly publicationRevision: string;
  readonly publicationRunId: number;
  readonly workflowRef: string;
  readonly workflowSha: string;
}

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as RecordValue;
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match the expected identity`);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function integerInput(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${label} must be a positive decimal integer`);
  }
  return positiveInteger(Number(value), label);
}

function validateInput(input: PrBaseImagePublicationInput): void {
  for (const value of [
    input.baseSha,
    input.candidateSha,
    input.publicationRevision,
    input.workflowSha,
  ]) {
    if (!SHA_PATTERN.test(value)) throw new Error("PR publication requires exact commit SHAs");
  }
  positiveInteger(input.publicationRunId, "publication run ID");
  positiveInteger(input.prNumber, "PR number");
  exact(input.candidateRepository, REPOSITORY, "candidate repository");
  exact(input.workflowSha, input.candidateSha, "controller commit");
  if (input.candidateSha === input.baseSha) {
    throw new Error("PR branch publication cannot be used for an exact-base replay");
  }
}

function validatePr(payload: unknown, input: PrBaseImagePublicationInput): string {
  const pr = record(payload, "pull request");
  const base = record(pr.base, "PR base");
  const head = record(pr.head, "PR head");
  const repository = record(head.repo, "PR source repository");
  const owner = record(repository.owner, "PR source owner");
  exact(pr.number, input.prNumber, "PR number");
  exact(pr.state, "open", "PR state");
  exact(record(base.repo, "PR base repository").full_name, REPOSITORY, "PR base repository");
  exact(base.ref, "main", "PR target branch");
  exact(base.sha, input.baseSha, "PR base commit");
  exact(repository.full_name, REPOSITORY, "PR source repository");
  exact(owner.login, "NVIDIA", "PR source owner");
  exact(owner.type, "Organization", "PR source owner type");
  exact(head.sha, input.candidateSha, "live PR head");
  if (typeof head.ref !== "string" || !head.ref || /[\0\r\n]/u.test(head.ref)) {
    throw new Error("PR source branch is invalid");
  }
  exact(input.workflowRef, `refs/heads/${head.ref}`, "controller branch");
  return head.ref;
}

function readGit(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Reuse only an ancestor with identical reviewed image and root audit inputs. */
export function validatePrPublicationInputReuse(
  input: PrBaseImagePublicationInput,
  git: ReadGit = readGit,
): void {
  validateInput(input);
  exact(git(["rev-parse", "--verify", "HEAD^{commit}"]).trim(), input.workflowSha, "checkout");
  try {
    git(["merge-base", "--is-ancestor", input.publicationRevision, input.candidateSha]);
  } catch {
    throw new Error("base publication revision must be an ancestor of the current candidate");
  }
  const paths = new Set(["package.json", "package-lock.json"]);
  for (const revision of new Set([input.publicationRevision, input.candidateSha])) {
    for (const entry of parseBaseImagePushPaths(git(["show", `${revision}:${WORKFLOW_PATH}`]))) {
      paths.add(entry);
    }
  }
  const changed = git([
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    input.publicationRevision,
    input.candidateSha,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  if (baseImageInputsChanged(changed, [...paths])) {
    throw new Error("reviewed image inputs changed after the selected base publication");
  }
}

function validatePrPublicationRun(
  payload: unknown,
  input: PrBaseImagePublicationInput,
  branch: string,
  workflowId: number,
  workflowName: unknown,
  expectedAttempt?: number,
): PublicationRun {
  const run = record(payload, "base publication run");
  exact(run.id, input.publicationRunId, "base publication run ID");
  exact(run.workflow_id, workflowId, "base publication workflow ID");
  exact(run.name, workflowName, "base publication workflow name");
  exact(run.path, WORKFLOW_PATH, "base publication workflow path");
  exact(run.event, "workflow_dispatch", "base publication event");
  exact(run.head_branch, branch, "base publication branch");
  exact(run.head_sha, input.publicationRevision, "base publication commit");
  exact(
    record(run.repository, "publication repository").full_name,
    REPOSITORY,
    "publication repository",
  );
  exact(
    record(run.head_repository, "publication source").full_name,
    REPOSITORY,
    "publication source",
  );
  const url = `https://github.com/${REPOSITORY}/actions/runs/${input.publicationRunId}`;
  exact(run.html_url, url, "base publication URL");
  exact(run.status, "completed", "base publication status");
  exact(run.conclusion, "success", "base publication conclusion");
  const attempt = positiveInteger(run.run_attempt, "base publication attempt");
  if (expectedAttempt !== undefined) exact(attempt, expectedAttempt, "base publication attempt");
  return {
    id: input.publicationRunId,
    attempt,
    workflowId,
    headSha: input.publicationRevision,
    status: "completed",
    conclusion: "success",
    url,
  };
}

/** Authenticate one explicit PR-branch publication before immutable artifact download. */
export async function resolvePrBaseImagePublication(
  input: PrBaseImagePublicationInput,
  request: (apiPath: string) => Promise<unknown>,
  git: ReadGit = readGit,
): Promise<PublicationRun> {
  validateInput(input);
  const prPath = `/repos/${REPOSITORY}/pulls/${input.prNumber}`;
  const branch = validatePr(await request(prPath), input);
  validatePrPublicationInputReuse(input, git);
  const workflow = await request(`/repos/${REPOSITORY}/actions/workflows/base-image.yaml`);
  const workflowId = validateWorkflow(workflow);
  const workflowName = record(workflow, "base publication workflow").name;
  const runPath = `/repos/${REPOSITORY}/actions/runs/${input.publicationRunId}`;
  const run = validatePrPublicationRun(
    await request(runPath),
    input,
    branch,
    workflowId,
    workflowName,
  );
  const attemptPath = `${runPath}/attempts/${run.attempt}`;
  validatePrPublicationRun(
    await request(attemptPath),
    input,
    branch,
    workflowId,
    workflowName,
    run.attempt,
  );
  const jobs = await collectPaginated(request, `${attemptPath}/jobs?per_page=100`, "jobs");
  if (validatePublisherJobs(jobs, run) !== "ready") {
    throw new Error("PR base publication required publishers are incomplete");
  }
  validatePrPublicationRun(
    await request(runPath),
    input,
    branch,
    workflowId,
    workflowName,
    run.attempt,
  );
  exact(validatePr(await request(prPath), input), branch, "PR source branch");
  return run;
}

export async function main(
  env = process.env,
  dependencies: {
    request?: (apiPath: string) => Promise<unknown>;
    git?: ReadGit;
  } = {},
): Promise<void> {
  exact(env.GITHUB_REPOSITORY, REPOSITORY, "workflow repository");
  exact(env.GITHUB_EVENT_NAME, "workflow_dispatch", "workflow event");
  exact(env.REQUIRE_MANAGED_IMAGE_PUBLICATION, "0", "authenticated candidate catalog mode");
  const candidateSha = env.CANDIDATE_SHA ?? "";
  exact(env.GITHUB_SHA, candidateSha, "workflow commit");
  const token = env.GITHUB_TOKEN ?? "";
  if (!token || /[\r\n]/u.test(token)) throw new Error("GITHUB_TOKEN is required");
  const output = env.GITHUB_OUTPUT ?? "";
  if (!output || /[\r\n]/u.test(output)) throw new Error("GITHUB_OUTPUT is required");
  const run = await resolvePrBaseImagePublication(
    {
      baseSha: env.BASE_SHA ?? "",
      candidateRepository: env.CANDIDATE_REPOSITORY ?? "",
      candidateSha,
      prNumber: integerInput(env.PR_NUMBER, "PR number"),
      publicationRevision: env.MANAGED_IMAGE_SHA || candidateSha,
      publicationRunId: integerInput(env.BASE_IMAGE_PUBLICATION_RUN_ID, "publication run ID"),
      workflowRef: env.GITHUB_REF ?? "",
      workflowSha: env.WORKFLOW_SHA ?? "",
    },
    dependencies.request ?? ((apiPath) => githubRequest(apiPath, token)),
    dependencies.git ?? readGit,
  );
  writePublicationRunOutputs(output, run);
  console.log(
    `::notice::Verified PR branch base publication ${run.id}, attempt ${run.attempt}, revision ${run.headSha}`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "PR base publication verification failed",
    );
    process.exitCode = 1;
  });
}
