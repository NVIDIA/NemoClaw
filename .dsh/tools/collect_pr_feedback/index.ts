// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
  throw new Error("Invalid repository");
if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber <= 0)
  throw new Error("Invalid pull number");
const bodyLimit = input.bodyLimit ?? 2000;
if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 100 || bodyLimit > 10000)
  throw new Error("bodyLimit must be between 100 and 10000");
const repo = input.repository;
const pr = input.pullNumber;
const results = await Promise.all([
  tools.bash({
    command: `gh pr view ${pr} --repo ${repo} --json url,state,headRefOid,baseRefOid,mergeStateStatus,reviewDecision`,
    workdir: input.workdir,
    description: "Collect pull request status snapshot",
  }),
  tools.bash({
    command: `gh pr checks ${pr} --repo ${repo} --json name,state,bucket,link`,
    workdir: input.workdir,
    description: "Collect pull request check snapshot",
  }),
  tools.bash({
    command: `gh api --paginate /repos/${repo}/pulls/${pr}/reviews --jq '.[] | {id,user:(.user.login // ""),state:(.state // ""),commitId:(.commit_id // ""),body:((.body // "")[0:${bodyLimit}])}'`,
    workdir: input.workdir,
    description: "Collect submitted pull request reviews",
  }),
  tools.bash({
    command: `gh api --paginate /repos/${repo}/pulls/${pr}/comments --jq '.[] | {id,user:(.user.login // ""),path:(.path // ""),line:(if (.line|type)=="number" then .line else null end),body:((.body // "")[0:${bodyLimit}]),url:(.html_url // "")}'`,
    workdir: input.workdir,
    description: "Collect inline pull request comments",
  }),
  tools.bash({
    command: `gh api --paginate /repos/${repo}/issues/${pr}/comments --jq '.[] | {id,user:(.user.login // ""),body:((.body // "")[0:${bodyLimit}]),url:(.html_url // "")}'`,
    workdir: input.workdir,
    description: "Collect pull request discussion comments",
  }),
]);
const [pullResult, checksResult, reviewsResult, inlineResult, discussionResult] = results;
const foreground = (result, label, allowed) => {
  if (result.kind !== "foreground" || !allowed.includes(result.exitCode))
    throw new Error(`${label} failed`);
  if (result.stdout.truncated) throw new Error(`${label} exceeded bounded output`);
  return result.stdout.text.trim();
};
const parseDocument = (text, fallback) => (text ? JSON.parse(text) : fallback);
const parseLines = (text) =>
  text
    ? text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const pull = parseDocument(foreground(pullResult, "PR status collection", [0]), {});
const checks = parseDocument(foreground(checksResult, "PR checks collection", [0, 8]), []);
const reviews = parseLines(foreground(reviewsResult, "PR reviews collection", [0]));
const inline = parseLines(foreground(inlineResult, "inline comments collection", [0]));
const discussion = parseLines(foreground(discussionResult, "discussion comments collection", [0]));
return {
  pull: {
    url: pull.url ?? "",
    state: pull.state ?? "",
    headRefOid: pull.headRefOid ?? "",
    baseRefOid: pull.baseRefOid ?? "",
    mergeStateStatus: pull.mergeStateStatus ?? "",
    reviewDecision: pull.reviewDecision ?? "",
  },
  checks: checks.map((item) => ({
    name: item.name ?? "",
    state: item.state ?? "",
    bucket: item.bucket ?? "",
    link: item.link ?? "",
  })),
  reviews,
  inlineComments: inline,
  discussionComments: discussion,
};
