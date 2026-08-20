// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
  !Number.isSafeInteger(input.number) ||
  input.number <= 0
)
  throw new Error("Invalid pull request");
const s = await tools.collect_pr_feedback({
  repository: repo,
  pullNumber: input.number,
  workdir: input.workdir,
  bodyLimit: 4000,
});
if (
  s.truncation.reviews ||
  s.truncation.inlineComments ||
  (input.includeComments && s.truncation.discussionComments)
)
  throw new Error("Pull request readiness requires a complete bounded feedback snapshot");
const fail = new Set(["FAILURE", "FAIL", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]),
  pending = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
const latest = new Map();
for (const r of s.reviews) latest.set(r.user, { user: r.user, state: r.state });
let context = null;
if (input.includeReviewContext) {
  const r = await tools.bash({
    command:
      "gh pr view " +
      input.number +
      " --repo " +
      repo +
      " --json changedFiles,additions,deletions,body,files,commits",
    workdir: input.workdir,
    description: "Collect bounded pull request review context",
  });
  if (r.kind !== "foreground" || r.exitCode !== 0) throw new Error("Could not collect context");
  const x = JSON.parse(r.stdout.text);
  context = {
    changedFiles: x.changedFiles ?? 0,
    additions: x.additions ?? 0,
    deletions: x.deletions ?? 0,
    body: String(x.body ?? "").slice(0, 12000),
    files: (x.files ?? []).slice(0, 100),
    commits: (x.commits ?? []).slice(-20),
  };
}
const inline = s.inlineComments
  .slice(0, 100)
  .map((c) => ({ user: c.user, path: c.path, line: c.line, body: c.body, url: c.url }));
const discussion = input.includeComments
  ? s.discussionComments.slice(-8).map((c) => ({ user: c.user, body: c.body, url: c.url }))
  : [];
return {
  repo,
  number: input.number,
  pull: {
    url: s.pull.url,
    state: s.pull.state,
    headRefOid: s.pull.headRefOid,
    mergeStateStatus: s.pull.mergeStateStatus,
    reviewDecision: s.pull.reviewDecision,
  },
  failedChecks: s.checks
    .filter((c) => fail.has(c.state.toUpperCase()))
    .slice(0, 100)
    .map((c) => ({ name: c.name, state: c.state, link: c.link })),
  pendingChecks: s.checks
    .filter((c) => pending.has(c.state.toUpperCase()))
    .slice(0, 100)
    .map((c) => c.name),
  latestReviews: [...latest.values()].slice(0, 50),
  unresolvedComments: inline,
  recentComments: discussion,
  context,
};
