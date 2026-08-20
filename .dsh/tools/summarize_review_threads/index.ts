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
  bodyLimit: 1000,
});
if (s.truncation.inlineComments)
  throw new Error("Review thread summary exceeded the bounded inline comment snapshot");
return {
  repo,
  kind: "review-threads",
  truncated: s.inlineComments.length > limit,
  items: s.inlineComments.slice(0, limit),
  summary: {
    number: input.number,
    total: s.inlineComments.length,
    note: "REST inline comments do not expose GraphQL thread resolution state.",
  },
};
