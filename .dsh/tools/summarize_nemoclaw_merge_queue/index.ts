// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
const limit = Math.max(1, Math.min(100, input.limit ?? 50)),
  base = input.base,
  includeStacked = input.includeStacked ?? true,
  enrichLimit = Math.max(0, Math.min(50, input.enrichLimit ?? 25));
if (base !== undefined && (base.length < 1 || base.length > 255))
  throw new Error("base must contain 1 to 255 characters");
const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const run = async (args, label, allowed = [0]) => {
  const r = await tools.bash({
    command: ["gh", ...args].map(q).join(" "),
    workdir: input.workdir,
    description: label,
    timeoutMs: 60000,
  });
  if (r.kind !== "foreground" || !allowed.includes(r.exitCode)) throw new Error(label + " failed");
  return r.stdout.text;
};
const list = async (search) =>
  JSON.parse(
    await run(
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        String(limit),
        "--search",
        search,
        "--json",
        "number,title,author,url,mergeable,reviewDecision,updatedAt,headRefName,baseRefName",
      ],
      "List merge queue pull requests",
    ),
  ).map((p) => ({
    number: p.number,
    title: p.title ?? "",
    author: p.author?.login ?? null,
    base: p.baseRefName ?? "",
    head: p.headRefName ?? "",
    mergeable: p.mergeable ?? "UNKNOWN",
    reviewDecision: p.reviewDecision || "REVIEW_REQUIRED",
    updatedAt: p.updatedAt ?? "",
    url: p.url ?? "",
  }));
const search = (x) => x.filter(Boolean).join(" "),
  [a, g] = await Promise.all([
    list(search(["review:approved", "status:success", "draft:false", base ? "base:" + base : ""])),
    list(search(["status:success", "draft:false", base ? "base:" + base : ""])),
  ]);
const match = (p) => (base ? p.base === base : includeStacked || p.base === "main"),
  approvedGreen = a.filter(match),
  green = g.filter(match),
  approved = new Set(approvedGreen.map((p) => p.number)),
  reviewQueue = green.filter((p) => !approved.has(p.number)),
  enriched = [];
for (const c of approvedGreen.slice(0, enrichLimit)) {
  try {
    const [detail, checks, threads, comments] = await Promise.all([
      run(["api", "repos/" + repo + "/pulls/" + c.number], "Read pull request merge state"),
      run(
        ["pr", "checks", String(c.number), "--repo", repo, "--json", "name,state,bucket"],
        "Read pull request checks",
        [0, 8],
      ),
      run(
        [
          "api",
          "graphql",
          "-f",
          "owner=" + repo.split("/")[0],
          "-f",
          "repo=" + repo.split("/")[1],
          "-F",
          "number=" + c.number,
          "-f",
          "query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}",
        ],
        "Read pull request review threads",
      ),
      run(
        ["api", "repos/" + repo + "/issues/" + c.number + "/comments?per_page=100"],
        "Read pull request advisor comment",
      ),
    ]);
    const d = JSON.parse(detail),
      cs = JSON.parse(checks || "[]"),
      pr = JSON.parse(threads).data?.repository?.pullRequest,
      body = String(
        [...JSON.parse(comments)]
          .reverse()
          .find((x) => String(x.body ?? "").includes("nemoclaw-pr-review-advisor"))?.body ?? "",
      ),
      head = pr?.headRefOid ?? d.head?.sha ?? "",
      advisorHead = body.match(/head_sha: ([0-9a-f]{40,64})/)?.[1] ?? null,
      failed = cs.filter((x) => x.bucket === "fail").map((x) => x.name ?? "unnamed check"),
      pending = cs.filter((x) => x.bucket === "pending").map((x) => x.name ?? "unnamed check");
    enriched.push({
      ...c,
      headSha: head,
      mergeable:
        d.mergeable === true ? "MERGEABLE" : d.mergeable === false ? "CONFLICTING" : "UNKNOWN",
      mergeableState: d.mergeable_state ?? "unknown",
      checksExitCode: failed.length ? 1 : pending.length ? 8 : 0,
      failedChecks: failed.slice(0, 100),
      pendingChecks: pending.slice(0, 100),
      unresolvedThreadCount: (pr?.reviewThreads?.nodes ?? []).filter((x) => !x.isResolved).length,
      threadsTruncated: Boolean(pr?.reviewThreads?.pageInfo?.hasNextPage),
      advisor: body.match(/recommendation: ([^;\n]+)/)?.[1]?.trim() ?? null,
      advisorCurrent: Boolean(advisorHead && advisorHead === head),
      advisorFindings: body.match(/\*\*Findings:\*\*[^\n]*/)?.[0] ?? null,
    });
  } catch (e) {
    enriched.push({ ...c, enrichmentError: String(e?.message ?? e).slice(0, 1000) });
  }
}
const ids = new Set(enriched.map((p) => p.number)),
  unenriched = approvedGreen
    .filter((p) => !ids.has(p.number))
    .map((p) => ({ ...p, readiness: "not-inspected" })),
  ready = (p) =>
    !p.enrichmentError &&
    p.mergeable === "MERGEABLE" &&
    p.checksExitCode === 0 &&
    p.failedChecks.length === 0 &&
    p.pendingChecks.length === 0 &&
    p.unresolvedThreadCount === 0 &&
    !p.threadsTruncated &&
    p.advisorCurrent &&
    p.advisor === "merge_as_is",
  strictReady = enriched.filter((p) => p.base === "main" && ready(p)),
  directNearMisses = enriched.filter((p) => p.base === "main" && !ready(p)),
  stackedReady = enriched.filter((p) => p.base !== "main" && ready(p)),
  stackedNearMisses = enriched.filter((p) => p.base !== "main" && !ready(p));
return {
  checkedAt: new Date().toISOString(),
  repo,
  filters: { limit, base: base ?? null, includeStacked, enrichLimit },
  counts: {
    approvedGreen: approvedGreen.length,
    enriched: enriched.length,
    unenriched: unenriched.length,
    strictReady: strictReady.length,
    directNearMisses: directNearMisses.length,
    stackedReady: stackedReady.length,
    stackedNearMisses: stackedNearMisses.length,
    reviewQueue: reviewQueue.length,
  },
  strictReady,
  directNearMisses,
  stackedReady,
  stackedNearMisses,
  unenriched,
  reviewQueue: reviewQueue.slice(0, 15),
};
