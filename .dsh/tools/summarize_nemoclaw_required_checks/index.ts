// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw",
  limit = input.limit ?? 100,
  base = input.base ?? "main";
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
  !Number.isSafeInteger(input.number) ||
  input.number <= 0 ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 100 ||
  !/^[\w./-]+$/.test(base)
)
  throw new Error("Invalid input");
const a = await tools.bash({
    command: "gh api repos/" + repo + "/branches/" + base + "/protection/required_status_checks",
    workdir: input.workdir,
    description: "Read required pull request checks",
  }),
  b = await tools.bash({
    command: "gh pr checks " + input.number + " --repo " + repo + " --json name,state,bucket,link",
    workdir: input.workdir,
    description: "Read pull request check states",
  });
if (a.kind !== "foreground" || b.kind !== "foreground" || ![0, 8].includes(b.exitCode))
  throw new Error("Could not read checks");
const cfg = a.exitCode === 0 ? JSON.parse(a.stdout.text) : { contexts: [], checks: [] },
  all = JSON.parse(b.stdout.text || "[]"),
  names = [...new Set([...(cfg.contexts ?? []), ...(cfg.checks ?? []).map((c) => c.context)])],
  items = names
    .slice(0, limit)
    .map((name) => ({ name, matches: all.filter((c) => c.name === name) }));
return {
  repo,
  kind: "required-checks",
  truncated: names.length > limit,
  items,
  summary: {
    number: input.number,
    base,
    configured: names.length,
    protectionReadable: a.exitCode === 0,
  },
};
