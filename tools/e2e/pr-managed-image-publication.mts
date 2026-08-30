// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
} from "../../src/lib/onboard/managed-image/contract.ts";
import { githubRequest } from "./base-image-publication.mts";
import {
  bindNamedExactArtifact,
  downloadBoundArtifact,
  materializeContractArchive,
} from "./exact-artifact-download.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_PATH = ".github/workflows/managed-images.yaml";
const WORKFLOW_FILE = "managed-images.yaml";
const WORKFLOW_NAME = "Images / Build, Test, and Publish Managed Images";
const MAX_CHANGED_FILES = 3_000;
const MAX_COMMIT_TREE_ENTRIES = 100_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/*-]+$/u;
const TREE_ENTRY_MODES = new Map([
  ["blob", new Set(["100644", "100755", "120000"])],
  ["commit", new Set(["160000"])],
  ["tree", new Set(["040000"])],
]);

type JsonRecord = Record<string, unknown>;

export interface ManagedImagePublicationRun {
  readonly id: number;
  readonly attempt: number;
  readonly headSha: string;
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

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function compileManagedImagePath(pattern: string): RegExp {
  if (
    !SAFE_PATH_PATTERN.test(pattern) ||
    pattern.startsWith("/") ||
    pattern.includes("//") ||
    pattern.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`managed-image PR path '${pattern}' is invalid`);
  }
  const stars = [...pattern.matchAll(/\*/gu)].map((match) => match.index);
  if (stars.length === 0) {
    return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
  }
  if (pattern.endsWith("/**") && stars.length === 2) {
    const prefix = pattern.slice(0, -3).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`^${prefix}/.+$`, "u");
  }
  if (stars.length === 1) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*");
    return new RegExp(`^${escaped}$`, "u");
  }
  throw new Error(`managed-image PR path '${pattern}' uses an unsupported glob`);
}

/** Read the managed-image workflow path filter from the trusted workflow source. */
export function parseManagedImagePullRequestPaths(source: string): string[] {
  const workflow = record(YAML.parse(source), "managed-image workflow");
  const triggers = record(workflow.on, "managed-image workflow on block");
  const pullRequest = record(triggers.pull_request, "managed-image pull_request trigger");
  if (!Array.isArray(pullRequest.paths) || pullRequest.paths.length === 0) {
    throw new Error("managed-image pull_request trigger must declare paths");
  }
  const paths = pullRequest.paths.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw new Error("managed-image PR paths must be non-empty strings");
    }
    compileManagedImagePath(value);
    return value;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error("managed-image PR paths must be unique");
  }
  if (!paths.includes(WORKFLOW_PATH)) {
    throw new Error(`managed-image PR paths must include ${WORKFLOW_PATH}`);
  }
  return paths;
}

/** Determine whether changed PR files require exact managed-image publication. */
export function managedImagePublicationRequired(
  changedFiles: readonly string[],
  patterns: readonly string[],
): boolean {
  if (changedFiles.length > MAX_CHANGED_FILES * 2) {
    throw new Error(`PR changed-path count exceeds ${MAX_CHANGED_FILES * 2}`);
  }
  const matchers = patterns.map(compileManagedImagePath);
  for (const file of changedFiles) {
    if (
      file.length === 0 ||
      file.length > 4_096 ||
      /[\0\r\n]/u.test(file) ||
      file.startsWith("/") ||
      file.includes("//") ||
      file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error("PR changed-file path is invalid");
    }
    if (matchers.some((matcher) => matcher.test(file))) return true;
  }
  return false;
}

/** Select the unique successful managed-image workflow run for one PR commit. */
export function selectManagedImagePublicationRun(
  payload: unknown,
  expected: { readonly headSha: string; readonly prNumber: number; readonly workflowId: number },
): ManagedImagePublicationRun {
  if (!SHA_PATTERN.test(expected.headSha)) throw new Error("candidate SHA is invalid");
  positiveInteger(expected.prNumber, "PR number");
  positiveInteger(expected.workflowId, "managed-image workflow id");
  const response = record(payload, "managed-image workflow runs");
  if (response.total_count !== 1 || !Array.isArray(response.workflow_runs)) {
    throw new Error("exact managed-image workflow run is missing or ambiguous");
  }
  if (response.workflow_runs.length !== 1) {
    throw new Error("exact managed-image workflow run listing is incomplete");
  }
  const run = record(response.workflow_runs[0], "managed-image workflow run");
  const id = positiveInteger(run.id, "managed-image workflow run id");
  const attempt = positiveInteger(run.run_attempt, "managed-image workflow run attempt");
  if (run.workflow_id !== expected.workflowId) {
    throw new Error("managed-image workflow run does not match the trusted workflow");
  }
  exactString(run.name, WORKFLOW_NAME, "managed-image workflow run name");
  exactString(run.path, WORKFLOW_PATH, "managed-image workflow run path");
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
    record(run.pull_requests[0], "managed-image workflow pull request").number !== expected.prNumber
  ) {
    throw new Error("managed-image workflow run does not match the PR number");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `managed-image workflow for candidate ${expected.headSha} must complete successfully before live E2E`,
    );
  }
  return { id, attempt, headSha: expected.headSha };
}

/** Assemble one all-agent catalog and reject mixed publication authority. */
export function assembleManagedImageCatalog(
  values: readonly unknown[],
  candidateSha: string,
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
  return Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => [agent, byAgent.get(agent)!]),
  );
}

/** Write one validated exact-candidate catalog from local contract paths. */
export function writeManagedImageCatalog(
  contractPaths: readonly string[],
  candidateSha: string,
  outputPath: string,
): void {
  const contracts = contractPaths.map(
    (contractPath) => JSON.parse(fs.readFileSync(contractPath, "utf8")) as unknown,
  );
  const catalog = assembleManagedImageCatalog(contracts, candidateSha);
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { mode: 0o700, recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(catalog)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function validateWorkflow(payload: unknown): number {
  const workflow = record(payload, "managed-image workflow");
  const id = positiveInteger(workflow.id, "managed-image workflow id");
  exactString(workflow.name, WORKFLOW_NAME, "managed-image workflow name");
  exactString(workflow.path, WORKFLOW_PATH, "managed-image workflow path");
  exactString(workflow.state, "active", "managed-image workflow state");
  return id;
}

async function readCommitTree(
  revision: string,
  label: string,
  request: (path: string) => Promise<unknown>,
): Promise<Map<string, string>> {
  const commit = record(
    await request(`/repos/${REPOSITORY}/git/commits/${revision}`),
    `${label} commit`,
  );
  exactString(commit.sha, revision, `${label} commit SHA`);
  const treeSha = sha(record(commit.tree, `${label} commit tree`).sha, `${label} tree SHA`);
  const payload = record(
    await request(`/repos/${REPOSITORY}/git/trees/${treeSha}?recursive=1`),
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
    if (typeof entry.path !== "string" || entry.path.length === 0) {
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
  input: { readonly baseSha: string; readonly candidateSha: string },
  request: (path: string) => Promise<unknown>,
): Promise<string[]> {
  const baseTree = await readCommitTree(input.baseSha, "PR base", request);
  const candidateTree = await readCommitTree(input.candidateSha, "PR candidate", request);
  const changedFiles: string[] = [];
  for (const changedPath of new Set([...baseTree.keys(), ...candidateTree.keys()])) {
    if (baseTree.get(changedPath) === candidateTree.get(changedPath)) continue;
    changedFiles.push(changedPath);
  }
  return changedFiles;
}

function validatePr(
  payload: unknown,
  expected: { readonly baseSha: string; readonly candidateSha: string; readonly prNumber: number },
): void {
  const pull = record(payload, "pull request");
  exactString(pull.state, "open", "pull request state");
  exactString(
    record(pull.base, "pull request base").sha,
    expected.baseSha,
    "pull request base commit",
  );
  exactString(
    record(pull.head, "pull request source").sha,
    expected.candidateSha,
    "pull request source commit",
  );
  exactString(
    record(record(pull.base, "pull request base").repo, "pull request base repository").full_name,
    REPOSITORY,
    "pull request base repository",
  );
  exactString(
    record(record(pull.head, "pull request source").repo, "pull request source repository")
      .full_name,
    REPOSITORY,
    "pull request source repository",
  );
}

/** Resolve and download the exact all-agent catalog before candidate code executes. */
export async function resolvePrManagedImageCatalog(
  input: {
    readonly baseSha: string;
    readonly candidateRepository: string;
    readonly candidateSha: string;
    readonly outputPath: string;
    readonly prNumber: number;
    readonly token: string;
    readonly workflowSource: string;
  },
  request: (path: string) => Promise<unknown> = (apiPath) => githubRequest(apiPath, input.token),
): Promise<"not-required" | "written"> {
  if (input.candidateRepository !== REPOSITORY) return "not-required";
  if (!SHA_PATTERN.test(input.baseSha) || !SHA_PATTERN.test(input.candidateSha)) {
    throw new Error("PR base and candidate SHAs are required");
  }
  positiveInteger(input.prNumber, "PR number");
  if (!input.token) throw new Error("GITHUB_TOKEN is required");
  validatePr(await request(`/repos/${REPOSITORY}/pulls/${input.prNumber}`), input);
  const changedFiles = await readChangedFiles(input, request);
  const patterns = parseManagedImagePullRequestPaths(input.workflowSource);
  if (!managedImagePublicationRequired(changedFiles, patterns)) return "not-required";

  const workflowId = validateWorkflow(
    await request(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}`),
  );
  const runs = await request(
    `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?event=pull_request&head_sha=${input.candidateSha}&per_page=100`,
  );
  const run = selectManagedImagePublicationRun(runs, {
    headSha: input.candidateSha,
    prNumber: input.prNumber,
    workflowId,
  });

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-managed-catalog-"));
  try {
    const contracts: ManagedImageContractV1[] = [];
    for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
      const name = `managed-pr-contract-${run.id}-${run.attempt}-${agent}`;
      const metadata = await request(
        `/repos/${REPOSITORY}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      );
      const identity = bindNamedExactArtifact(
        metadata,
        {
          headSha: run.headSha,
          runAttempt: run.attempt,
          runId: run.id,
        },
        name,
      );
      const archive = await downloadBoundArtifact(identity, input.token);
      const contractPath = materializeContractArchive(archive, path.join(tempDirectory, agent));
      contracts.push(
        JSON.parse(fs.readFileSync(contractPath, "utf8")) as unknown as ManagedImageContractV1,
      );
    }
    const catalog = assembleManagedImageCatalog(contracts, input.candidateSha);
    fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { mode: 0o700, recursive: true });
    fs.writeFileSync(input.outputPath, `${JSON.stringify(catalog)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return "written";
  } finally {
    fs.rmSync(tempDirectory, { force: true, recursive: true });
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
    writeManagedImageCatalog(argv.slice(3), argv[1], argv[2]);
    console.log("pr-managed-image-catalog outcome=assembled");
    return;
  }
  if (argv.length !== 1) throw new Error("expected one managed-image catalog output path");
  const candidateSha = env.CANDIDATE_SHA ?? "";
  if (!candidateSha) return;
  const result = await resolvePrManagedImageCatalog({
    baseSha: env.BASE_SHA ?? "",
    candidateRepository: env.CANDIDATE_REPOSITORY ?? "",
    candidateSha,
    outputPath: argv[0],
    prNumber: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
    token: env.GITHUB_TOKEN ?? "",
    workflowSource: fs.readFileSync(WORKFLOW_PATH, "utf8"),
  });
  console.log(`pr-managed-image-catalog outcome=${result}`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown PR managed-image error");
    process.exitCode = 1;
  }
}
