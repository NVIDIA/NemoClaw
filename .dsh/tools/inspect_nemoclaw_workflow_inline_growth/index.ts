// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

if (!Number.isSafeInteger(input.number) || input.number <= 0)
  throw new Error("number must be a positive integer");
const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
const requested = [...new Set(input.files ?? [])];
if (requested.length > 50 || requested.some((p) => !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)))
  throw new Error("files must be workflow YAML paths");
const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const run = async (args, label, optional = false) => {
  const r = await tools.bash({
    command: ["gh", ...args].map(q).join(" "),
    workdir: input.workdir,
    description: label,
    timeoutMs: 60000,
  });
  if (r.kind !== "foreground" || (!optional && r.exitCode !== 0))
    throw new Error(label + " failed");
  return r;
};
const v = await run(
  [
    "pr",
    "view",
    String(input.number),
    "--repo",
    repo,
    "--json",
    "baseRefOid,headRefOid,url,title,files",
  ],
  "Read pull request workflow files",
);
const pr = JSON.parse(v.stdout.text),
  wanted = new Set(requested),
  files = (pr.files ?? [])
    .filter(
      (f) =>
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path) &&
        (wanted.size === 0 || wanted.has(f.path)),
    )
    .slice(0, 50);
const measure = (text) => {
  const lines = text.split(/\r?\n/),
    blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(run|script):\s*[|>][-+0-9]*\s*$/.exec(lines[i]);
    if (!m) continue;
    let n = 0,
      j = i + 1;
    for (; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if ((/^\s*/.exec(lines[j])?.[0].length ?? 0) <= m[1].length) break;
      if (!lines[j].trimStart().startsWith("#")) n++;
    }
    blocks.push({ key: m[2], line: i + 1, executableLines: n });
    i = Math.max(i, j - 1);
  }
  return {
    totalLines: lines.length,
    blockCount: blocks.length,
    executableLines: blocks.reduce((n, b) => n + b.executableLines, 0),
    largestBlock: blocks.slice().sort((a, b) => b.executableLines - a.executableLines)[0] ?? null,
    blocks: blocks.slice(0, 200),
  };
};
const workflows = [];
for (const f of files) {
  const endpoint = "repos/" + repo + "/contents/" + f.path;
  const [b, h] = await Promise.all([
    run(
      ["api", endpoint + "?ref=" + pr.baseRefOid, "-H", "Accept: application/vnd.github.raw+json"],
      "Read base workflow content",
      true,
    ),
    run(
      ["api", endpoint + "?ref=" + pr.headRefOid, "-H", "Accept: application/vnd.github.raw+json"],
      "Read head workflow content",
    ),
  ]);
  const before = b.exitCode === 0 ? measure(b.stdout.text) : measure(""),
    after = measure(h.stdout.text);
  workflows.push({
    path: f.path,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    before,
    after,
    executableLineDelta: after.executableLines - before.executableLines,
    totalLineDelta: after.totalLines - before.totalLines,
  });
}
return {
  repo,
  number: input.number,
  title: pr.title ?? "",
  url: pr.url ?? "",
  baseRefOid: pr.baseRefOid,
  headRefOid: pr.headRefOid,
  workflowCount: workflows.length,
  workflows,
};
