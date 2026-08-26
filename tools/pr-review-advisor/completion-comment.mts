// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";

import { githubApi, githubRest, type GitHubComment } from "../advisors/github.mts";
import { parseArgs } from "../advisors/io.mts";

const MARKER = "<!-- nemoclaw-pr-review-advisor -->";

type LivePull = { head?: { sha?: string } };
type PublicationDependencies = {
  readPull?: (apiPath: string, token: string) => Promise<LivePull>;
  createComment?: (apiPath: string, token: string, body: string) => Promise<GitHubComment>;
  deleteComment?: (apiPath: string, token: string) => Promise<void>;
  listComments?: (apiPath: string, token: string) => Promise<GitHubComment[]>;
};

export async function assertLatestPullCommit(
  repo: string,
  pr: string,
  expectedHeadSha: string,
  token: string,
  readPull: (apiPath: string, token: string) => Promise<LivePull> = githubRest,
): Promise<void> {
  const pull = await readPull(`repos/${repo}/pulls/${pr}`, token);
  if (pull.head?.sha !== expectedHeadSha) {
    throw new Error(
      `PR review advisor will not publish stale commit ${expectedHeadSha}; latest PR commit is ${pull.head?.sha ?? "unavailable"}`,
    );
  }
}

export async function publishCompletionComment(
  options: {
    repo: string;
    pr: string;
    token: string;
    commitSha: string;
    body: string;
    marker?: string;
  },
  dependencies: PublicationDependencies = {},
): Promise<void> {
  const marker = validateMarker(options.marker ?? MARKER);
  const readPull = dependencies.readPull ?? githubRest;
  const createComment =
    dependencies.createComment ??
    ((apiPath, token, body) =>
      githubApi<GitHubComment>(apiPath, token, { method: "POST", body: { body } }));
  const deleteComment =
    dependencies.deleteComment ??
    ((apiPath, token) => githubApi<void>(apiPath, token, { method: "DELETE" }));
  const listComments =
    dependencies.listComments ?? ((apiPath, token) => githubApi<GitHubComment[]>(apiPath, token));

  await assertLatestPullCommit(
    options.repo,
    options.pr,
    options.commitSha,
    options.token,
    readPull,
  );
  const comments = await listComments(
    `repos/${options.repo}/issues/${options.pr}/comments?per_page=100`,
    options.token,
  );
  const stale = comments.filter(
    (comment) =>
      comment.user?.login === "github-actions[bot]" && firstCommentLine(comment.body) === marker,
  );
  for (const comment of stale) {
    await deleteComment(`repos/${options.repo}/issues/comments/${comment.id}`, options.token);
  }

  const created = await createComment(
    `repos/${options.repo}/issues/${options.pr}/comments`,
    options.token,
    options.body,
  );
  if (!Number.isSafeInteger(created.id) || created.id <= 0) {
    throw new Error("PR review advisor comment creation returned an invalid comment ID");
  }

  try {
    await assertLatestPullCommit(
      options.repo,
      options.pr,
      options.commitSha,
      options.token,
      readPull,
    );
  } catch (error) {
    await deleteComment(`repos/${options.repo}/issues/comments/${created.id}`, options.token);
    throw error;
  }
}

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

function firstCommentLine(body: string | undefined): string {
  return body?.trimStart().split(/\r?\n/u, 1)[0]?.trim() ?? "";
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
  const marker = args.marker || process.env.PR_REVIEW_ADVISOR_COMMENT_MARKER || MARKER;
  await publishCompletionComment({
    repo,
    pr,
    token,
    commitSha,
    marker,
    body: buildCompletionComment(runUrl, commitSha, workflowRunsUrl, marker),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
