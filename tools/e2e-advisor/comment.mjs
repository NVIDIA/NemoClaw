#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const repo = args.repo || process.env.GITHUB_REPOSITORY;
const pr = args.pr || process.env.PR_NUMBER;
const summaryPath = args.summary || "artifacts/e2e-advisor/e2e-advisor-pi-summary.md";
const resultPath = args.result || "artifacts/e2e-advisor/e2e-advisor-final-result.json";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
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

const summary = readIfExists(summaryPath) || readIfExists("artifacts/e2e-advisor/e2e-advisor-summary.md");
if (!summary) {
  throw new Error(`No advisor summary found at ${summaryPath}`);
}

const result = readJsonIfExists(resultPath);
const body = buildComment({ summary, result, runUrl, marker });

try {
  const existing = await findExistingComment(repo, pr, token, marker);
  if (existing) {
    await github(`repos/${repo}/issues/comments/${existing.id}`, token, {
      method: "PATCH",
      body: { body },
    });
    console.log(`Updated E2E advisor comment on ${repo}#${pr}`);
  } else {
    await github(`repos/${repo}/issues/${pr}/comments`, token, {
      method: "POST",
      body: { body },
    });
    console.log(`Created E2E advisor comment on ${repo}#${pr}`);
  }
} catch (error) {
  if (isPermissionError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Skipping E2E advisor comment due to permission error: ${message}`);
  } else {
    throw error;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      parsed[key] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function readIfExists(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : undefined;
}

function readJsonIfExists(filePath) {
  const text = readIfExists(filePath);
  return text ? JSON.parse(text) : undefined;
}

function buildComment({ summary, result, runUrl, marker }) {
  const requiredTests = Array.isArray(result?.requiredTests) ? result.requiredTests : [];
  const optionalTests = Array.isArray(result?.optionalTests) ? result.optionalTests : [];
  const requiredLine = requiredTests.length > 0
    ? requiredTests.map((test) => `\`${test.id}\``).join(", ")
    : "_None_";
  const optionalLine = optionalTests.length > 0
    ? optionalTests.map((test) => `\`${test.id}\``).join(", ")
    : "_None_";
  const dispatch = result?.dispatchHint?.jobsInput
    ? `\n\n**Dispatch hint:** \`${result.dispatchHint.jobsInput}\``
    : "";
  const run = runUrl ? `\n\n[Workflow run](${runUrl})` : "";

  return `${marker}
## E2E Advisor Recommendation

**Required E2E:** ${requiredLine}
**Optional E2E:** ${optionalLine}${dispatch}${run}

<details>
<summary>Full advisor summary</summary>

${summary.trim()}

</details>
`;
}

async function findExistingComment(repo, pr, token, marker) {
  const comments = await github(`repos/${repo}/issues/${pr}/comments?per_page=100`, token);
  return comments.find((comment) => typeof comment.body === "string" && comment.body.includes(marker));
}

function isPermissionError(error) {
  return error instanceof Error && /\b403\b|Resource not accessible by integration|permission/i.test(error.message);
}

async function github(pathname, token, options = {}) {
  const response = await fetch(`https://api.github.com/${pathname}`, {
    method: options.method || "GET",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nemoclaw-e2e-advisor",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method || "GET"} ${pathname} failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}
