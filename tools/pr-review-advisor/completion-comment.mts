// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import { upsertStickyComment } from "../advisors/github.mts";
import { parseArgs } from "../advisors/io.mts";

const MARKER = "<!-- nemoclaw-pr-review-advisor -->";

export function buildCompletionComment(
  runUrl: string,
  commitSha: string,
  workflowRunsUrl: string,
  marker = MARKER,
): string {
  const reviewUrl = validateGithubUrl(runUrl, "run");
  const historyUrl = validateGithubUrl(workflowRunsUrl, "workflow runs");
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new Error(
      "PR review advisor commit SHA must contain 40 lowercase hexadecimal characters",
    );
  }
  return `${validateMarker(marker)}
PR review advisory complete for commit \`${commitSha.slice(0, 7)}\`: [read the full review](${reviewUrl.href}). Read it before deciding whether to request changes, approve, or merge this PR.

[All previous runs](${historyUrl.href})
`;
}

function validateGithubUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error(`PR review advisor ${label} URL must be an HTTPS github.com URL`);
  }
  return url;
}

function validateMarker(marker: string): string {
  const value = marker.trim();
  if (!/^<!--\s+nemoclaw-pr-review-advisor(?:-[a-z0-9-]+)?\s+-->$/.test(value)) {
    throw new Error(
      "PR review advisor marker must be a safe nemoclaw-pr-review-advisor HTML comment",
    );
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  const pr = args.pr || process.env.PR_NUMBER;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
  const workflowRunsUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/workflows/pr-review-advisor.yaml`
      : undefined;
  const commitSha = process.env.EXPECTED_HEAD_SHA;
  if (!repo || !pr || !token || !runUrl || !workflowRunsUrl || !commitSha) {
    throw new Error(
      "PR review advisor comment requires repo, PR number, token, commit SHA, and workflow URLs",
    );
  }

  await upsertStickyComment({
    repo,
    pr,
    token,
    marker: args.marker || process.env.PR_REVIEW_ADVISOR_COMMENT_MARKER || MARKER,
    body: buildCompletionComment(
      runUrl,
      commitSha,
      workflowRunsUrl,
      args.marker || process.env.PR_REVIEW_ADVISOR_COMMENT_MARKER || MARKER,
    ),
    label: "PR review advisor",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
