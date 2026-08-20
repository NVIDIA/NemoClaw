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
    bodyLimit: 4000,
  }),
  completeness =
    s.truncation.reviews || s.truncation.inlineComments || s.truncation.discussionComments;
if (completeness) throw new Error("Review bot findings exceeded the bounded feedback snapshot");
const bots =
    /^(github-code-quality|github-advanced-security|coderabbitai|github-actions)(\[bot\])?$/i,
  rows = [
    ...s.inlineComments.filter((c) => bots.test(c.user)).map((c) => ({ source: "inline", ...c })),
    ...s.discussionComments
      .filter((c) => c.body.includes("nemoclaw-pr-review-advisor"))
      .map((c) => ({ source: "advisor", ...c })),
  ];
return {
  repo,
  kind: "review-bot-findings",
  truncated: rows.length > limit,
  items: rows.slice(0, limit),
  summary: {
    number: input.number,
    headSha: s.pull.headRefOid,
    total: rows.length,
    note: "Thread resolution and outdated state are not available from the bounded REST snapshot.",
  },
};
