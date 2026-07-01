// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import { upsertStickyComment } from "../advisors/github.mts";
import { parseArgs, readIfExists, readJsonIfExists } from "../advisors/io.mts";

import type { E2eTargetAdvisorResult, E2eTargetRecommendation } from "./targets.mts";

export const E2E_TARGET_ADVISOR_MARKER = "<!-- nemoclaw-e2e-target-advisor -->";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  const pr = args.pr || process.env.PR_NUMBER;
  const summaryPath = args.summary || "artifacts/e2e-advisor/e2e-target-advisor-summary.md";
  const resultPath = args.result || "artifacts/e2e-advisor/e2e-target-advisor-result.json";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;

  if (!repo || !pr) {
    console.log("Skipping E2E target advisor comment: repo or PR number not provided");
    return;
  }
  if (!token) {
    console.log("Skipping E2E target advisor comment: GITHUB_TOKEN/GH_TOKEN not provided");
    return;
  }

  const summary = readIfExists(summaryPath);
  if (!summary) {
    throw new Error(`No target advisor summary found at ${summaryPath}`);
  }

  const result = readJsonIfExists<E2eTargetAdvisorResult>(resultPath);
  const body = buildTargetComment({ summary, result, runUrl });

  await upsertStickyComment({
    repo,
    pr,
    token,
    marker: E2E_TARGET_ADVISOR_MARKER,
    body,
    label: "E2E target advisor",
    userAgent: "nemoclaw-e2e-target-advisor",
  });
}

export function buildTargetComment({
  summary,
  result,
  runUrl,
  marker = E2E_TARGET_ADVISOR_MARKER,
}: {
  summary: string;
  result?: E2eTargetAdvisorResult;
  runUrl?: string;
  marker?: string;
}): string {
  const required = Array.isArray(result?.required) ? result.required : [];
  const optional = Array.isArray(result?.optional) ? result.optional : [];
  const requiredLine = recommendationLine(required);
  const optionalLine = recommendationLine(optional);
  const dispatch =
    required.length > 0
      ? `\n\n**Dispatch required E2E targets:**\n${required.map((item) => `- \`${item.dispatchCommand}\``).join("\n")}`
      : "";
  const run = runUrl ? `\n\n[Workflow run](${runUrl})` : "";

  return `${marker}
## E2E Target Recommendation

**Required E2E targets:** ${requiredLine}
**Optional E2E targets:** ${optionalLine}${dispatch}${run}

<details>
<summary>Full E2E target advisor summary</summary>

${summary.trim()}

</details>
`;
}

function recommendationLine(recommendations: E2eTargetRecommendation[]): string {
  return recommendations.length > 0
    ? recommendations.map((item) => `\`${item.id}\``).join(", ")
    : "_None_";
}
