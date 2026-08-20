// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw",
  limit = input.limit ?? 25;
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
  !Array.isArray(input.numbers) ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 50 ||
  input.numbers.some((n) => !Number.isSafeInteger(n) || n <= 0)
)
  throw new Error("Invalid input");
const nums = [...new Set(input.numbers)].slice(0, limit),
  items = [];
for (const number of nums) {
  const s = await tools.collect_pr_feedback({
    repository: repo,
    pullNumber: number,
    workdir: input.workdir,
    bodyLimit: 500,
  });
  items.push({
    number,
    pull: s.pull,
    failed: s.checks.filter((c) =>
      ["fail", "failure", "cancelled", "timed_out", "action_required"].includes(
        c.state.toLowerCase(),
      ),
    ),
    pending: s.checks.filter((c) =>
      ["pending", "queued", "in_progress", "waiting", "requested"].includes(c.state.toLowerCase()),
    ),
  });
}
return {
  repo,
  kind: "pr-readiness-batch",
  truncated: new Set(input.numbers).size > nums.length,
  items,
  summary: { requested: input.numbers.length, summarized: items.length },
};
