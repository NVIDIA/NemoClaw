// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw",
  limit = input.limit ?? 20;
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
  !Number.isSafeInteger(input.number) ||
  input.number <= 0 ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 50
)
  throw new Error("Invalid input");
const r = await tools.bash({
  command: "gh pr checks " + input.number + " --repo " + repo + " --json name,state,bucket,link",
  workdir: input.workdir,
  description: "Inspect failed pull request checks",
});
if (r.kind !== "foreground" || ![0, 8].includes(r.exitCode))
  throw new Error("Could not inspect checks");
const all = JSON.parse(r.stdout.text || "[]"),
  failed = all.filter((c) =>
    ["fail", "failure", "cancelled", "timed_out", "action_required"].includes(
      String(c.state).toLowerCase(),
    ),
  );
return {
  repo,
  kind: "failed-checks",
  truncated: failed.length > limit,
  items: failed.slice(0, limit),
  summary: { number: input.number, totalChecks: all.length, failedChecks: failed.length },
};
