// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200)
  throw new Error("repo must be owner/name and contain 200 or fewer characters");
if (!Number.isSafeInteger(input.number) || input.number <= 0)
  throw new Error("number must be a positive integer");
if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
  throw new Error("expectedHeadSha must be a complete lowercase commit SHA");
if (!/^[A-Za-z0-9._/-]+$/.test(input.expectedBaseRef) || input.expectedBaseRef.length > 255)
  throw new Error("expectedBaseRef contains an unsupported branch name");
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const accessPattern =
  /authentication|authorization|forbidden|permission|resource not accessible|HTTP 40[13]|SSO/iu;
const run = async (args, description, accepted = [0]) => {
  const result = await tools.bash({
    command: "gh " + args.map(quote).join(" "),
    workdir: input.workdir,
    description,
    timeoutMs: 120000,
  });
  if (result.kind !== "foreground")
    throw new Error(description + " did not finish in the foreground");
  const detail = (result.stdout.text + "\n" + result.stderr.text).trim();
  if (accepted.includes(result.exitCode ?? -1))
    return { ok: true, text: result.stdout.text, detail, code: result.exitCode ?? -1 };
  if (accessPattern.test(detail))
    throw new Error(
      "GitHub access failed while " +
        description.toLowerCase() +
        "; stop and restore repository access before continuing.\n" +
        detail,
    );
  return { ok: false, text: result.stdout.text, detail, code: result.exitCode ?? -1 };
};
const readPr = async () => {
  const result = await run(
    [
      "pr",
      "view",
      String(input.number),
      "--repo",
      repo,
      "--json",
      "number,url,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,mergedAt,mergeCommit",
    ],
    "Read pull request merge status",
  );
  if (!result.ok)
    throw new Error("GitHub did not return pull request merge status.\n" + result.detail);
  return JSON.parse(result.text);
};
const [owner, name] = repo.split("/");
const readThreads = async () => {
  const query =
    "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}";
  let cursor = null,
    pages = 0,
    unresolved = 0,
    total = 0;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      "owner=" + owner,
      "-f",
      "name=" + name,
      "-F",
      "number=" + input.number,
      "-f",
      "query=" + query,
    ];
    if (cursor) args.push("-f", "cursor=" + cursor);
    const result = await run(args, "Read pull request review threads");
    if (!result.ok)
      throw new Error("GitHub did not return pull request review threads.\n" + result.detail);
    const connection = JSON.parse(result.text).data?.repository?.pullRequest?.reviewThreads;
    if (!connection)
      throw new Error("GitHub returned no review thread connection for PR #" + input.number);
    pages++;
    total += connection.nodes.length;
    unresolved += connection.nodes.filter((thread) => !thread.isResolved).length;
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    if (pages > 100) throw new Error("Pull request review threads exceeded 100 pages");
  } while (cursor);
  return { pages, total, unresolved, complete: true };
};
const pr = await readPr();
const observedHeadSha = pr.headRefOid ?? null,
  observedBaseRef = pr.baseRefName ?? null;
const [baseResult, rulesResult, checksResult, threads] = await Promise.all([
  run(["api", "repos/" + repo], "Read repository merge settings"),
  run(
    ["api", "repos/" + repo + "/rules/branches/" + encodeURIComponent(input.expectedBaseRef)],
    "Read effective branch rules",
  ),
  run(
    ["pr", "checks", String(input.number), "--repo", repo, "--json", "name,state,bucket,link"],
    "Read pull request checks",
    [0, 8],
  ),
  readThreads(),
]);
if (!baseResult.ok)
  throw new Error("GitHub did not return repository merge settings.\n" + baseResult.detail);
if (!rulesResult.ok)
  throw new Error("GitHub did not return effective branch rules.\n" + rulesResult.detail);
if (!checksResult.ok)
  throw new Error("GitHub did not return pull request checks.\n" + checksResult.detail);
const settings = JSON.parse(baseResult.text),
  rules = JSON.parse(rulesResult.text),
  allChecks = JSON.parse(checksResult.text || "[]");
const requiredNames = [
  ...new Set(
    rules
      .filter((rule) => rule.type === "required_status_checks")
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((entry) => entry.context)
      .filter(Boolean),
  ),
];
const requiredChecks = requiredNames.map((name) => ({
  name,
  matches: allChecks.filter((entry) => entry.name === name),
}));
const blockers = [];
if (pr.state !== "OPEN") blockers.push("PR is not open");
if (pr.isDraft) blockers.push("PR is a draft");
if (observedHeadSha !== input.expectedHeadSha) blockers.push("latest PR commit changed");
if (observedBaseRef !== input.expectedBaseRef) blockers.push("base branch changed");
if (pr.mergeable !== "MERGEABLE") blockers.push("GitHub does not report MERGEABLE");
const methodAllowed =
  input.method === "merge"
    ? settings.allow_merge_commit
    : input.method === "squash"
      ? settings.allow_squash_merge
      : settings.allow_rebase_merge;
if (!methodAllowed) blockers.push("repository does not permit the selected merge method");
const acceptedCheckStates = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
for (const check of requiredChecks) {
  if (check.matches.length === 0) blockers.push("required check is missing: " + check.name);
  else if (
    !check.matches.some(
      (entry) =>
        acceptedCheckStates.has(String(entry.state).toUpperCase()) ||
        ["pass", "skipping"].includes(String(entry.bucket).toLowerCase()),
    )
  )
    blockers.push("required check is not passing: " + check.name);
}
if (pr.reviewDecision !== "APPROVED") blockers.push("GitHub review decision is not APPROVED");
if (threads.unresolved > 0) blockers.push("unresolved review threads remain");
const checks = {
  state: pr.state,
  isDraft: Boolean(pr.isDraft),
  mergeable: pr.mergeable ?? null,
  mergeStateStatus: pr.mergeStateStatus ?? null,
  reviewDecision: pr.reviewDecision ?? "",
  requiredChecks,
  selectedMethodPermitted: Boolean(methodAllowed),
  reviewThreads: threads,
  effectiveRuleCount: rules.length,
};
const base = {
  apply: input.apply,
  mutated: false,
  repo,
  number: input.number,
  url: pr.url ?? null,
  expectedHeadSha: input.expectedHeadSha,
  observedHeadSha,
  expectedBaseRef: input.expectedBaseRef,
  observedBaseRef,
  method: input.method,
  mergeCommit: pr.mergeCommit?.oid ?? null,
  blockers,
  checks,
  detail: null,
};
if (observedHeadSha !== input.expectedHeadSha || observedBaseRef !== input.expectedBaseRef)
  return { ...base, disposition: "stale" };
if (blockers.length) return { ...base, disposition: "blocked" };
if (!input.apply) return { ...base, disposition: "would-merge" };
const flag =
  input.method === "merge" ? "--merge" : input.method === "squash" ? "--squash" : "--rebase";
const mergeResult = await run(
  [
    "pr",
    "merge",
    String(input.number),
    "--repo",
    repo,
    flag,
    "--match-head-commit",
    input.expectedHeadSha,
  ],
  "Merge pull request",
);
let after;
try {
  after = await readPr();
} catch (error) {
  if (accessPattern.test(String(error?.message ?? error))) throw error;
  return {
    ...base,
    disposition: "inconclusive",
    detail: mergeResult.detail || String(error?.message ?? error),
  };
}
const afterHead = after.headRefOid ?? null,
  mergeCommit = after.mergeCommit?.oid ?? null;
if (after.state === "MERGED" || after.mergedAt)
  return {
    ...base,
    mutated: mergeResult.ok,
    observedHeadSha: afterHead,
    observedBaseRef: after.baseRefName ?? null,
    mergeCommit,
    blockers: [],
    disposition: "merged",
    detail: mergeResult.ok ? null : mergeResult.detail,
  };
if (afterHead !== input.expectedHeadSha || after.baseRefName !== input.expectedBaseRef)
  return {
    ...base,
    observedHeadSha: afterHead,
    observedBaseRef: after.baseRefName ?? null,
    disposition: "stale",
    detail: mergeResult.detail || null,
  };
if (!mergeResult.ok) return { ...base, disposition: "not-merged", detail: mergeResult.detail };
return {
  ...base,
  disposition: "inconclusive",
  detail: "GitHub accepted the merge command but the PR remains open at the expected commit",
};
