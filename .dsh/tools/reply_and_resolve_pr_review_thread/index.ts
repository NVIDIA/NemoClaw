// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const q = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
  throw new Error("repo must be owner/name and contain 200 or fewer characters");
if (!Number.isSafeInteger(input.number) || input.number <= 0)
  throw new Error("number must be a positive integer");
if (!Number.isSafeInteger(input.commentId) || input.commentId <= 0)
  throw new Error("commentId must be a positive integer");
if (typeof input.body !== "string" || !input.body.trim()) throw new Error("reply body is required");
if (input.body.length > 65536) throw new Error("reply body must contain 65536 or fewer characters");
if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
  throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
const [owner, name] = repo.split("/");
const accessPattern =
  /authentication|authorization|forbidden|permission|resource not accessible|HTTP 40[13]/iu;
const run = async (args, operation) => {
  const result = await tools.bash({
    command: "gh " + args.map(q).join(" "),
    workdir: input.workdir,
    description: operation,
    timeoutMs: 30000,
  });
  if (result.kind === "foreground" && result.exitCode === 0) return result.stdout.text;
  const detail =
    result.kind === "foreground"
      ? (result.stdout.text + "\n" + result.stderr.text).trim()
      : "command did not finish in the foreground";
  if (accessPattern.test(detail))
    throw new Error(
      "GitHub access failed while " +
        operation.toLowerCase() +
        "; stop and restore repository access before continuing.\n" +
        detail,
    );
  throw new Error("GitHub did not complete " + operation.toLowerCase() + ".\n" + detail);
};
const requireExpectedCommit = async () => {
  const pr = JSON.parse(
    await run(
      ["pr", "view", String(input.number), "--repo", repo, "--json", "number,url,state,headRefOid"],
      "Reading pull request",
    ),
  );
  if (pr.state !== "OPEN")
    throw new Error(
      "PR #" +
        input.number +
        " is " +
        String(pr.state).toLowerCase() +
        "; review thread updates require an open PR",
    );
  if (pr.headRefOid !== input.expectedHeadSha)
    throw new Error(
      "PR #" +
        input.number +
        " commit changed: expected " +
        input.expectedHeadSha +
        ", found " +
        pr.headRefOid,
    );
  return pr;
};
const pr = await requireExpectedCommit();
const query =
  "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50,after:$cursor){nodes{id isResolved comments(first:50){nodes{databaseId} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}";
let cursor = null,
  thread = null,
  pagesRead = 0,
  truncatedComments = false;
for (; pagesRead < 10; pagesRead++) {
  const args = [
    "api",
    "graphql",
    "-f",
    "query=" + query,
    "-F",
    "owner=" + owner,
    "-F",
    "name=" + name,
    "-F",
    "number=" + input.number,
  ];
  if (cursor) args.push("-f", "cursor=" + cursor);
  const connection = JSON.parse(await run(args, "Reading pull request review threads")).data
    ?.repository?.pullRequest?.reviewThreads;
  if (!connection) throw new Error("PR #" + input.number + " review threads were not returned");
  thread = (connection.nodes ?? []).find((candidate) =>
    (candidate.comments.nodes ?? []).some((comment) => comment.databaseId === input.commentId),
  );
  truncatedComments ||= (connection.nodes ?? []).some(
    (candidate) => candidate.comments.pageInfo?.hasNextPage,
  );
  if (thread || !connection.pageInfo?.hasNextPage) break;
  cursor = connection.pageInfo.endCursor;
}
if (!thread)
  throw new Error(
    "Review comment " +
      input.commentId +
      " was not found within " +
      (pagesRead + 1) +
      " bounded thread page(s) for PR #" +
      input.number +
      (truncatedComments ? "; at least one thread has more than 50 comments" : ""),
  );
const base = {
  repo,
  number: input.number,
  prUrl: pr.url ?? "",
  headSha: pr.headRefOid ?? "",
  commentId: input.commentId,
  threadId: thread.id,
  alreadyResolved: Boolean(thread.isResolved),
  pagesRead: pagesRead + 1,
};
if (!input.apply || thread.isResolved)
  return {
    applied: input.apply,
    mutated: false,
    ...base,
    wouldReply: !input.apply && !thread.isResolved,
    wouldResolve: !input.apply && !thread.isResolved,
    replyUrl: null,
    resolved: Boolean(thread.isResolved),
  };
await requireExpectedCommit();
const replyJson = JSON.parse(
  await run(
    [
      "api",
      "--method",
      "POST",
      "repos/" + repo + "/pulls/" + input.number + "/comments/" + input.commentId + "/replies",
      "-f",
      "body=" + input.body,
    ],
    "Replying to pull request review comment",
  ),
);
await requireExpectedCommit();
const mutation =
  "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}";
const resolvedThread = JSON.parse(
  await run(
    ["api", "graphql", "-f", "query=" + mutation, "-f", "threadId=" + thread.id],
    "Resolving pull request review thread",
  ),
).data?.resolveReviewThread?.thread;
if (!resolvedThread?.isResolved)
  throw new Error("GitHub accepted the reply but did not resolve review thread " + thread.id);
return {
  applied: true,
  mutated: true,
  ...base,
  wouldReply: false,
  wouldResolve: false,
  replyUrl: replyJson.html_url ?? null,
  resolved: true,
};
