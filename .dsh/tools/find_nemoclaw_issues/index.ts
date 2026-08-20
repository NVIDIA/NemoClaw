// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
const state = input.state ?? "open";
const limit = Math.max(1, Math.min(500, input.limit ?? 100));
const labels = [...new Set((input.labels ?? []).map((x) => x.trim()).filter(Boolean))];
const search = input.search?.trim() ?? "";
const author = input.author?.trim() ?? "";
const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const args = [
  "issue",
  "list",
  "--repo",
  repo,
  "--state",
  state,
  "--limit",
  String(limit),
  "--json",
  "number,title,url,state,labels,assignees,author,updatedAt",
];
if (search) args.push("--search", search);
if (author) args.push("--author", author);
for (const label of labels) args.push("--label", label);
const result = await tools.bash({
  command: "gh " + args.map(q).join(" "),
  workdir: input.workdir,
  description: "Find matching GitHub issues",
  timeoutMs: 60000,
});
if (result.kind !== "foreground" || result.exitCode !== 0) throw new Error("Could not list issues");
const rows = JSON.parse(result.stdout.text || "[]");
return {
  repo,
  state,
  search: search || null,
  author: author || null,
  labels,
  limit,
  count: rows.length,
  issues: rows.map((row) => ({
    number: row.number,
    title: row.title,
    url: row.url,
    state: row.state,
    labels: (row.labels ?? []).map((x) => x.name),
    assignees: (row.assignees ?? []).map((x) => x.login),
    author: row.author?.login ?? null,
    updatedAt: row.updatedAt,
  })),
};
