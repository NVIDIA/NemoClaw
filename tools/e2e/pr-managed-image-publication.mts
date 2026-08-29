// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImageContractCatalog,
} from "../../src/lib/onboard/managed-image/contract.ts";
import {
  baseImageInputsChanged,
  githubRequest,
  parseBaseImagePushPaths,
} from "./base-image-publication.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const BASE_IMAGE_WORKFLOW_PATH = ".github/workflows/base-image.yaml";
const MAX_COMMIT_TREE_ENTRIES = 100_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TREE_ENTRY_TYPES = new Set(["blob", "commit", "tree"]);

type JsonRecord = Record<string, unknown>;

export type PrManagedImageSource = "local-dockerfile" | "managed-image";

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

function assembleManagedImageCatalog(
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

function writeManagedImageCatalog(
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
  for (const value of payload.tree) {
    const entry = record(value, `${label} tree entry`);
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error(`${label} tree entry path is invalid`);
    }
    if (typeof entry.type !== "string" || !TREE_ENTRY_TYPES.has(entry.type)) {
      throw new Error(`${label} tree entry type is invalid`);
    }
    if (typeof entry.mode !== "string" || !/^[0-7]{6}$/u.test(entry.mode)) {
      throw new Error(`${label} tree entry mode is invalid`);
    }
    const entrySha = sha(entry.sha, `${label} tree entry SHA`);
    if (entry.type === "tree") continue;
    if (entries.has(entry.path)) throw new Error(`${label} commit tree contains duplicate paths`);
    entries.set(entry.path, `${entry.mode}:${entry.type}:${entrySha}`);
  }
  return entries;
}

async function readChangedFiles(
  input: {
    readonly baseSha: string;
    readonly candidateRepository: string;
    readonly candidateSha: string;
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
    expected.candidateRepository,
    "pull request source repository",
  );
}

/** Select the managed-image or local-Dockerfile source for a validated PR. */
export async function resolvePrManagedImageSource(
  input: {
    readonly baseSha: string;
    readonly candidateRepository: string;
    readonly candidateSha: string;
    readonly prNumber: number;
    readonly token: string;
    readonly workflowSource: string;
  },
  request: (apiPath: string) => Promise<unknown> = (apiPath) =>
    githubRequest(apiPath, input.token, {
      additionalRepository: input.candidateRepository,
    }),
): Promise<PrManagedImageSource> {
  if (!SHA_PATTERN.test(input.baseSha) || !SHA_PATTERN.test(input.candidateSha)) {
    throw new Error("PR base and candidate SHAs are required");
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
  return baseImageInputsChanged(changedFiles, patterns) ? "local-dockerfile" : "managed-image";
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
  if (argv.length !== 1 || argv[0] !== "select-source") throw new Error("expected select-source");
  const source = await resolvePrManagedImageSource({
    baseSha: env.BASE_SHA ?? "",
    candidateRepository: env.CANDIDATE_REPOSITORY ?? "",
    candidateSha: env.CANDIDATE_SHA ?? "",
    prNumber: requiredInteger(env.PR_NUMBER, "PR_NUMBER"),
    token: env.GITHUB_TOKEN ?? "",
    workflowSource: fs.readFileSync(BASE_IMAGE_WORKFLOW_PATH, "utf8"),
  });
  process.stdout.write(`${source}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown PR managed-image error");
    process.exitCode = 1;
  }
}
