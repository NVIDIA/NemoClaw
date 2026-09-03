// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
} from "../../src/lib/onboard/managed-image/contract.ts";
import {
  baseImageInputsChanged,
  collectPaginated,
  githubRequest,
  parseBaseImagePushPaths,
} from "./base-image-publication.mts";
import {
  bindNamedExactArtifact,
  downloadBoundArtifact,
  materializeContractArchive,
  type BoundArtifactIdentity,
} from "./exact-artifact-download.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const BASE_IMAGE_WORKFLOW_PATH = ".github/workflows/base-image.yaml";
const MANAGED_IMAGE_WORKFLOW_FILE = "managed-images.yaml";
const MANAGED_IMAGE_WORKFLOW_NAME = "Images / Build, Test, and Publish Managed Images";
const MANAGED_IMAGE_WORKFLOW_PATH = ".github/workflows/managed-images.yaml";
const MAX_COMMIT_TREE_ENTRIES = 100_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TREE_ENTRY_MODES = new Map([
  ["blob", new Set(["100644", "100755", "120000"])],
  ["commit", new Set(["160000"])],
  ["tree", new Set(["040000"])],
]);

type JsonRecord = Record<string, unknown>;
type ManagedImageCohort = ManagedImageContractV1["source"]["cohort"];

export type PrManagedImageSelection = "base-cohort" | "candidate-catalog";

export interface ManagedImagePublicationRun {
  readonly attempt: number;
  readonly headSha: string;
  readonly id: number;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
}

export function assembleManagedImageCatalog(
  values: readonly unknown[],
  candidateSha: string,
  expectedCohort: ManagedImageCohort,
): ManagedImageContractCatalog {
  if (!SHA_PATTERN.test(candidateSha)) throw new Error("candidate SHA is invalid");
  if (values.length !== SHIPPED_MANAGED_IMAGE_AGENTS.length) {
    throw new Error(
      `exact PR managed-image publication requires ${SHIPPED_MANAGED_IMAGE_AGENTS.length} contracts`,
    );
  }
  const contracts = values.map((value) =>
    parseManagedImageContractV1(value, undefined, "linux/amd64"),
  );
  const byAgent = new Map(contracts.map((contract) => [contract.agent, contract]));
  if (
    byAgent.size !== SHIPPED_MANAGED_IMAGE_AGENTS.length ||
    SHIPPED_MANAGED_IMAGE_AGENTS.some((agent) => !byAgent.has(agent))
  ) {
    throw new Error("exact PR managed-image publication must contain every shipped agent once");
  }
  const revisions = new Set(contracts.map((contract) => contract.source.revision));
  const releases = new Set(contracts.map((contract) => contract.source.release));
  const cohorts = new Set(contracts.map((contract) => contract.source.cohort));
  if (!revisions.has(candidateSha) || revisions.size !== 1) {
    throw new Error("exact PR managed-image contracts do not match the candidate commit");
  }
  if (releases.size !== 1 || cohorts.size !== 1) {
    throw new Error("exact PR managed-image contracts do not form one publication cohort");
  }
  if (!cohorts.has(expectedCohort)) {
    throw new Error(
      "exact PR managed-image contracts do not match the selected workflow run cohort",
    );
  }
  return Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => [agent, byAgent.get(agent)!]),
  );
}

export function writeManagedImageCatalog(
  contractPaths: readonly string[],
  candidateSha: string,
  outputPath: string,
  expectedCohort: ManagedImageCohort,
): void {
  const contracts = contractPaths.map(
    (contractPath) => JSON.parse(fs.readFileSync(contractPath, "utf8")) as unknown,
  );
  const catalog = assembleManagedImageCatalog(contracts, candidateSha, expectedCohort);
  writeValidatedManagedImageCatalog(catalog, outputPath);
}

function writeValidatedManagedImageCatalog(
  catalog: ManagedImageContractCatalog,
  outputPath: string,
): void {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { mode: 0o700, recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(catalog)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

async function readCommitTree(
  repository: string,
  revision: string,
  label: string,
  request: (path: string) => Promise<unknown>,
): Promise<Map<string, string>> {
  const commit = record(
    await request(`/repos/${repository}/git/commits/${revision}`),
    `${label} commit`,
  );
  exactString(commit.sha, revision, `${label} commit SHA`);
  const treeSha = sha(record(commit.tree, `${label} commit tree`).sha, `${label} tree SHA`);
  const payload = record(
    await request(`/repos/${repository}/git/trees/${treeSha}?recursive=1`),
    `${label} tree`,
  );
  exactString(payload.sha, treeSha, `${label} tree SHA`);
  if (payload.truncated !== false) {
    throw new Error(`${label} commit tree is truncated`);
  }
  if (!Array.isArray(payload.tree) || payload.tree.length > MAX_COMMIT_TREE_ENTRIES) {
    throw new Error(`${label} commit tree is invalid or exceeds the entry limit`);
  }

  const entries = new Map<string, string>();
  const paths = new Set<string>();
  for (const value of payload.tree) {
    const entry = record(value, `${label} tree entry`);
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > 4_096 ||
      /[\0\r\n]/u.test(entry.path) ||
      entry.path.startsWith("/") ||
      entry.path.includes("//") ||
      entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`${label} tree entry path is invalid`);
    }
    if (paths.has(entry.path)) throw new Error(`${label} commit tree contains duplicate paths`);
    paths.add(entry.path);
    const validModes =
      typeof entry.type === "string" ? TREE_ENTRY_MODES.get(entry.type) : undefined;
    if (!validModes) {
      throw new Error(`${label} tree entry type is invalid`);
    }
    if (typeof entry.mode !== "string" || !validModes.has(entry.mode)) {
      throw new Error(`${label} tree entry mode is invalid`);
    }
    const entrySha = sha(entry.sha, `${label} tree entry SHA`);
    if (entry.type === "tree") continue;
    entries.set(entry.path, `${entry.mode}:${entry.type}:${entrySha}`);
  }
  return entries;
}

async function readChangedFiles(
  input: {
    readonly baseSha: string;
    readonly candidateRepository: string;
    readonly candidateSha: string;
    readonly managedImageSha?: string;
  },
  request: (path: string) => Promise<unknown>,
): Promise<string[]> {
  const baseTree = await readCommitTree(REPOSITORY, input.baseSha, "PR base", request);
  const candidateTree = await readCommitTree(
    input.candidateRepository,
    input.candidateSha,
    "PR candidate",
    request,
  );
  const changedFiles: string[] = [];
  for (const changedPath of new Set([...baseTree.keys(), ...candidateTree.keys()])) {
    if (baseTree.get(changedPath) === candidateTree.get(changedPath)) continue;
    changedFiles.push(changedPath);
  }
  return changedFiles;
}

function validatePr(
  payload: unknown,
  expected: {
    readonly baseSha: string;
    readonly candidateRepository: string;
    readonly candidateSha: string;
  },
): void {
  const pull = record(payload, "pull request");
  exactString(pull.state, "open", "pull request state");
  exactString(
    record(pull.base, "pull request base").sha,
    expected.baseSha,
    "pull request base commit",
  );
  exactString(
    record(record(pull.base, "pull request base").repo, "pull request base repository").full_name,
    REPOSITORY,
    "pull request base repository",
  );
  if (expected.candidateSha === expected.baseSha && expected.candidateRepository === REPOSITORY) {
    return;
  }
  exactString(
    record(pull.head, "pull request source").sha,
    expected.candidateSha,
    "pull request source commit",
  );
  exactString(
    record(record(pull.head, "pull request source").repo, "pull request source repository")
      .full_name,
    expected.candidateRepository,
    "pull request source repository",
  );
}

function validateWorkflow(payload: unknown): number {
  const workflow = record(payload, "managed-image workflow");
  const id = positiveInteger(workflow.id, "managed-image workflow id");
  exactString(workflow.name, MANAGED_IMAGE_WORKFLOW_NAME, "managed-image workflow name");
  exactString(workflow.path, MANAGED_IMAGE_WORKFLOW_PATH, "managed-image workflow path");
  exactString(workflow.state, "active", "managed-image workflow state");
  return id;
}

/** Select one successful exact-candidate managed-image workflow run. */
export function selectManagedImagePublicationRun(
  payload: unknown,
  expected: { readonly headSha: string; readonly prNumber: number; readonly workflowId: number },
): ManagedImagePublicationRun {
  if (!SHA_PATTERN.test(expected.headSha)) throw new Error("candidate SHA is invalid");
  positiveInteger(expected.prNumber, "PR number");
  positiveInteger(expected.workflowId, "managed-image workflow id");
  const response = record(payload, "managed-image workflow runs");
  if (!Array.isArray(response.workflow_runs)) {
    throw new Error("exact managed-image workflow run listing is invalid");
  }
  if (response.total_count !== response.workflow_runs.length) {
    throw new Error("exact managed-image workflow run listing is incomplete");
  }
  if (response.workflow_runs.length === 0) {
    throw new Error("exact managed-image workflow run is missing or ambiguous");
  }
  const successfulRuns: ManagedImagePublicationRun[] = [];
  const runIds = new Set<number>();
  for (const rawRun of response.workflow_runs) {
    const run = record(rawRun, "managed-image workflow run");
    const id = positiveInteger(run.id, "managed-image workflow run id");
    const attempt = positiveInteger(run.run_attempt, "managed-image workflow run attempt");
    if (runIds.has(id)) {
      throw new Error("exact managed-image workflow run listing contains duplicate runs");
    }
    runIds.add(id);
    if (run.workflow_id !== expected.workflowId) {
      throw new Error("managed-image workflow run does not match the trusted workflow");
    }
    exactString(run.name, MANAGED_IMAGE_WORKFLOW_NAME, "managed-image workflow run name");
    exactString(run.path, MANAGED_IMAGE_WORKFLOW_PATH, "managed-image workflow run path");
    exactString(run.event, "pull_request", "managed-image workflow run event");
    exactString(run.head_sha, expected.headSha, "managed-image workflow run commit");
    exactString(
      record(run.repository, "managed-image workflow repository").full_name,
      REPOSITORY,
      "managed-image workflow repository",
    );
    exactString(
      record(run.head_repository, "managed-image workflow source repository").full_name,
      REPOSITORY,
      "managed-image workflow source repository",
    );
    if (
      !Array.isArray(run.pull_requests) ||
      run.pull_requests.length !== 1 ||
      record(run.pull_requests[0], "managed-image workflow pull request").number !==
        expected.prNumber
    ) {
      throw new Error("managed-image workflow run does not match the PR number");
    }
    if (run.status === "completed" && run.conclusion === "success") {
      successfulRuns.push({ attempt, headSha: expected.headSha, id });
    }
  }
  if (successfulRuns.length === 0) {
    throw new Error(
      `managed-image workflow for candidate ${expected.headSha} must complete successfully before live E2E`,
    );
  }
  const selectedRun = successfulRuns.sort((left, right) => right.id - left.id)[0];
  if (!selectedRun) throw new Error("successful managed-image workflow run is missing");
  return selectedRun;
}

/** Resolve one exact PR candidate catalog before candidate code executes. */
export async function resolvePrManagedImageCatalog(
  input: {
    readonly baseSha: string;
    readonly candidateRepository: string;
    readonly candidateSha: string;
    readonly managedImageSha?: string;
    readonly outputPath: string;
    readonly prNumber: number;
    readonly token: string;
    readonly workflowSource: string;
  },
  request: (apiPath: string) => Promise<unknown> = (apiPath) =>
    githubRequest(apiPath, input.token, {
      additionalRepository: input.candidateRepository,
    }),
  downloadArtifact: (identity: BoundArtifactIdentity) => Promise<Buffer> = (identity) =>
    downloadBoundArtifact(identity, input.token, { log: console.error }),
): Promise<PrManagedImageSelection> {
  if (!SHA_PATTERN.test(input.baseSha) || !SHA_PATTERN.test(input.candidateSha)) {
    throw new Error("PR base and candidate SHAs are required");
  }
  if (input.managedImageSha !== undefined && !SHA_PATTERN.test(input.managedImageSha)) {
    throw new Error("managed image SHA is invalid");
  }
  if (
    !REPOSITORY_PATTERN.test(input.candidateRepository) ||
    input.candidateRepository.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("candidate repository is invalid");
  }
  positiveInteger(input.prNumber, "PR number");
  if (!input.token) throw new Error("GITHUB_TOKEN is required");
  validatePr(await request(`/repos/${REPOSITORY}/pulls/${input.prNumber}`), input);
  const changedFiles = await readChangedFiles(input, request);
  const patterns = parseBaseImagePushPaths(input.workflowSource);
  if (!baseImageInputsChanged(changedFiles, patterns)) return "base-cohort";
  if (input.candidateRepository !== REPOSITORY) {
    throw new Error("exact PR managed-image publication requires a branch in NVIDIA/NemoClaw");
  }

  const workflowId = validateWorkflow(
    await request(`/repos/${REPOSITORY}/actions/workflows/${MANAGED_IMAGE_WORKFLOW_FILE}`),
  );
  const managedImageSha = input.managedImageSha ?? input.candidateSha;
  const runsPath = `/repos/${REPOSITORY}/actions/workflows/${MANAGED_IMAGE_WORKFLOW_FILE}/runs?event=pull_request&head_sha=${managedImageSha}&per_page=100`;
  const run = selectManagedImagePublicationRun(
    await collectPaginated(request, runsPath, "workflow_runs"),
    { headSha: managedImageSha, prNumber: input.prNumber, workflowId },
  );

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-managed-catalog-"));
  try {
    const contracts: ManagedImageContractV1[] = [];
    for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
      const name = `managed-pr-contract-${run.id}-${run.attempt}-${agent}`;
      const metadata = await request(
        `/repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      );
      const identity = bindNamedExactArtifact(
        metadata,
        { headSha: run.headSha, runAttempt: run.attempt, runId: run.id },
        name,
      );
      const archive = await downloadArtifact(identity);
      const contractPath = materializeContractArchive(
        archive,
        path.join(temporaryDirectory, agent),
      );
      contracts.push(
        JSON.parse(fs.readFileSync(contractPath, "utf8")) as unknown as ManagedImageContractV1,
      );
    }
    const catalog = assembleManagedImageCatalog(
      contracts,
      managedImageSha,
      `ghrun-${run.id}-${run.attempt}` as const,
    );
    writeValidatedManagedImageCatalog(catalog, input.outputPath);
    return "candidate-catalog";
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv[0] === "assemble") {
    if (argv.length < 4) {
      throw new Error("expected candidate SHA, output path, and managed-image contract paths");
    }
    const runId = requiredInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
    const runAttempt = requiredInteger(env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
    writeManagedImageCatalog(
      argv.slice(3),
      argv[1],
      argv[2],
      `ghrun-${runId}-${runAttempt}` as const,
    );
    console.log("pr-managed-image-catalog outcome=assembled");
    return;
  }
  if (argv.length !== 1) throw new Error("expected one managed-image catalog output path");
  const selection = await resolvePrManagedImageCatalog({
    baseSha: env.BASE_SHA ?? "",
    candidateRepository: env.CANDIDATE_REPOSITORY ?? "",
    candidateSha: env.CANDIDATE_SHA ?? "",
    managedImageSha: env.MANAGED_IMAGE_SHA || undefined,
    outputPath: argv[0],
    prNumber: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
    token: env.GITHUB_TOKEN ?? "",
    workflowSource: fs.readFileSync(BASE_IMAGE_WORKFLOW_PATH, "utf8"),
  });
  process.stdout.write(`${selection}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown PR managed-image error");
    process.exitCode = 1;
  }
}
