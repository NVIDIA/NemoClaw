// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { githubRequest, parseBaseImagePushPaths } from "./base-image-publication.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const BASE_IMAGE_WORKFLOW_PATH = ".github/workflows/base-image.yaml";
const MAX_CHANGED_FILES = 3_000;
const PAGE_SIZE = 100;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/*-]+$/u;

type JsonRecord = Record<string, unknown>;

export interface PrChangedFilesInput {
  readonly baseSha: string;
  readonly candidateRepository: string;
  readonly candidateSha: string;
  readonly prNumber: number;
}

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

/** Determine whether changed PR files require local candidate image builds. */
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

async function readChangedFiles(
  prNumber: number,
  count: number,
  request: (path: string) => Promise<unknown>,
): Promise<string[]> {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CHANGED_FILES) {
    throw new Error("PR changed-file count is invalid");
  }
  const files: string[] = [];
  let listedFiles = 0;
  for (let page = 1; listedFiles < count; page += 1) {
    if (page > Math.ceil(MAX_CHANGED_FILES / PAGE_SIZE)) {
      throw new Error("PR changed-file pagination exceeded the safety cap");
    }
    const payload = await request(
      `/repos/${REPOSITORY}/pulls/${prNumber}/files?per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(payload) || payload.length === 0 || payload.length > PAGE_SIZE) {
      throw new Error("PR changed-file page is invalid or incomplete");
    }
    for (const value of payload) {
      const file = record(value, "PR changed file");
      if (typeof file.filename !== "string") throw new Error("PR changed-file name is invalid");
      files.push(file.filename);
      if (file.previous_filename !== undefined) {
        if (typeof file.previous_filename !== "string") {
          throw new Error("PR previous changed-file name is invalid");
        }
        files.push(file.previous_filename);
      }
      listedFiles += 1;
    }
  }
  if (listedFiles !== count) {
    throw new Error("PR changed-file listing is incomplete");
  }
  return [...new Set(files)];
}

function validatePr(
  payload: unknown,
  expected: {
    readonly baseSha: string;
    readonly candidateRepository: string;
    readonly candidateSha: string;
    readonly prNumber: number;
  },
): number {
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
  return positiveInteger(pull.changed_files, "PR changed-file count");
}

/** Read one validated PR change set from the canonical pull-request API. */
export async function readPrChangedFiles(
  input: PrChangedFilesInput,
  request: (path: string) => Promise<unknown>,
): Promise<string[]> {
  if (!SHA_PATTERN.test(input.baseSha) || !SHA_PATTERN.test(input.candidateSha)) {
    throw new Error("PR base and candidate SHAs are required");
  }
  if (
    !REPOSITORY_PATTERN.test(input.candidateRepository) ||
    input.candidateRepository
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("candidate repository is invalid");
  }
  positiveInteger(input.prNumber, "PR number");
  const changedCount = validatePr(
    await request(`/repos/${REPOSITORY}/pulls/${input.prNumber}`),
    input,
  );
  return readChangedFiles(input.prNumber, changedCount, request);
}

/** Select a trusted managed image or the candidate Dockerfile path. */
export async function resolvePrManagedImageSource(
  input: PrChangedFilesInput & {
    readonly token: string;
    readonly workflowSource: string;
  },
  request: (apiPath: string) => Promise<unknown> = (apiPath) =>
    githubRequest(apiPath, input.token),
): Promise<PrManagedImageSource> {
  if (!input.token) throw new Error("GITHUB_TOKEN is required");
  const changedFiles = await readPrChangedFiles(input, request);
  const patterns = parseBaseImagePushPaths(input.workflowSource);
  return managedImagePublicationRequired(changedFiles, patterns)
    ? "local-dockerfile"
    : "managed-image";
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.length !== 1 || argv[0] !== "select-source") {
    throw new Error("expected select-source");
  }
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
