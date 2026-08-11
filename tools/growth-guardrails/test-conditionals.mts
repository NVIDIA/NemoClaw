// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Trusted policy evaluator: a changed test file may not add `if` statements to
// its body. Runs from the base checkout under pull_request_target and reads PR
// blobs as DATA only — blob text is PARSED with the TypeScript AST, never
// executed.
//
// The `if`-statement count reuses the repository contract scanner so local
// Vitest feedback and the trusted PR assertion use one parser.

import { scanTextForTestConditionals } from "../../scripts/find-test-conditionals.mts";
import {
  assertRepositoryName,
  type BlobMap,
  type PrBlobClient,
  type PullRequestFile,
} from "./pr-blob-client.mts";

const TEST_FILE_RE = /^(test|src|nemoclaw\/src)\/.*\.(test|spec)\.(?:[cm]?[jt]s)$/;


export function isTestFilePath(file: string): boolean {
  return TEST_FILE_RE.test(file);
}

/** Count `if` statements in test source using the shared TypeScript AST scanner. */
export function countIfStatements(file: string, text: string): number {
  return scanTextForTestConditionals(file, text).length;
}

function countText(file: string, text: string | null | undefined): number {
  return text == null ? 0 : countIfStatements(file, text);
}

export type ConditionalChange = {
  /** Path to read at the base revision (previous name on a rename). */
  readonly basePath: string;
  /** Path to read at the head revision, or null when removed/renamed-away. */
  readonly headPath: string | null;
  /** Path used in violation output. */
  readonly displayName: string;
};

export type ConditionalEvaluation = {
  readonly details: string[];
  readonly baseTotal: number;
  readonly headTotal: number;
};

/** Pure policy: compare base vs head `if` counts per changed test file. */
export function evaluateConditionalViolations(
  changes: readonly ConditionalChange[],
  baseBlobs: BlobMap,
  headBlobs: BlobMap,
): ConditionalEvaluation {
  const details: string[] = [];
  let baseTotal = 0;
  let headTotal = 0;

  for (const change of changes) {
    const baseCount = countText(change.basePath, baseBlobs.get(change.basePath) ?? null);
    const headCount =
      change.headPath === null
        ? 0
        : countText(change.headPath, headBlobs.get(change.headPath) ?? null);
    baseTotal += baseCount;
    headTotal += headCount;
    if (headCount > baseCount) {
      details.push(
        `${change.headPath ?? change.displayName}: ${headCount} if statement(s), up from ${baseCount}`,
      );
    }
  }

  return { details, baseTotal, headTotal };
}

export type ConditionalEnv = {
  readonly BASE_SHA: string;
  readonly HEAD_REPO: string;
  readonly HEAD_SHA: string;
  readonly PR_NUMBER: string;
  readonly REPO: string;
};

export type ConditionalResult = ConditionalEvaluation & { readonly ok: boolean };

/** Orchestrates fetch + evaluate. The client is injectable for tests. */
export async function runTestConditionals(
  client: PrBlobClient,
  env: ConditionalEnv,
  pullFiles?: readonly PullRequestFile[],
): Promise<ConditionalResult> {
  assertRepositoryName(env.REPO, "REPO");
  assertRepositoryName(env.HEAD_REPO, "HEAD_REPO");

  const files = pullFiles ?? (await client.getPullFiles(env.REPO, env.PR_NUMBER));
  const changedTests = files.filter(
    ({ filename, previous_filename }) =>
      TEST_FILE_RE.test(filename) || TEST_FILE_RE.test(previous_filename ?? ""),
  );

  const changes: ConditionalChange[] = changedTests.map((file) => {
    const basePath = TEST_FILE_RE.test(file.previous_filename ?? "")
      ? (file.previous_filename as string)
      : file.filename;
    const headPath =
      file.status === "removed" || !TEST_FILE_RE.test(file.filename) ? null : file.filename;
    return { basePath, headPath, displayName: file.filename };
  });

  const basePaths = [...new Set(changes.map((change) => change.basePath))];
  const headPaths = [
    ...new Set(changes.map((change) => change.headPath).filter((p): p is string => p !== null)),
  ];

  const [baseBlobs, headBlobs] = await Promise.all([
    client.fetchBlobs(env.REPO, env.BASE_SHA, basePaths),
    client.fetchBlobs(env.HEAD_REPO, env.HEAD_SHA, headPaths),
  ]);

  const evaluation = evaluateConditionalViolations(changes, baseBlobs, headBlobs);
  return { ...evaluation, ok: evaluation.details.length === 0 };
}
