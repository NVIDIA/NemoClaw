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
if (!["approve", "request-changes", "comment"].includes(input.event))
  throw new Error("event must be approve, request-changes, or comment");
if (typeof input.body !== "string" || !input.body.trim())
  throw new Error("review body is required");
if (input.body.length > 65536)
  throw new Error("review body must contain 65536 or fewer characters");
if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
  throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
const accessPattern =
  /authentication|authorization|forbidden|permission|resource not accessible|HTTP 40[13]/iu;
const run = async (args, description) => {
  const result = await tools.bash({
    command: "gh " + args.map(q).join(" "),
    workdir: input.workdir,
    description,
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
        description.toLowerCase() +
        "; stop and restore repository access before continuing.\n" +
        detail,
    );
  throw new Error("GitHub did not complete " + description.toLowerCase() + ".\n" + detail);
};
const [viewed, viewerText] = await Promise.all([
  run(
    ["pr", "view", String(input.number), "--repo", repo, "--json", "headRefOid,url,title"],
    "Reading pull request",
  ),
  run(["api", "user", "--jq", ".login"], "Reading authenticated GitHub user"),
]);
const pr = JSON.parse(viewed);
const headSha = String(pr.headRefOid ?? "");
const reviewer = viewerText.trim();
if (!/^[0-9a-f]{40}$/.test(headSha))
  throw new Error("PR #" + input.number + " returned an invalid commit SHA");
if (headSha !== input.expectedHeadSha)
  throw new Error(
    "PR #" +
      input.number +
      " commit changed: expected " +
      input.expectedHeadSha +
      ", found " +
      headSha,
  );
if (!input.apply)
  return {
    applied: false,
    mutated: false,
    repo,
    number: input.number,
    title: pr.title ?? "",
    prUrl: pr.url ?? "",
    headSha,
    event: input.event,
    reviewer,
    review: null,
  };
const flag =
  input.event === "approve"
    ? "--approve"
    : input.event === "request-changes"
      ? "--request-changes"
      : "--comment";
await run(
  ["pr", "review", String(input.number), "--repo", repo, flag, "--body", input.body],
  "Submitting pull request review",
);
const [owner, name] = repo.split("/");
const query =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(last:100){nodes{databaseId state submittedAt url commit{oid} author{login}}}}}}";
const reviewText = await run(
  [
    "api",
    "graphql",
    "-f",
    "owner=" + owner,
    "-f",
    "repo=" + name,
    "-F",
    "number=" + input.number,
    "-f",
    "query=" + query,
  ],
  "Reading submitted pull request review",
);
const reviews = JSON.parse(reviewText).data?.repository?.pullRequest?.reviews?.nodes ?? [];
const review = [...reviews]
  .reverse()
  .find((entry) => entry.author?.login === reviewer && entry.commit?.oid === headSha);
if (!review)
  throw new Error(
    "GitHub accepted the review but the last 100 reviews contain no review by " +
      reviewer +
      " for commit " +
      headSha,
  );
return {
  applied: true,
  mutated: true,
  repo,
  number: input.number,
  title: pr.title ?? "",
  prUrl: pr.url ?? "",
  headSha,
  event: input.event,
  reviewer,
  review: {
    id: review.databaseId,
    state: review.state,
    commitId: review.commit.oid,
    submittedAt: review.submittedAt,
    url: review.url,
  },
};
