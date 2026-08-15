#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  isAllowedDocumentationPath,
  PATCH_FILE,
  PostMergeDocsError,
  RESULT_FILE,
  REVIEW_FILE,
  requireSha,
  validateCandidateArtifact,
} from "./artifact.mts";
import { HARDENED_GIT_ENV, hardenedGitArgs, prepareCombinedBase } from "./base.mts";

function required(value: string | undefined, name: string): string {
  if (!value) throw new PostMergeDocsError(`${name} is required`);
  return value;
}

function readModelObject(file: string, expectedKeys: readonly string[]): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16_384) {
    throw new PostMergeDocsError("model output must be a regular file within 16384 bytes");
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PostMergeDocsError("model output must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const wanted = [...expectedKeys].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new PostMergeDocsError("model output contains unexpected or missing fields");
  }
  if (
    typeof record.summary !== "string" ||
    record.summary.trim() === "" ||
    Buffer.byteLength(record.summary) > 2_000
  ) {
    throw new PostMergeDocsError("model summary must contain 1..2000 bytes");
  }
  return record;
}

function git(
  repository: string,
  args: readonly string[],
  encoding: BufferEncoding | "buffer" = "utf8",
): string | Buffer {
  return execFileSync("git", hardenedGitArgs(args), {
    cwd: repository,
    encoding: encoding === "buffer" ? undefined : encoding,
    env: HARDENED_GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function changedPaths(repository: string, mainSha: string): string[] {
  const output = git(
    repository,
    ["diff", "--name-only", "--no-renames", "-z", mainSha],
    "buffer",
  ) as Buffer;
  const paths = output.toString("utf8").split("\0");
  if (paths.at(-1) === "") paths.pop();
  return [...new Set(paths)].sort();
}

export function finalizeAnalysis(env: NodeJS.ProcessEnv): void {
  const repositoryName = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const mainSha = requireSha(required(env.GITHUB_SHA, "GITHUB_SHA"), "GITHUB_SHA");
  const rangeStartSha = requireSha(
    required(env.RANGE_START_SHA, "RANGE_START_SHA"),
    "RANGE_START_SHA",
  );
  const rangeStartTag = required(env.RANGE_START_TAG, "RANGE_START_TAG");
  const rollingHeadSha = env.ROLLING_HEAD_SHA || null;
  const rollingPrNumber = env.ROLLING_PR_NUMBER ? Number.parseInt(env.ROLLING_PR_NUMBER, 10) : null;
  if (rollingPrNumber !== null && (!Number.isSafeInteger(rollingPrNumber) || rollingPrNumber < 1)) {
    throw new PostMergeDocsError("ROLLING_PR_NUMBER must be empty or a positive safe integer");
  }
  const expectedBaseTree = requireSha(
    required(env.POST_MERGE_DOCS_BASE_TREE_SHA, "POST_MERGE_DOCS_BASE_TREE_SHA"),
    "POST_MERGE_DOCS_BASE_TREE_SHA",
  );
  const outputDirectory = required(env.POST_MERGE_DOCS_OUTPUT_DIR, "POST_MERGE_DOCS_OUTPUT_DIR");
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const model = readModelObject(
    path.join(
      required(env.POST_MERGE_DOCS_RAW_EXPORT_DIR, "POST_MERGE_DOCS_RAW_EXPORT_DIR"),
      "model-result.json",
    ),
    ["includesCodeSampleChanges", "outcome", "summary"],
  );
  if (model.outcome !== "changes" && model.outcome !== "no_changes") {
    throw new PostMergeDocsError("model outcome must be changes or no_changes");
  }
  if (typeof model.includesCodeSampleChanges !== "boolean") {
    throw new PostMergeDocsError("model includesCodeSampleChanges must be a boolean");
  }
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "nemoclaw-docs-finalize-"));
  try {
    const combined = prepareCombinedBase({
      sourceRepository: required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
      destination: path.join(temporaryDirectory, "repo"),
      mainSha,
      rollingHeadSha,
    });
    if (combined.baseTreeSha !== expectedBaseTree) {
      throw new PostMergeDocsError("trusted reconstruction does not match the analyzed base tree");
    }
    const rawPatch = path.join(
      required(env.POST_MERGE_DOCS_RAW_EXPORT_DIR, "POST_MERGE_DOCS_RAW_EXPORT_DIR"),
      PATCH_FILE,
    );
    const patchStat = fs.lstatSync(rawPatch);
    if (!patchStat.isFile() || patchStat.isSymbolicLink() || patchStat.size > 2_097_152) {
      throw new PostMergeDocsError("raw documentation patch is not a bounded regular file");
    }
    if (patchStat.size > 0) {
      execFileSync("git", hardenedGitArgs(["apply", "--index", "--binary", rawPatch]), {
        cwd: combined.repository,
        env: HARDENED_GIT_ENV,
        stdio: ["ignore", "ignore", "pipe"],
      });
    }
    const finalTree = String(git(combined.repository, ["write-tree"])).trim();
    const authorPaths = changedPaths(combined.repository, expectedBaseTree);
    const documentationPaths = changedPaths(combined.repository, mainSha);
    if (
      [...authorPaths, ...documentationPaths].some((entry) => !isAllowedDocumentationPath(entry))
    ) {
      throw new PostMergeDocsError("analysis changed a path outside docs/ or fern/");
    }
    if ((model.outcome === "changes") !== authorPaths.length > 0) {
      throw new PostMergeDocsError("model outcome does not match the documentation tree changes");
    }
    const result = {
      version: 1,
      repository: repositoryName,
      rangeStartTag,
      rangeStartSha,
      mainSha,
      rollingHeadSha,
      rollingPrNumber,
      baseTreeSha: expectedBaseTree,
      finalTreeSha: finalTree,
      outcome: model.outcome,
      summary: model.summary,
      authorPaths,
      documentationPaths,
      includesCodeSampleChanges: model.includesCodeSampleChanges,
    };
    fs.writeFileSync(
      path.join(outputDirectory, RESULT_FILE),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (authorPaths.length > 0) {
      const trustedPatch = git(
        combined.repository,
        [
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          expectedBaseTree,
          finalTree,
        ],
        "buffer",
      ) as Buffer;
      fs.writeFileSync(path.join(outputDirectory, PATCH_FILE), trustedPatch, { mode: 0o600 });
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function finalizeReview(env: NodeJS.ProcessEnv): void {
  const repositoryName = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const mainSha = requireSha(required(env.GITHUB_SHA, "GITHUB_SHA"), "GITHUB_SHA");
  const rangeStartSha = requireSha(
    required(env.RANGE_START_SHA, "RANGE_START_SHA"),
    "RANGE_START_SHA",
  );
  const rangeStartTag = required(env.RANGE_START_TAG, "RANGE_START_TAG");
  const candidateDirectory = required(
    env.POST_MERGE_DOCS_CANDIDATE_DIR,
    "POST_MERGE_DOCS_CANDIDATE_DIR",
  );
  const outputDirectory = required(env.POST_MERGE_DOCS_OUTPUT_DIR, "POST_MERGE_DOCS_OUTPUT_DIR");
  const model = readModelObject(
    path.join(
      required(env.POST_MERGE_DOCS_RAW_EXPORT_DIR, "POST_MERGE_DOCS_RAW_EXPORT_DIR"),
      "model-review.json",
    ),
    ["outcome", "summary"],
  );
  if (model.outcome !== "approved") {
    throw new PostMergeDocsError("independent documentation review did not approve the result");
  }
  const candidate = validateCandidateArtifact({
    artifactDirectory: candidateDirectory,
    expectedRepository: repositoryName,
    expectedRangeStartSha: rangeStartSha,
    expectedMainSha: mainSha,
    expectedRangeStartTag: rangeStartTag,
    expectedRollingHeadSha: env.ROLLING_HEAD_SHA || null,
    expectedRollingPrNumber: env.ROLLING_PR_NUMBER
      ? Number.parseInt(env.ROLLING_PR_NUMBER, 10)
      : null,
  });
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(
    path.join(candidateDirectory, RESULT_FILE),
    path.join(outputDirectory, RESULT_FILE),
  );
  if (candidate.patchPath)
    fs.copyFileSync(candidate.patchPath, path.join(outputDirectory, PATCH_FILE));
  const review = {
    version: 1,
    repository: repositoryName,
    rangeStartTag,
    rangeStartSha,
    mainSha,
    rollingHeadSha: candidate.result.rollingHeadSha,
    rollingPrNumber: candidate.result.rollingPrNumber,
    baseTreeSha: candidate.result.baseTreeSha,
    resultSha256: candidate.resultSha256,
    patchSha256: candidate.patchSha256,
    outcome: "approved",
    summary: model.summary,
  };
  fs.writeFileSync(
    path.join(outputDirectory, REVIEW_FILE),
    `${JSON.stringify(review, null, 2)}\n`,
    { mode: 0o600 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = required(process.env.POST_MERGE_DOCS_PHASE, "POST_MERGE_DOCS_PHASE");
  try {
    if (phase === "analyze") finalizeAnalysis(process.env);
    else if (phase === "review") finalizeReview(process.env);
    else throw new PostMergeDocsError("POST_MERGE_DOCS_PHASE must be analyze or review");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
