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
  !/^[0-9a-f]{40}$/.test(input.expectedHeadSha)
)
  throw new Error("workdir and expectedHeadSha are required");
const run = async (command, description, allow = false) => {
  const r = await tools.bash({ command, workdir: input.workdir, description, timeoutMs: 120000 });
  if (r.kind !== "foreground") throw new Error(description + " did not finish");
  if (r.exitCode !== 0 && !allow) throw new Error(r.stderr.text || description + " failed");
  return r;
};
const head = (
  await run("git rev-parse HEAD", "Resolve publication candidate commit")
).stdout.text.trim();
if (head !== input.expectedHeadSha) throw new Error("Local commit does not match expectedHeadSha");
const status = (
  await run("git status --porcelain=v1", "Check publication candidate cleanliness")
).stdout.text
  .split(/\r?\n/)
  .filter(Boolean)
  .join("\n");
if (status) throw new Error("Publication candidate has uncommitted changes");
const branch = (
  await run("git branch --show-current", "Read publication branch")
).stdout.text.trim();
if (!branch || branch === baseBranch) throw new Error("Publication requires a feature branch");
const existing = await run(
  "gh pr list --repo " +
    q(repo) +
    " --head " +
    q(branch) +
    " --state open --json number,url --limit 2",
  "Check existing pull request",
  true,
);
if (existing.exitCode !== 0)
  throw new Error("GitHub pull request lookup failed; stop and restore access");
const prs = JSON.parse(existing.stdout.text || "[]");
if (prs.length) throw new Error("An open pull request already exists for this branch");
const commits = (
  await run(
    "git rev-list --reverse " + q(remote + "/" + baseBranch + "..HEAD"),
    "List publication commits",
  )
).stdout.text
  .split(/\r?\n/)
  .filter(Boolean);
if (!commits.length) throw new Error("No commits are ahead of the trusted base");
if (input.apply !== true)
  return {
    apply: false,
    mutated: false,
    pushed: false,
    repository: repo,
    remote,
    baseBranch,
    branch,
    headSha: head,
    commits: commits.map((sha) => ({
      sha,
      verified: false,
      reason: "not checked before publication",
    })),
    allVerified: false,
    blocker: null,
  };
await run(
  "git push --set-upstream " + q(remote) + " " + q("HEAD:refs/heads/" + branch),
  "Push pull request candidate branch",
);
const verified = [];
for (const sha of commits) {
  const r = await run(
    "gh api " +
      q("repos/" + repo + "/commits/" + sha) +
      " --jq " +
      q('[.commit.verification.verified, (.commit.verification.reason // "")] | @tsv'),
    "Verify published commit",
    true,
  );
  if (r.exitCode !== 0) throw new Error("GitHub verification read failed; stop and restore access");
  const [ok, reason] = r.stdout.text.trim().split("\t");
  verified.push({ sha, verified: ok === "true", reason: reason || null });
}
const allVerified = verified.every((c) => c.verified);
return {
  apply: true,
  mutated: true,
  pushed: true,
  repository: repo,
  remote,
  baseBranch,
  branch,
  headSha: head,
  commits: verified,
  allVerified,
  blocker: allVerified ? null : "One or more published commits are not verified.",
};
