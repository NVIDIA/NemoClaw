// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Trusted policy evaluator: changed test files must stay within the size budget,
// and the budget itself must stay monotonic (a PR may not weaken it). Runs from
// the base checkout under pull_request_target and reads PR blobs as DATA only.
//
// Line counting and budget parsing are reused from the local scanner
// (scripts/check-test-file-size-budget.mts) so the workflow and the local check
// agree by construction — no second implementation lives in workflow YAML.

import {
  countLines,
  parseBudget,
  type TestFileSizeBudget,
} from "../../scripts/check-test-file-size-budget.mts";
import {
  type BlobMap,
  createPrBlobClient,
  type PrBlobClient,
  type PullRequestFile,
} from "./pr-blob-client.mts";

const BUDGET_FILE = "ci/test-file-size-budget.json";
const FALLBACK_BUDGET = '{"defaultMaxLines":1500,"legacyMaxLines":{}}';
const TEST_FILE_RE = /^(test|src|nemoclaw\/src)\/.*\.(test|spec)\.(ts|js|mts|mjs|cts|cjs)$/;

export type BudgetEvaluationInput = {
  readonly baseBudget: TestFileSizeBudget;
  readonly headBudget: TestFileSizeBudget;
  readonly headBlobs: BlobMap;
  readonly changedTests: readonly string[];
  /**
   * Maps a renamed test's head path to its base path, so a moved legacy
   * allowance is compared against the base-path entry instead of read as new.
   */
  readonly renames: ReadonlyMap<string, string>;
};

function legacyOf(budget: TestFileSizeBudget): Readonly<Record<string, number>> {
  return budget.legacyMaxLines ?? {};
}

/**
 * Pure budget policy. Returns human-readable violation strings (empty = PASS).
 * Throws only for a structural impossibility (a changed test missing at head).
 *
 * When the base budget file is absent the caller passes the 1500-line fallback
 * as baseBudget, so default-limit monotonicity is always enforced against it.
 */
export function evaluateTestSizeBudgetViolations(input: BudgetEvaluationInput): string[] {
  const { baseBudget, headBudget, headBlobs, changedTests, renames } = input;
  const baseLegacy = legacyOf(baseBudget);
  const headLegacy = legacyOf(headBudget);
  const violations: string[] = [];

  if (headBudget.defaultMaxLines > baseBudget.defaultMaxLines) {
    violations.push(
      `defaultMaxLines increased from ${baseBudget.defaultMaxLines} to ${headBudget.defaultMaxLines}`,
    );
  }

  // Each head legacy entry is compared against its base allowance, following a
  // rename so a moved-but-unchanged budget is not misread as newly added.
  for (const [file, headMax] of Object.entries(headLegacy)) {
    const baseMax = baseLegacy[renames.get(file) ?? file];
    if (baseMax === undefined && headMax > headBudget.defaultMaxLines) {
      violations.push(
        `${file} adds a new legacy budget (${headMax}) above defaultMaxLines (${headBudget.defaultMaxLines})`,
      );
    }
    if (baseMax !== undefined && headMax > baseMax) {
      violations.push(`${file} legacy budget increased from ${baseMax} to ${headMax}`);
    }
    const text = headBlobs.get(file);
    if (text == null) {
      violations.push(`${file} has a legacy budget but no matching test file at the PR head`);
      continue;
    }
    const lines = countLines(text);
    if (lines > headMax)
      violations.push(`${file} has ${lines} line(s), above its legacy budget ${headMax}`);
    if (lines < headMax) {
      violations.push(
        `${file}: ${lines} line(s) < ${headMax} legacy budget; lower the budget entry`,
      );
    }
  }

  // A base legacy entry dropped at head (and not carried over by a rename) must
  // not be removed while its file still exceeds the default.
  const carriedBases = new Set(Object.keys(headLegacy).map((file) => renames.get(file) ?? file));
  for (const file of Object.keys(baseLegacy)) {
    if (headLegacy[file] !== undefined || carriedBases.has(file)) continue;
    const text = headBlobs.get(file);
    if (text != null && countLines(text) > headBudget.defaultMaxLines) {
      violations.push(`${file} removed its legacy budget while still exceeding defaultMaxLines`);
    }
  }

  for (const filename of changedTests) {
    const text = headBlobs.get(filename);
    if (text == null) throw new Error(`Changed test file ${filename} was not found at the PR head`);
    const lines = countLines(text);
    const maxLines = headLegacy[filename] ?? headBudget.defaultMaxLines;
    if (lines > maxLines) violations.push(`${filename}: ${lines} line(s) > ${maxLines}`);
  }

  return violations;
}

export type BudgetEnv = {
  readonly BASE_SHA: string;
  readonly HEAD_REPO: string;
  readonly HEAD_SHA: string;
  readonly PR_NUMBER: string;
  readonly REPO: string;
};

export type BudgetResult = {
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly changedTestCount: number;
};

/** Orchestrates fetch + evaluate. The client is injectable for tests. */
export async function runTestSizeBudget(
  client: PrBlobClient,
  env: BudgetEnv,
): Promise<BudgetResult> {
  const files = await client.getPullFiles(env.REPO, env.PR_NUMBER);
  const budgetChanged = files.some(
    ({ filename, previous_filename }) =>
      filename === BUDGET_FILE || previous_filename === BUDGET_FILE,
  );
  const changedTests = files
    .filter(
      ({ filename, status }: PullRequestFile) =>
        status !== "removed" && TEST_FILE_RE.test(filename),
    )
    .map(({ filename }) => filename);

  // Renamed test files map their head path back to their base path so a moved
  // legacy budget is compared against the base-path allowance, not read as new.
  const renames = new Map<string, string>();
  for (const { filename, previous_filename } of files) {
    if (previous_filename && previous_filename !== filename)
      renames.set(filename, previous_filename);
  }

  // Base budget lives in the trusted base repo; fetch it alone so we can parse
  // legacy entries before deciding which HEAD blobs to load. When it is absent
  // the 1500-line fallback becomes the baseline the head budget must not weaken.
  const baseBlobs = await client.fetchBlobs(env.REPO, env.BASE_SHA, [BUDGET_FILE]);
  const baseText = baseBlobs.get(BUDGET_FILE);
  const baseBudget = parseBudget(baseText ?? FALLBACK_BUDGET, "base budget");

  let headBudget = baseBudget;
  if (budgetChanged) {
    const headBudgetBlobs = await client.fetchBlobs(env.HEAD_REPO, env.HEAD_SHA, [BUDGET_FILE]);
    const headText = headBudgetBlobs.get(BUDGET_FILE);
    if (headText == null)
      throw new Error(`${BUDGET_FILE} must remain present and parseable at the PR head`);
    headBudget = parseBudget(headText, "head budget");
  }

  // Assemble every HEAD path we still need in one deduplicated batch: each HEAD
  // legacy file, each BASE legacy file that HEAD dropped, and each changed test.
  const headPaths = new Set<string>();
  for (const file of Object.keys(legacyOf(headBudget))) headPaths.add(file);
  for (const file of Object.keys(legacyOf(baseBudget))) {
    if (legacyOf(headBudget)[file] === undefined) headPaths.add(file);
  }
  for (const filename of changedTests) headPaths.add(filename);

  const headBlobs = await client.fetchBlobs(env.HEAD_REPO, env.HEAD_SHA, Array.from(headPaths));

  const violations = evaluateTestSizeBudgetViolations({
    baseBudget,
    headBudget,
    headBlobs,
    changedTests,
    renames,
  });

  return { ok: violations.length === 0, violations, changedTestCount: changedTests.length };
}

function readEnv(): BudgetEnv & { GH_TOKEN: string } {
  const { BASE_SHA, GH_TOKEN, HEAD_REPO, HEAD_SHA, PR_NUMBER, REPO } = process.env;
  if (!BASE_SHA || !GH_TOKEN || !HEAD_REPO || !HEAD_SHA || !PR_NUMBER || !REPO) {
    throw new Error(
      "Missing required environment: BASE_SHA GH_TOKEN HEAD_REPO HEAD_SHA PR_NUMBER REPO",
    );
  }
  return { BASE_SHA, GH_TOKEN, HEAD_REPO, HEAD_SHA, PR_NUMBER, REPO };
}

async function main(): Promise<void> {
  const env = readEnv();
  const client = createPrBlobClient({ token: env.GH_TOKEN });
  const result = await runTestSizeBudget(client, env);
  if (!result.ok) {
    console.error("FAIL: test size budget policy would be weakened or exceeded.");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log(
    `PASS: test size budget policy is monotonic and ${result.changedTestCount} changed test file(s) are within budget.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
