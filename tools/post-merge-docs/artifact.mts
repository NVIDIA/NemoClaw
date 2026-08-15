// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RESULT_FILE = "post-merge-docs-result.json";
export const PATCH_FILE = "post-merge-docs.patch";
export const REVIEW_FILE = "post-merge-docs-review.json";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_PATHS = 200;

export type DocsResult = {
  version: 1;
  repository: string;
  rangeStartTag: string;
  rangeStartSha: string;
  mainSha: string;
  rollingHeadSha: string | null;
  rollingPrNumber: number | null;
  baseTreeSha: string;
  outcome: "changes" | "no_changes";
  summary: string;
  finalTreeSha: string;
  authorPaths: string[];
  documentationPaths: string[];
  includesCodeSampleChanges: boolean;
};

export type DocsReview = {
  version: 1;
  repository: string;
  rangeStartTag: string;
  rangeStartSha: string;
  mainSha: string;
  rollingHeadSha: string | null;
  rollingPrNumber: number | null;
  baseTreeSha: string;
  resultSha256: string;
  patchSha256: string | null;
  outcome: "approved";
  summary: string;
};

export type ValidatedArtifact = {
  result: DocsResult;
  resultSha256: string;
  patchPath: string | null;
  patchSha256: string | null;
  review: DocsReview | null;
};

export type ValidatedCandidate = {
  result: DocsResult;
  resultSha256: string;
  patchPath: string | null;
  patchSha256: string | null;
};

export class PostMergeDocsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostMergeDocsError";
  }
}

function fail(message: string): never {
  throw new PostMergeDocsError(message);
}

export function requireSha(value: string, name: string): string {
  if (!SHA_PATTERN.test(value)) fail(`${name} must be a lowercase 40-character Git SHA`);
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    fail(`${name} contains unexpected or missing fields`);
  }
}

function requireString(value: unknown, name: string, maxBytes = 2_000): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a nonempty string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail(`${name} exceeds ${maxBytes} bytes`);
  return value;
}

export function isAllowedDocumentationPath(value: string): boolean {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 512) return false;
  if (!/^[A-Za-z0-9._/-]+$/u.test(value)) return false;
  if (value.includes("\\") || value.startsWith("/") || /[\0-\x1f\x7f]/u.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return false;
  if (
    segments.some((segment) =>
      [".git", ".gitattributes", ".gitmodules", "node_modules"].includes(segment),
    )
  ) {
    return false;
  }
  if (value.startsWith("docs/_build/")) return false;
  if (value === "fern/fern.config.json") return false;
  return value.startsWith("docs/") || value.startsWith("fern/");
}

function parsePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PATHS) {
    fail(`documentationPaths must be an array with at most ${MAX_PATHS} entries`);
  }
  if (!value.every((entry): entry is string => typeof entry === "string")) {
    fail("documentationPaths must contain strings");
  }
  if (value.some((entry) => !isAllowedDocumentationPath(entry))) {
    fail("documentationPaths contains a path outside docs/ or fern/");
  }
  const canonical = [...new Set(value)].sort();
  if (
    canonical.length !== value.length ||
    canonical.some((entry, index) => entry !== value[index])
  ) {
    fail("documentationPaths must be unique and sorted");
  }
  return value;
}

export function parseResult(value: unknown): DocsResult {
  const record = requireRecord(value, "documentation result");
  requireExactKeys(
    record,
    [
      "version",
      "repository",
      "rangeStartTag",
      "rangeStartSha",
      "mainSha",
      "rollingHeadSha",
      "rollingPrNumber",
      "baseTreeSha",
      "outcome",
      "summary",
      "finalTreeSha",
      "authorPaths",
      "documentationPaths",
      "includesCodeSampleChanges",
    ],
    "documentation result",
  );
  if (record.version !== 1) fail("documentation result version must be 1");
  const repository = requireString(record.repository, "repository", 200);
  if (!REPOSITORY_PATTERN.test(repository)) fail("repository is invalid");
  const rangeStartTag = requireString(record.rangeStartTag, "rangeStartTag", 100);
  if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(rangeStartTag)) {
    fail("rangeStartTag must be an exact vMAJOR.MINOR.PATCH tag");
  }
  const outcome = record.outcome;
  if (outcome !== "changes" && outcome !== "no_changes") fail("documentation outcome is invalid");
  const rollingHeadSha = record.rollingHeadSha;
  if (
    rollingHeadSha !== null &&
    (typeof rollingHeadSha !== "string" || !SHA_PATTERN.test(rollingHeadSha))
  ) {
    fail("rollingHeadSha must be null or a lowercase 40-character Git SHA");
  }
  const rollingPrNumber = record.rollingPrNumber;
  if (
    rollingPrNumber !== null &&
    (!Number.isSafeInteger(rollingPrNumber) || Number(rollingPrNumber) < 1)
  ) {
    fail("rollingPrNumber must be null or a positive safe integer");
  }
  const authorPaths = parsePaths(record.authorPaths);
  const documentationPaths = parsePaths(record.documentationPaths);
  if (typeof record.includesCodeSampleChanges !== "boolean") {
    fail("includesCodeSampleChanges must be a boolean");
  }
  if (outcome === "changes" && authorPaths.length === 0) {
    fail("a changes result must list author paths");
  }
  if (outcome === "no_changes" && authorPaths.length !== 0) {
    fail("a no-change result must not list author paths");
  }
  return {
    version: 1,
    repository,
    rangeStartTag,
    rangeStartSha: requireSha(
      requireString(record.rangeStartSha, "rangeStartSha", 40),
      "rangeStartSha",
    ),
    mainSha: requireSha(requireString(record.mainSha, "mainSha", 40), "mainSha"),
    rollingHeadSha,
    rollingPrNumber: rollingPrNumber as number | null,
    baseTreeSha: requireSha(requireString(record.baseTreeSha, "baseTreeSha", 40), "baseTreeSha"),
    outcome,
    summary: requireString(record.summary, "summary"),
    finalTreeSha: requireSha(
      requireString(record.finalTreeSha, "finalTreeSha", 40),
      "finalTreeSha",
    ),
    authorPaths,
    documentationPaths,
    includesCodeSampleChanges: record.includesCodeSampleChanges,
  };
}

export function parseReview(value: unknown): DocsReview {
  const record = requireRecord(value, "documentation review");
  requireExactKeys(
    record,
    [
      "version",
      "repository",
      "rangeStartTag",
      "rangeStartSha",
      "mainSha",
      "rollingHeadSha",
      "rollingPrNumber",
      "baseTreeSha",
      "resultSha256",
      "patchSha256",
      "outcome",
      "summary",
    ],
    "documentation review",
  );
  if (record.version !== 1) fail("documentation review version must be 1");
  if (record.outcome !== "approved") fail("documentation review must approve the patch");
  const resultSha256 = requireString(record.resultSha256, "resultSha256", 64);
  if (!/^[0-9a-f]{64}$/u.test(resultSha256)) fail("resultSha256 is invalid");
  const patchSha256 = record.patchSha256;
  if (
    patchSha256 !== null &&
    (typeof patchSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(patchSha256))
  ) {
    fail("patchSha256 must be null or a lowercase SHA-256 digest");
  }
  const repository = requireString(record.repository, "review repository", 200);
  if (!REPOSITORY_PATTERN.test(repository)) fail("review repository is invalid");
  const rangeStartTag = requireString(record.rangeStartTag, "review rangeStartTag", 100);
  if (!/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(rangeStartTag)) {
    fail("review rangeStartTag must be an exact vMAJOR.MINOR.PATCH tag");
  }
  const rollingHeadSha = record.rollingHeadSha;
  if (
    rollingHeadSha !== null &&
    (typeof rollingHeadSha !== "string" || !SHA_PATTERN.test(rollingHeadSha))
  ) {
    fail("review rollingHeadSha must be null or a lowercase 40-character Git SHA");
  }
  const rollingPrNumber = record.rollingPrNumber;
  if (
    rollingPrNumber !== null &&
    (!Number.isSafeInteger(rollingPrNumber) || Number(rollingPrNumber) < 1)
  ) {
    fail("review rollingPrNumber must be null or a positive safe integer");
  }
  return {
    version: 1,
    repository,
    rangeStartTag,
    rangeStartSha: requireSha(
      requireString(record.rangeStartSha, "review rangeStartSha", 40),
      "review rangeStartSha",
    ),
    mainSha: requireSha(requireString(record.mainSha, "review mainSha", 40), "review mainSha"),
    rollingHeadSha,
    rollingPrNumber: rollingPrNumber as number | null,
    baseTreeSha: requireSha(
      requireString(record.baseTreeSha, "review baseTreeSha", 40),
      "review baseTreeSha",
    ),
    resultSha256,
    patchSha256,
    outcome: "approved",
    summary: requireString(record.summary, "review summary"),
  };
}

function boundedRegularFile(root: string, name: string, maxBytes: number): string {
  const file = path.join(root, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name} must be a regular non-symlink file`);
  if (stat.size <= 0 || stat.size > maxBytes) fail(`${name} size is outside 1..${maxBytes} bytes`);
  const realRoot = `${fs.realpathSync(root)}${path.sep}`;
  if (!fs.realpathSync(file).startsWith(realRoot)) fail(`${name} escapes the artifact directory`);
  return file;
}

function readJsonFile(file: string, name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    fail(`${name} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateArtifact(input: {
  artifactDirectory: string;
  expectedRepository: string;
  expectedRangeStartSha: string;
  expectedRangeStartTag?: string;
  expectedMainSha: string;
  expectedRollingHeadSha?: string | null;
  expectedRollingPrNumber?: number | null;
  maxResultBytes?: number;
  maxPatchBytes?: number;
  maxReviewBytes?: number;
}): ValidatedArtifact {
  const candidate = validateCandidateArtifactInternal(input, true);
  const names = fs.readdirSync(input.artifactDirectory).sort();
  if (!names.includes(REVIEW_FILE)) fail("an approved review receipt is required");
  const reviewPath = boundedRegularFile(
    input.artifactDirectory,
    REVIEW_FILE,
    input.maxReviewBytes ?? 65_536,
  );
  const review = parseReview(readJsonFile(reviewPath, REVIEW_FILE));
  if (
    review.repository !== candidate.result.repository ||
    review.rangeStartTag !== candidate.result.rangeStartTag ||
    review.rangeStartSha !== candidate.result.rangeStartSha ||
    review.mainSha !== candidate.result.mainSha ||
    review.rollingHeadSha !== candidate.result.rollingHeadSha ||
    review.rollingPrNumber !== candidate.result.rollingPrNumber ||
    review.baseTreeSha !== candidate.result.baseTreeSha ||
    review.resultSha256 !== candidate.resultSha256 ||
    review.patchSha256 !== candidate.patchSha256
  ) {
    fail("documentation review does not match the result and patch");
  }
  return { ...candidate, review };
}

export function validateCandidateArtifact(input: {
  artifactDirectory: string;
  expectedRepository: string;
  expectedRangeStartSha: string;
  expectedRangeStartTag?: string;
  expectedMainSha: string;
  expectedRollingHeadSha?: string | null;
  expectedRollingPrNumber?: number | null;
  maxResultBytes?: number;
  maxPatchBytes?: number;
  maxReviewBytes?: number;
}): ValidatedCandidate {
  return validateCandidateArtifactInternal(input, false);
}

function validateCandidateArtifactInternal(
  input: {
    artifactDirectory: string;
    expectedRepository: string;
    expectedRangeStartSha: string;
    expectedMainSha: string;
    expectedRollingHeadSha?: string | null;
    expectedRollingPrNumber?: number | null;
    expectedRangeStartTag?: string;
    maxResultBytes?: number;
    maxPatchBytes?: number;
    maxReviewBytes?: number;
  },
  allowReview: boolean,
): ValidatedCandidate {
  const rootStat = fs.lstatSync(input.artifactDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("artifact root must be a regular non-symlink directory");
  }
  const names = fs.readdirSync(input.artifactDirectory).sort();
  for (const name of names) {
    if (![RESULT_FILE, PATCH_FILE, REVIEW_FILE].includes(name))
      fail(`unexpected artifact entry: ${name}`);
    const stat = fs.lstatSync(path.join(input.artifactDirectory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name} must be a regular non-symlink file`);
  }
  if (!allowReview && names.includes(REVIEW_FILE)) {
    fail("candidate artifact must not contain a review receipt");
  }
  const resultPath = boundedRegularFile(
    input.artifactDirectory,
    RESULT_FILE,
    input.maxResultBytes ?? 65_536,
  );
  const resultSha256 = createHash("sha256").update(fs.readFileSync(resultPath)).digest("hex");
  const result = parseResult(readJsonFile(resultPath, RESULT_FILE));
  requireSha(input.expectedRangeStartSha, "expected range start SHA");
  requireSha(input.expectedMainSha, "expected main SHA");
  if (
    result.repository !== input.expectedRepository ||
    result.rangeStartSha !== input.expectedRangeStartSha ||
    result.mainSha !== input.expectedMainSha
  ) {
    fail("documentation result does not match the expected repository and commit range");
  }
  if (
    input.expectedRollingHeadSha !== undefined &&
    result.rollingHeadSha !== input.expectedRollingHeadSha
  ) {
    fail("documentation result does not match the observed rolling branch commit");
  }
  if (
    input.expectedRollingPrNumber !== undefined &&
    result.rollingPrNumber !== input.expectedRollingPrNumber
  ) {
    fail("documentation result does not match the observed rolling PR number");
  }
  if (
    input.expectedRangeStartTag !== undefined &&
    result.rangeStartTag !== input.expectedRangeStartTag
  ) {
    fail("documentation result does not match the expected semver range tag");
  }

  if (result.outcome === "no_changes") {
    if (names.includes(PATCH_FILE)) {
      fail("a no-change result must not include a patch");
    }
    return { result, resultSha256, patchPath: null, patchSha256: null };
  }

  if (!names.includes(PATCH_FILE)) {
    fail("a changes result requires a patch");
  }
  const patchPath = boundedRegularFile(
    input.artifactDirectory,
    PATCH_FILE,
    input.maxPatchBytes ?? 2_097_152,
  );
  const patchSha256 = createHash("sha256").update(fs.readFileSync(patchPath)).digest("hex");
  return { result, resultSha256, patchPath, patchSha256 };
}
