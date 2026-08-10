// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Trusted pull-request adapter for the codebase growth policies. This file runs
// from the base checkout and treats pull-request files and blobs as data only.

import {
  CODEBASE_GROWTH_BUDGET_FILE,
  evaluateCodebaseBudgetMonotonicity,
  ONBOARD_ENTRYPOINT,
  parseCodebaseGrowthBudget,
} from "./codebase-contract.mts";
import { createPrBlobClient, type PrBlobClient, type PullRequestFile } from "./pr-blob-client.mts";
import { runTestConditionals, type ConditionalEnv } from "./test-conditionals.mts";
import { runTestSizeBudget, type BudgetEnv } from "./test-size-budget.mts";

const JAVASCRIPT_FILE_RE = /\.(?:js|cjs|mjs)$/;

export type GrowthGuardrailEnv = ConditionalEnv & BudgetEnv & { readonly GH_TOKEN: string };

export function evaluateAddedJavaScriptFiles(files: readonly PullRequestFile[]): string[] {
  return files
    .filter(
      ({ filename, previous_filename, status }) =>
        JAVASCRIPT_FILE_RE.test(filename) &&
        (status === "added" ||
          (status === "renamed" && !JAVASCRIPT_FILE_RE.test(previous_filename ?? ""))),
    )
    .map(({ filename }) => `${filename}: new JavaScript files must use TypeScript`);
}

export function evaluateOnboardGrowth(files: readonly PullRequestFile[]): string[] {
  const rows = files.filter(
    ({ filename, previous_filename }) =>
      filename === ONBOARD_ENTRYPOINT || previous_filename === ONBOARD_ENTRYPOINT,
  );
  const additions = rows.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = rows.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const net = additions - deletions;
  return net > 0
    ? [`${ONBOARD_ENTRYPOINT}: grew by ${net} line(s) (+${additions}/-${deletions})`]
    : [];
}

async function evaluateBudgetChange(
  client: PrBlobClient,
  env: GrowthGuardrailEnv,
  files: readonly PullRequestFile[],
): Promise<string[]> {
  const budgetChanged = files.some(
    ({ filename, previous_filename }) =>
      filename === CODEBASE_GROWTH_BUDGET_FILE || previous_filename === CODEBASE_GROWTH_BUDGET_FILE,
  );
  const budgetAdded = files.some(
    ({ filename, status }) => filename === CODEBASE_GROWTH_BUDGET_FILE && status === "added",
  );
  const baseBlobs = await client.fetchBlobs(env.REPO, env.BASE_SHA, [CODEBASE_GROWTH_BUDGET_FILE]);
  const baseText = baseBlobs.get(CODEBASE_GROWTH_BUDGET_FILE);
  if (!budgetChanged) {
    if (baseText == null)
      throw new Error(`${CODEBASE_GROWTH_BUDGET_FILE} is missing at the base revision`);
    return [];
  }
  const headBlobs = await client.fetchBlobs(env.HEAD_REPO, env.HEAD_SHA, [
    CODEBASE_GROWTH_BUDGET_FILE,
  ]);
  const headText = headBlobs.get(CODEBASE_GROWTH_BUDGET_FILE);
  if (headText == null)
    throw new Error(`${CODEBASE_GROWTH_BUDGET_FILE} must remain present at the latest PR commit`);
  const headBudget = parseCodebaseGrowthBudget(headText, "latest PR commit codebase growth budget");
  if (baseText == null) {
    if (!budgetAdded)
      throw new Error(`${CODEBASE_GROWTH_BUDGET_FILE} is missing at the base revision`);
    return [];
  }
  const baseBudget = parseCodebaseGrowthBudget(baseText, "base codebase growth budget");
  const renames = new Map<string, string>();
  for (const { filename, previous_filename } of files) {
    if (previous_filename && previous_filename !== filename)
      renames.set(filename, previous_filename);
  }
  return evaluateCodebaseBudgetMonotonicity(baseBudget, headBudget, renames);
}

export async function runGrowthGuardrails(
  client: PrBlobClient,
  env: GrowthGuardrailEnv,
): Promise<readonly string[]> {
  const files = await client.getPullFiles(env.REPO, env.PR_NUMBER);
  const violations = [
    ...evaluateAddedJavaScriptFiles(files),
    ...evaluateOnboardGrowth(files),
    ...(await evaluateBudgetChange(client, env, files)),
  ];
  const size = await runTestSizeBudget(client, env, files);
  violations.push(...size.violations);
  const conditionals = await runTestConditionals(client, env, files);
  violations.push(...conditionals.details);
  return violations;
}

function readEnv(): GrowthGuardrailEnv {
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
  const violations = await runGrowthGuardrails(client, env);
  if (violations.length > 0) {
    console.error("FAIL: codebase growth contract rejected this PR.");
    for (const violation of violations) console.error(`- ${violation}`);
    console.error(
      "Run affected tests and the local codebase growth contract test: npm run test:changed",
    );
    console.error("The trusted PR check also compares the base and latest PR commits.");
    process.exit(1);
  }
  console.log("PASS: this PR preserves the codebase growth contract.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
