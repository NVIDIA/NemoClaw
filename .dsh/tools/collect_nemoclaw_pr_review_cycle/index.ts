// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw",
  limit = input.limit ?? 100;
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
  !Number.isSafeInteger(input.number) ||
  input.number <= 0 ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 100
)
  throw new Error("Invalid input");
const s = await tools.collect_pr_feedback({
  repository: repo,
  pullNumber: input.number,
  workdir: input.workdir,
  bodyLimit: 2000,
});
const items = [
  ...s.reviews.slice(0, limit).map((x) => ({ type: "review", ...x })),
  ...s.inlineComments.slice(0, limit).map((x) => ({ type: "inline-comment", ...x })),
  ...s.discussionComments.slice(0, limit).map((x) => ({ type: "discussion-comment", ...x })),
];
return {
  repo,
  kind: "review-cycle",
  truncated:
    s.reviews.length > limit ||
    s.inlineComments.length > limit ||
    s.discussionComments.length > limit,
  items,
  summary: { number: input.number, pull: s.pull, checks: s.checks.slice(0, limit) },
};
