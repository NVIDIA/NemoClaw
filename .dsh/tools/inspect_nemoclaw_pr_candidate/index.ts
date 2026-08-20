// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const repo = input.repository ?? "NVIDIA/NemoClaw",
  remote = input.remote ?? "origin",
  baseBranch = input.baseBranch ?? "main";
if (
  typeof input.workdir !== "string" ||
  !input.workdir.trim() ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
)
  throw new Error("Invalid candidate input");
const run = async (command, description, allow = false) => {
  const r = await tools.bash({ command, workdir: input.workdir, description, timeoutMs: 60000 });
  if (r.kind !== "foreground") throw new Error(description + " did not finish");
  if (r.exitCode !== 0 && !allow) throw new Error(r.stderr.text || description + " failed");
  return r;
};
if (input.refreshBase !== false)
  await run(
    "git fetch --prune " + q(remote) + " " + q(baseBranch),
    "Refresh trusted pull request base",
  );
const branch = (await run("git branch --show-current", "Read candidate branch")).stdout.text.trim(),
  headSha = (await run("git rev-parse HEAD", "Read candidate commit")).stdout.text.trim(),
  baseSha = (
    await run("git rev-parse " + q(remote + "/" + baseBranch), "Read trusted base commit")
  ).stdout.text.trim(),
  statusEntries = (await run("git status --porcelain=v1", "Read candidate worktree")).stdout.text
    .split(/\r?\n/)
    .filter(Boolean),
  range = remote + "/" + baseBranch + "..HEAD";
const log = (
    await run(
      "git log --reverse --format=" + q("%H%x09%s") + " " + q(range),
      "Read candidate commits",
    )
  ).stdout.text
    .split(/\r?\n/)
    .filter(Boolean),
  commits = [];
for (const row of log) {
  const [sha, subject] = row.split("\t");
  const vr = await run(
    "gh api " +
      q("repos/" + repo + "/commits/" + sha) +
      " --jq " +
      q('[.commit.verification.verified, (.commit.verification.reason // "")] | @tsv'),
    "Read GitHub commit verification",
    true,
  );
  let githubVerification = "not-pushed",
    verificationReason = null;
  if (vr.exitCode === 0) {
    const [ok, reason] = vr.stdout.text.trim().split("\t");
    githubVerification = ok === "true" ? "verified" : "unverified";
    verificationReason = reason || null;
  } else if (!/404|Not Found|422|No commit found for SHA/i.test(vr.stderr.text + vr.stdout.text))
    throw new Error("GitHub verification read failed; stop and restore access");
  commits.push({ sha, subject, githubVerification, verificationReason });
}
const changedFiles = (
  await run(
    "git diff --name-only " + q(remote + "/" + baseBranch + "...HEAD"),
    "List candidate files",
  )
).stdout.text
  .split(/\r?\n/)
  .filter(Boolean);
const name = (await run("git config user.name", "Read contributor name", true)).stdout.text.trim(),
  email = (await run("git config user.email", "Read contributor email", true)).stdout.text.trim(),
  permission = (
    await run(
      "gh repo view " + q(repo) + " --json viewerPermission --jq .viewerPermission",
      "Read repository permission",
    )
  ).stdout.text.trim();
const existing = JSON.parse(
  (
    await run(
      "gh pr list --repo " +
        q(repo) +
        " --head " +
        q(branch) +
        " --state open --json number,url,state --limit 2",
      "Find existing pull request",
    )
  ).stdout.text || "[]",
);
const docs = changedFiles.filter((f) => /^(docs|fern)\//.test(f)),
  codeFiles = changedFiles.filter((f) => !/^(docs|fern)\//.test(f)),
  sensitivePaths = changedFiles.filter((f) =>
    /^(src\/lib\/(security|policy|credentials|preflight|onboard|inference|runner|sandbox|messaging)|nemoclaw\/src\/(blueprint|onboard)|nemoclaw-blueprint\/)/.test(
      f,
    ),
  ),
  issues = new Set();
for (const text of [branch, ...commits.map((c) => c.subject)])
  for (const m of text.matchAll(/#([1-9][0-9]*)\b/g)) issues.add(Number(m[1]));
const blockers = [],
  warnings = [];
if (!branch)
  blockers.push({ code: "detached-head", message: "The candidate checkout is detached." });
if (branch === baseBranch)
  blockers.push({ code: "base-branch", message: "The candidate is on the base branch." });
if (statusEntries.length)
  blockers.push({
    code: "dirty-worktree",
    message: "The candidate worktree has uncommitted changes.",
  });
if (!commits.length)
  blockers.push({
    code: "no-commits",
    message: "The candidate has no commits ahead of the trusted base.",
  });
if (!name || !email)
  blockers.push({ code: "missing-identity", message: "Git contributor name or email is missing." });
if (commits.some((c) => c.githubVerification === "unverified"))
  blockers.push({
    code: "unverified-commit",
    message: "GitHub reports one or more commits as unverified.",
  });
if (commits.some((c) => c.githubVerification === "not-pushed"))
  warnings.push({
    code: "verification-pending",
    message: "Push is required before GitHub verification can be checked.",
  });
if (existing.length)
  blockers.push({ code: "existing-pr", message: "An open pull request already uses this branch." });
return {
  repository: repo,
  remote,
  baseBranch,
  baseSha,
  branch,
  headSha,
  clean: statusEntries.length === 0,
  statusEntries,
  commits,
  changedFiles,
  aheadCount: commits.length,
  identity: {
    name,
    email,
    dcoDeclaration: name && email ? "Signed-off-by: " + name + " <" + email + ">" : "",
  },
  permissions: {
    viewerPermission: permission,
    canAssignSelf: ["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(permission),
  },
  existingPullRequest: existing[0] ?? null,
  inferred: {
    issueNumbers: [...issues],
    typeOfChange: codeFiles.length
      ? docs.length
        ? "code-with-docs"
        : "code"
      : docs.length
        ? "docs-prose"
        : "code",
    sensitivePaths,
    dgxStationEvidenceRequired: changedFiles.includes("scripts/prepare-dgx-station-host.sh"),
  },
  blockers,
  warnings,
};
