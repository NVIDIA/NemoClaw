// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const q = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
  throw new Error("repo must be owner/name and contain 200 or fewer characters");
if (!Array.isArray(input.items) || input.items.length === 0)
  throw new Error("items must contain at least one review dismissal");
if (input.items.length > 25) throw new Error("items must contain 25 or fewer review dismissals");
const keys = new Set();
for (const item of input.items) {
  if (!Number.isSafeInteger(item.number) || item.number <= 0)
    throw new Error("each PR number must be a positive integer");
  if (!Number.isSafeInteger(item.reviewId) || item.reviewId <= 0)
    throw new Error("each reviewId must be a positive integer");
  if (!/^[0-9a-f]{40}$/.test(item.expectedHeadSha))
    throw new Error("each expectedHeadSha must be a lowercase 40-character commit SHA");
  if (typeof item.message !== "string" || !item.message.trim())
    throw new Error("each dismissal message is required");
  if (item.message.trim().length > 1000)
    throw new Error("each dismissal message must contain 1000 or fewer characters");
  const key = item.number + ":" + item.reviewId;
  if (keys.has(key))
    throw new Error("review " + item.reviewId + " appears more than once for PR #" + item.number);
  keys.add(key);
}
const accessPattern =
  /authentication|authorization|forbidden|permission|resource not accessible|HTTP 40[13]/iu;
const run = async (args, operation) => {
  const result = await tools.bash({
    command: "gh " + args.map(q).join(" "),
    workdir: input.workdir,
    description: operation,
    timeoutMs: 60000,
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
const readItem = async (item) => {
  const [prText, reviewText] = await Promise.all([
    run(
      [
        "api",
        "repos/" + repo + "/pulls/" + item.number,
        "--jq",
        "{number,state,url:.html_url,title,headSha:.head.sha}",
      ],
      "Reading pull request",
    ),
    run(
      [
        "api",
        "repos/" + repo + "/pulls/" + item.number + "/reviews/" + item.reviewId,
        "--jq",
        "{id,state,author:.user.login,submittedAt:.submitted_at,reviewedCommit:.commit_id,url:.html_url}",
      ],
      "Reading pull request review",
    ),
  ]);
  const pr = JSON.parse(prText),
    review = JSON.parse(reviewText);
  if (pr.state !== "open")
    throw new Error(
      "PR #" + item.number + " is " + pr.state + "; review dismissal requires an open PR",
    );
  if (pr.headSha !== item.expectedHeadSha)
    throw new Error(
      "PR #" +
        item.number +
        " commit changed: expected " +
        item.expectedHeadSha +
        ", found " +
        pr.headSha,
    );
  if (review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED")
    throw new Error(
      "Review " +
        item.reviewId +
        " on PR #" +
        item.number +
        " is " +
        review.state +
        "; expected CHANGES_REQUESTED or DISMISSED",
    );
  return { item, pr, review, alreadyDismissed: review.state === "DISMISSED" };
};
const preflight = [];
for (let offset = 0; offset < input.items.length; offset += 8)
  preflight.push(...(await Promise.all(input.items.slice(offset, offset + 8).map(readItem))));
const shape = (entry, action) => ({
  number: entry.item.number,
  reviewId: entry.item.reviewId,
  action,
  prUrl: entry.pr.url ?? "",
  headSha: entry.pr.headSha ?? "",
  reviewUrl: entry.review.url ?? "",
  author: entry.review.author ?? "",
  reviewedCommit: entry.review.reviewedCommit ?? "",
  message: entry.item.message.trim(),
});
if (!input.apply) {
  const reviews = preflight.map((entry) =>
    shape(entry, entry.alreadyDismissed ? "already-dismissed" : "would-dismiss"),
  );
  return {
    applied: false,
    mutated: false,
    repo,
    count: reviews.length,
    dismissed: 0,
    alreadyDismissed: reviews.filter((x) => x.action === "already-dismissed").length,
    reviews,
    reviewDecisions: [],
  };
}
const reviews = [];
for (const original of preflight) {
  const current = await readItem(original.item);
  if (current.alreadyDismissed) {
    reviews.push(shape(current, "already-dismissed"));
    continue;
  }
  const text = await run(
    [
      "api",
      "--method",
      "PUT",
      "repos/" +
        repo +
        "/pulls/" +
        current.item.number +
        "/reviews/" +
        current.item.reviewId +
        "/dismissals",
      "-f",
      "message=" + current.item.message.trim(),
      "--jq",
      "{id,state,author:.user.login,url:.html_url}",
    ],
    "Dismissing pull request review",
  );
  const dismissed = JSON.parse(text);
  if (dismissed.state !== "DISMISSED")
    throw new Error(
      "GitHub returned " +
        dismissed.state +
        " after dismissing review " +
        current.item.reviewId +
        " on PR #" +
        current.item.number,
    );
  current.review = {
    ...current.review,
    state: dismissed.state,
    author: dismissed.author ?? current.review.author,
    url: dismissed.url ?? current.review.url,
  };
  reviews.push(shape(current, "dismissed"));
}
const numbers = [...new Set(input.items.map((item) => item.number))];
const reviewDecisions = await Promise.all(
  numbers.map(async (number) =>
    JSON.parse(
      await run(
        [
          "pr",
          "view",
          String(number),
          "--repo",
          repo,
          "--json",
          "number,url,headRefOid,reviewDecision",
        ],
        "Reading pull request review decision",
      ),
    ),
  ),
);
return {
  applied: true,
  mutated: reviews.some((x) => x.action === "dismissed"),
  repo,
  count: reviews.length,
  dismissed: reviews.filter((x) => x.action === "dismissed").length,
  alreadyDismissed: reviews.filter((x) => x.action === "already-dismissed").length,
  reviews,
  reviewDecisions,
};
