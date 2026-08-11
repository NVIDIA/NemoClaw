// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Trusted pull-request adapter for codebase growth policies. The workflow runs
// this base-revision code and treats pull-request files and blobs as data only.

import { createPrBlobClient, type PrBlobClient, type PullRequestFile } from "./pr-blob-client.mts";
import { runTestConditionals, type ConditionalEnv } from "./test-conditionals.mts";
import { runTestSizeBudget, type BudgetEnv } from "./test-size-budget.mts";

const JAVASCRIPT_FILE_RE = /\.(?:js|cjs|mjs|jsx)$/;
const ONBOARD_ENTRYPOINT = "src/lib/onboard.ts";

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

export async function runGrowthGuardrails(
  client: PrBlobClient,
  env: GrowthGuardrailEnv,
): Promise<readonly string[]> {
  const files = await client.getPullFiles(env.REPO, env.PR_NUMBER);
  const violations = [...evaluateAddedJavaScriptFiles(files), ...evaluateOnboardGrowth(files)];
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
    console.error("FAIL: codebase growth policies rejected this PR.");
    for (const violation of violations) console.error(`- ${violation}`);
    console.error("Run current-file checks locally: npm run test:changed");
    console.error(
      "The local check validates the current budget file but does not compare its limits with the base commit.",
    );
    process.exit(1);
  }
  console.log("PASS: this PR preserves the codebase growth policies.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
