// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
const issues = [...new Set(input.issues ?? [])],
  prs = [...new Set(input.prs ?? [])],
  numbers = [...issues, ...prs];
if (
  numbers.length < 1 ||
  numbers.length > 10 ||
  numbers.some((n) => !Number.isSafeInteger(n) || n <= 0)
)
  throw new Error("Provide 1 to 10 positive issue and pull request numbers");
const pattern =
  input.relevantPattern ??
  "^(#{1,4} )|dependency|depends|sequence|scope|acceptance|blocked|owner|state|agent|runtime|onboard|lifecycle|manifest|file|layout|PR |#[0-9]+";
if (pattern.length < 1 || pattern.length > 500)
  throw new Error("relevantPattern must contain 1 to 500 characters");
let regex;
try {
  regex = new RegExp(pattern, "i");
} catch {
  throw new Error("relevantPattern must be a valid regular expression");
}
const maxBodyMatches = Math.max(1, Math.min(30, input.maxBodyMatches ?? 20)),
  maxComments = Math.max(0, Math.min(5, input.maxComments ?? 3)),
  marker = input.commentMarker ?? "";
if (marker.length > 200) throw new Error("commentMarker must contain at most 200 characters");
const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const view = async (kind, number) => {
  const fields =
    kind === "pr"
      ? "number,title,state,url,headRefOid,headRefName,baseRefName,isDraft,body,comments"
      : "number,title,state,url,body,comments";
  const r = await tools.bash({
    command: ["gh", kind, "view", String(number), "--repo", repo, "--json", fields]
      .map(q)
      .join(" "),
    workdir: input.workdir,
    description: "Read GitHub planning item",
    timeoutMs: 60000,
  });
  if (r.kind !== "foreground" || r.exitCode !== 0)
    throw new Error("Could not read " + kind + " " + number);
  const x = JSON.parse(r.stdout.text);
  return {
    number: x.number,
    title: x.title ?? "",
    state: x.state ?? "",
    url: x.url ?? "",
    kind,
    headRefOid: x.headRefOid ?? null,
    headRefName: x.headRefName ?? null,
    baseRefName: x.baseRefName ?? null,
    isDraft: typeof x.isDraft === "boolean" ? x.isDraft : null,
    relevantBodyLines: String(x.body ?? "")
      .split(/\r?\n/)
      .map((text, i) => ({ line: i + 1, text: text.slice(0, 240) }))
      .filter((v) => regex.test(v.text))
      .slice(0, maxBodyMatches),
    recentComments: (maxComments === 0 ? [] : (x.comments ?? []).slice(-maxComments)).map((c) => ({
      author: c.author?.login ?? null,
      createdAt: c.createdAt ?? "",
      hasMarker: marker !== "" && String(c.body ?? "").includes(marker),
      preview: String(c.body ?? "").slice(0, 240),
    })),
  };
};
const items = await Promise.all([
  ...issues.map((n) => view("issue", n)),
  ...prs.map((n) => view("pr", n)),
]);
return {
  repo,
  count: items.length,
  relevantPattern: pattern,
  limits: { maxBodyMatches, maxComments },
  items,
};
