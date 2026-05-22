// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import { upsertStickyComment } from "../advisors/github.mts";
import { parseArgs, readIfExists, readJsonIfExists } from "../advisors/io.mts";

import type {
  ScenarioAdvisorResult,
  ScenarioRecommendation,
} from "./scenarios.mts";

export const SCENARIO_ADVISOR_MARKER = "<!-- nemoclaw-e2e-scenario-advisor -->";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  const pr = args.pr || process.env.PR_NUMBER;
  const summaryPath =
    args.summary || "artifacts/e2e-advisor/e2e-scenario-advisor-summary.md";
  const resultPath =
    args.result || "artifacts/e2e-advisor/e2e-scenario-advisor-result.json";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const runUrl =
    process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  if (!repo || !pr) {
    console.log(
      "Skipping E2E scenario advisor comment: repo or PR number not provided",
    );
    return;
  }
  if (!token) {
    console.log(
      "Skipping E2E scenario advisor comment: GITHUB_TOKEN/GH_TOKEN not provided",
    );
    return;
  }

  const summary = readIfExists(summaryPath);
  if (!summary) {
    throw new Error(`No scenario advisor summary found at ${summaryPath}`);
  }

  const result = readJsonIfExists<ScenarioAdvisorResult>(resultPath);
  const body = buildScenarioComment({ summary, result, runUrl });

  await upsertStickyComment({
    repo,
    pr,
    token,
    marker: SCENARIO_ADVISOR_MARKER,
    body,
    label: "E2E scenario advisor",
    userAgent: "nemoclaw-e2e-scenario-advisor",
  });
}

export function buildScenarioComment({
  summary,
  result,
  runUrl,
  marker = SCENARIO_ADVISOR_MARKER,
}: {
  summary: string;
  result?: ScenarioAdvisorResult;
  runUrl?: string;
  marker?: string;
}): string {
  const required = Array.isArray(result?.required) ? result.required : [];
  const optional = Array.isArray(result?.optional) ? result.optional : [];
  const requiredLine = recommendationLine(required);
  const optionalLine = recommendationLine(optional);
  const dispatch =
    required.length > 0
      ? `\n\n**Dispatch required scenario E2E:**\n${required.map((item) => `- \`${item.dispatchCommand}\``).join("\n")}`
      : "";
  const run = runUrl ? `\n\n[Workflow run](${runUrl})` : "";

  return `${marker}
## E2E Scenario Advisor Recommendation

**Required scenario E2E:** ${requiredLine}
**Optional scenario E2E:** ${optionalLine}${dispatch}${run}

<details>
<summary>Full scenario advisor summary</summary>

${summary.trim()}

</details>
`;
}

function recommendationLine(recommendations: ScenarioRecommendation[]): string {
  return recommendations.length > 0
    ? recommendations.map((item) => `\`${item.id}\``).join(", ")
    : "_None_";
}
