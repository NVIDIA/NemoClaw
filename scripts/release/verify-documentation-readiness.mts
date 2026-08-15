// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPOSITORY = "NVIDIA/NemoClaw";
const ROLLING_BRANCH = "automation/post-merge-docs";
export const DOCUMENTATION_READINESS_WORKFLOW_PATH = ".github/workflows/post-merge-docs.yaml";
export const DOCUMENTATION_READINESS_WORKFLOW_NAME = "Docs / Post-Merge Catch-Up";
export const DOCUMENTATION_READINESS_JOB_NAME = "Documentation readiness";
const WORKFLOW_PATH = DOCUMENTATION_READINESS_WORKFLOW_PATH;
const WORKFLOW_NAME = DOCUMENTATION_READINESS_WORKFLOW_NAME;
const JOB_NAME = DOCUMENTATION_READINESS_JOB_NAME;
const SHA = /^[0-9a-f]{40}$/u;

function workflowUrl(runId: number): string {
  return `https://github.com/${REPOSITORY}/actions/runs/${runId}`;
}

function jobUrl(runId: number, jobId: number): string {
  return `${workflowUrl(runId)}/job/${jobId}`;
}

type JsonRecord = Record<string, unknown>;

export type DocumentationReadinessReceipt = {
  schemaVersion: 1;
  kind: "nemoclaw-documentation-readiness-v1";
  candidateSha: string;
  workflowPath: typeof WORKFLOW_PATH;
  workflowName: typeof WORKFLOW_NAME;
  workflowRunId: number;
  workflowRunAttempt: number;
  workflowUrl: string;
  jobName: typeof JOB_NAME;
  jobId: number;
  jobUrl: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function readRawPages(endpoint: string): unknown[] {
  let output: string;
  try {
    output = execFileSync("gh", ["api", "--paginate", "--slurp", endpoint], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error as { stderr?: Buffer | string };
    throw new Error(
      ["GitHub could not provide documentation readiness evidence", detail.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("GitHub returned invalid JSON for documentation readiness evidence");
  }
  if (!Array.isArray(value)) {
    throw new Error("GitHub returned an invalid documentation readiness response shape");
  }
  return value;
}

function readPages(endpoint: string): JsonRecord[] {
  const pages = readRawPages(endpoint);
  if (pages.some((page) => !isRecord(page))) {
    throw new Error("GitHub returned an invalid documentation readiness response shape");
  }
  return pages as JsonRecord[];
}

function arrayResponseItems(endpoint: string, name: string): JsonRecord[] {
  const pages = readRawPages(endpoint);
  const items: JsonRecord[] = [];
  for (const page of pages) {
    if (!Array.isArray(page) || page.some((item) => !isRecord(item))) {
      throw new Error(`GitHub returned an invalid ${name} response shape`);
    }
    items.push(...page);
  }
  return items;
}

function responseItems(pages: JsonRecord[], key: "jobs" | "workflow_runs"): JsonRecord[] {
  const items: JsonRecord[] = [];
  for (const page of pages) {
    const value = page[key];
    if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
      throw new Error(`GitHub returned an invalid ${key} response shape`);
    }
    items.push(...value);
  }
  return items;
}

function runsEndpoint(candidateSha: string): string {
  const workflow = encodeURIComponent(WORKFLOW_PATH);
  const query = new URLSearchParams({
    branch: "main",
    event: "push",
    head_sha: candidateSha,
    per_page: "100",
  });
  return `repos/${REPOSITORY}/actions/workflows/${workflow}/runs?${query}`;
}

function jobsEndpoint(runId: number): string {
  return `repos/${REPOSITORY}/actions/runs/${runId}/jobs?filter=latest&per_page=100`;
}

function singleCommit(endpoint: string, label: string): JsonRecord {
  const commits = readPages(endpoint);
  if (commits.length !== 1) {
    throw new Error(`GitHub returned an invalid ${label} commit response`);
  }
  return commits[0];
}

function exactRef(endpoint: string, expectedRef: string, label: string): string {
  const responses = readPages(endpoint);
  if (responses.length !== 1) {
    throw new Error(`GitHub returned an invalid ${label} ref response`);
  }
  const object = isRecord(responses[0].object) ? responses[0].object : {};
  if (
    responses[0].ref !== expectedRef ||
    object.type !== "commit" ||
    typeof object.sha !== "string" ||
    !SHA.test(object.sha)
  ) {
    throw new Error(`GitHub returned an invalid ${label} ref`);
  }
  return object.sha;
}

function commitTree(commit: JsonRecord, expectedSha: string, label: string): string {
  const tree = isRecord(commit.tree) ? commit.tree.sha : undefined;
  if (commit.sha !== expectedSha || typeof tree !== "string" || !SHA.test(tree)) {
    throw new Error(`GitHub returned an invalid ${label} commit tree`);
  }
  return tree;
}

function assertNoPendingRollingDocumentation(candidateSha: string): void {
  const liveMain = exactRef(`repos/${REPOSITORY}/git/ref/heads/main`, "refs/heads/main", "main");
  if (liveMain !== candidateSha) {
    throw new Error("The live main branch no longer matches the release candidate");
  }
  const owner = REPOSITORY.split("/")[0];
  const pullQuery = new URLSearchParams({
    state: "open",
    base: "main",
    head: `${owner}:${ROLLING_BRANCH}`,
    per_page: "100",
  });
  const openPulls = arrayResponseItems(
    `repos/${REPOSITORY}/pulls?${pullQuery}`,
    "open rolling documentation PR",
  );
  if (openPulls.length !== 0) {
    throw new Error("The rolling documentation PR must be closed before release");
  }

  const refs = arrayResponseItems(
    `repos/${REPOSITORY}/git/matching-refs/heads/${ROLLING_BRANCH}`,
    "rolling documentation ref",
  ).filter((ref) => ref.ref === `refs/heads/${ROLLING_BRANCH}`);
  if (refs.length > 1) {
    throw new Error("GitHub returned more than one exact rolling documentation ref");
  }
  if (refs.length === 0) {
    const finalOpenPulls = arrayResponseItems(
      `repos/${REPOSITORY}/pulls?${pullQuery}`,
      "open rolling documentation PR",
    );
    const finalRefs = arrayResponseItems(
      `repos/${REPOSITORY}/git/matching-refs/heads/${ROLLING_BRANCH}`,
      "rolling documentation ref",
    ).filter((ref) => ref.ref === `refs/heads/${ROLLING_BRANCH}`);
    const finalMain = exactRef(`repos/${REPOSITORY}/git/ref/heads/main`, "refs/heads/main", "main");
    if (finalOpenPulls.length !== 0 || finalRefs.length !== 0 || finalMain !== candidateSha) {
      throw new Error("The rolling documentation state changed during release verification");
    }
    return;
  }
  const object = isRecord(refs[0].object) ? refs[0].object : {};
  const rollingSha = object.sha;
  if (object.type !== "commit" || typeof rollingSha !== "string" || !SHA.test(rollingSha)) {
    throw new Error("GitHub returned an invalid rolling documentation ref");
  }
  const mainTree = commitTree(
    singleCommit(`repos/${REPOSITORY}/git/commits/${candidateSha}`, "main"),
    candidateSha,
    "main",
  );
  const rollingTree = commitTree(
    singleCommit(`repos/${REPOSITORY}/git/commits/${rollingSha}`, "rolling documentation"),
    rollingSha,
    "rolling documentation",
  );
  if (rollingTree !== mainTree) {
    throw new Error(
      "The rolling documentation branch contains unmerged changes for the release candidate",
    );
  }
  const finalOpenPulls = arrayResponseItems(
    `repos/${REPOSITORY}/pulls?${pullQuery}`,
    "open rolling documentation PR",
  );
  const finalRefs = arrayResponseItems(
    `repos/${REPOSITORY}/git/matching-refs/heads/${ROLLING_BRANCH}`,
    "rolling documentation ref",
  ).filter((ref) => ref.ref === `refs/heads/${ROLLING_BRANCH}`);
  const finalRollingObject =
    finalRefs.length === 1 && isRecord(finalRefs[0].object) ? finalRefs[0].object : {};
  const finalMain = exactRef(`repos/${REPOSITORY}/git/ref/heads/main`, "refs/heads/main", "main");
  if (
    finalOpenPulls.length !== 0 ||
    finalRefs.length !== 1 ||
    finalRollingObject.sha !== rollingSha ||
    finalMain !== candidateSha
  ) {
    throw new Error("The rolling documentation state changed during release verification");
  }
}

function receiptFromGitHub(candidateSha: string): DocumentationReadinessReceipt {
  if (!SHA.test(candidateSha)) {
    throw new Error("Documentation readiness candidate must be a full lowercase commit SHA");
  }

  const runs = responseItems(readPages(runsEndpoint(candidateSha)), "workflow_runs");
  if (runs.length !== 1) {
    throw new Error(
      `Expected exactly one ${WORKFLOW_NAME} push run for candidate commit ${candidateSha}; found ${runs.length}`,
    );
  }

  const run = runs[0];
  if (
    run.head_sha !== candidateSha ||
    run.head_branch !== "main" ||
    run.event !== "push" ||
    run.name !== WORKFLOW_NAME ||
    run.path !== WORKFLOW_PATH ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !positiveInteger(run.id) ||
    !positiveInteger(run.run_attempt) ||
    run.html_url !== workflowUrl(run.id)
  ) {
    throw new Error(
      `${WORKFLOW_NAME} evidence for candidate commit ${candidateSha} is not one completed successful canonical run`,
    );
  }

  const jobs = responseItems(readPages(jobsEndpoint(run.id)), "jobs");
  const matchingJobs = jobs.filter((job) => job.name === JOB_NAME);
  if (matchingJobs.length !== 1) {
    throw new Error(
      `Expected exactly one ${JOB_NAME} job in workflow run ${run.id}; found ${matchingJobs.length}`,
    );
  }

  const job = matchingJobs[0];
  if (
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    !positiveInteger(job.id) ||
    job.html_url !== jobUrl(run.id, job.id)
  ) {
    throw new Error(
      `${JOB_NAME} evidence for candidate commit ${candidateSha} is not one completed successful canonical job`,
    );
  }

  assertNoPendingRollingDocumentation(candidateSha);

  return {
    schemaVersion: 1,
    kind: "nemoclaw-documentation-readiness-v1",
    candidateSha,
    workflowPath: WORKFLOW_PATH,
    workflowName: WORKFLOW_NAME,
    workflowRunId: run.id,
    workflowRunAttempt: run.run_attempt,
    workflowUrl: run.html_url,
    jobName: JOB_NAME,
    jobId: job.id,
    jobUrl: job.html_url,
  };
}

function assertReceipt(value: unknown, candidateSha: string): DocumentationReadinessReceipt {
  if (!isRecord(value)) {
    throw new Error("Release plan has no documentation readiness receipt");
  }
  const expectedKeys = [
    "candidateSha",
    "jobId",
    "jobName",
    "jobUrl",
    "kind",
    "schemaVersion",
    "workflowName",
    "workflowPath",
    "workflowRunAttempt",
    "workflowRunId",
    "workflowUrl",
  ];
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Release plan has an invalid documentation readiness receipt shape");
  }
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "nemoclaw-documentation-readiness-v1" ||
    value.candidateSha !== candidateSha ||
    value.workflowPath !== WORKFLOW_PATH ||
    value.workflowName !== WORKFLOW_NAME ||
    value.jobName !== JOB_NAME ||
    !positiveInteger(value.workflowRunId) ||
    !positiveInteger(value.workflowRunAttempt) ||
    !positiveInteger(value.jobId) ||
    value.workflowUrl !== workflowUrl(value.workflowRunId) ||
    value.jobUrl !== jobUrl(value.workflowRunId, value.jobId)
  ) {
    throw new Error("Release plan has invalid documentation readiness receipt values");
  }
  return value as DocumentationReadinessReceipt;
}

function stableReceipt(receipt: DocumentationReadinessReceipt): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(receipt).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function parseArgs(argv: string[]): { candidateSha: string; planPath?: string } {
  let candidateSha = "";
  let planPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--commit") {
      candidateSha = argv[++index] ?? "";
    } else if (argument === "--plan") {
      planPath = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!candidateSha) {
    throw new Error("--commit is required");
  }
  return { candidateSha, planPath };
}

function main(): void {
  const { candidateSha, planPath } = parseArgs(process.argv.slice(2));
  let planned: DocumentationReadinessReceipt | undefined;
  if (planPath) {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as JsonRecord;
    planned = assertReceipt(plan.documentationReadiness, candidateSha);
  }
  const observed = receiptFromGitHub(candidateSha);
  if (planned) {
    if (stableReceipt(observed) !== stableReceipt(planned)) {
      throw new Error(
        `Documentation readiness evidence changed after release planning for candidate commit ${candidateSha}; regenerate the plan`,
      );
    }
  }
  process.stdout.write(`${JSON.stringify(observed)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-documentation-readiness: ${message}\n`);
    process.exitCode = 1;
  }
}
