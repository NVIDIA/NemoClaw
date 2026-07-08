// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { upsertStickyComment } from "../advisors/github.mts";
import { parseArgs, readIfExists, readJsonIfExists } from "../advisors/io.mts";

type TestRecommendation = {
  id?: string;
};

type AdvisorResult = {
  requiredTests?: TestRecommendation[];
  optionalTests?: TestRecommendation[];
  dispatchHint?: {
    jobsInput?: string;
  };
};

const args = parseArgs(process.argv.slice(2));
const repo = args.repo || process.env.GITHUB_REPOSITORY;
const pr = args.pr || process.env.PR_NUMBER;
const summaryPath = args.summary || "artifacts/e2e-advisor/e2e-advisor-summary.md";
const resultPath = args.result || "artifacts/e2e-advisor/e2e-advisor-final-result.json";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
const marker = "<!-- nemoclaw-e2e-advisor -->";

if (!repo || !pr) {
  console.log("Skipping E2E advisor comment: repo or PR number not provided");
  process.exit(0);
}
if (!token) {
  console.log("Skipping E2E advisor comment: GITHUB_TOKEN/GH_TOKEN not provided");
  process.exit(0);
}

const summary =
  readIfExists(summaryPath) || readIfExists("artifacts/e2e-advisor/e2e-advisor-summary.md");
if (!summary) {
  throw new Error(`No advisor summary found at ${summaryPath}`);
}

const result = readJsonIfExists<AdvisorResult>(resultPath);
const body = buildComment({ summary, result, runUrl, marker });

await upsertStickyComment({
  repo,
  pr,
  token,
  marker,
  body,
  label: "E2E advisor",
  userAgent: "nemoclaw-e2e-advisor",
});

function buildComment({
  summary,
  result,
  runUrl,
  marker,
}: {
  summary: string;
  result?: AdvisorResult;
  runUrl?: string;
  marker: string;
}): string {
  const requiredTests = Array.isArray(result?.requiredTests) ? result.requiredTests : [];
  const optionalTests = Array.isArray(result?.optionalTests) ? result.optionalTests : [];
  const requiredLine =
    requiredTests.length > 0 ? requiredTests.map((test) => `\`${test.id}\``).join(", ") : "_None_";
  const optionalLine =
    optionalTests.length > 0 ? optionalTests.map((test) => `\`${test.id}\``).join(", ") : "_None_";
  const dispatchHint = result?.dispatchHint?.jobsInput
    ? `\n\n**Dispatch hint:** \`${result.dispatchHint.jobsInput}\``
    : "";
  const run = runUrl ? `\n\n[Workflow run](${runUrl})` : "";

  return `${marker}
## E2E Advisor Recommendation

**Required E2E:** ${requiredLine}
**Optional E2E:** ${optionalLine}${dispatchHint}${run}

<details>
<summary>Full advisor summary</summary>

${summary.trim()}

</details>
`;
}
