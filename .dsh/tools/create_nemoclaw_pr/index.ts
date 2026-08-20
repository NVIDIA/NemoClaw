// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const repo = input.repo ?? "NVIDIA/NemoClaw",
  remote = input.remote ?? "origin",
  baseBranch = input.baseBranch ?? "main";
if (
  typeof input.workdir !== "string" ||
  !input.workdir.trim() ||
  !/^[0-9a-f]{40}$/.test(input.expectedHeadSha)
)
  throw new Error("workdir and expectedHeadSha are required");
if (
  typeof input.title !== "string" ||
  !/^(feat|fix|docs|chore|refactor|test|ci|perf)(\([a-z0-9-]+\))?: .{1,200}$/.test(input.title)
)
  throw new Error("title must use the allowed Conventional Commits format");
if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 100000)
  throw new Error("body is invalid");
const run = async (command, description, allow = false) => {
  const r = await tools.bash({ command, workdir: input.workdir, description, timeoutMs: 60000 });
  if (r.kind !== "foreground") throw new Error(description + " did not finish");
  if (r.exitCode !== 0 && !allow) throw new Error(r.stderr.text || description + " failed");
  return r;
};
const name = (await run("git config user.name", "Read contributor name")).stdout.text.trim(),
  email = (await run("git config user.email", "Read contributor email")).stdout.text.trim(),
  declaration = "Signed-off-by: " + name + " <" + email + ">";
if (
  !name ||
  !email ||
  !input.body.includes(declaration) ||
  input.body.includes("Your Name <your-email@example.com>")
)
  throw new Error("PR body must include the configured contributor DCO declaration");
const head = (await run("git rev-parse HEAD", "Read candidate commit")).stdout.text.trim(),
  branch = (await run("git branch --show-current", "Read candidate branch")).stdout.text.trim();
if (head !== input.expectedHeadSha) throw new Error("Local commit does not match expectedHeadSha");
if (input.headBranch && input.headBranch !== branch)
  throw new Error("Current branch does not match headBranch");
let assignee = null;
if (input.assignee !== false) {
  const permission = (
    await run(
      "gh repo view " + q(repo) + " --json viewerPermission --jq .viewerPermission",
      "Read repository permission",
    )
  ).stdout.text.trim();
  if (["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"].includes(permission)) assignee = "@me";
  else if (input.assignee === "@me")
    throw new Error("Repository permission does not allow self-assignment");
}
const publication = await tools.publish_nemoclaw_pr_branch({
  workdir: input.workdir,
  repository: repo,
  remote,
  baseBranch,
  expectedHeadSha: input.expectedHeadSha,
  ...(input.apply === true ? { apply: true } : {}),
});
const commitCount = publication.commits.length;
if (input.apply !== true)
  return {
    ok: true,
    apply: false,
    mutated: false,
    repo,
    remote,
    baseBranch,
    headBranch: branch,
    title: input.title,
    draft: input.draft === true,
    assignee,
    commitCount,
    verificationPending: true,
    unverified: [],
  };
if (!publication.allVerified)
  return {
    ok: false,
    apply: true,
    mutated: publication.mutated,
    step: "verification",
    repo,
    remote,
    baseBranch,
    headBranch: branch,
    title: input.title,
    draft: input.draft === true,
    assignee,
    commitCount,
    verificationPending: false,
    unverified: publication.commits
      .filter((c) => !c.verified)
      .map((c) => ({ sha: c.sha, reason: c.reason })),
  };
const current = (await run("git rev-parse HEAD", "Recheck candidate commit")).stdout.text.trim();
if (current !== input.expectedHeadSha)
  throw new Error("Candidate commit changed after publication");
let command =
  "gh pr create --repo " +
  q(repo) +
  " --base " +
  q(baseBranch) +
  " --head " +
  q(branch) +
  " --title " +
  q(input.title) +
  " --body " +
  q(input.body);
if (input.draft) command += " --draft";
if (assignee) command += " --assignee @me";
const created = await run(command, "Create GitHub pull request", true);
if (created.exitCode !== 0) {
  const lookup = await run(
    "gh pr list --repo " +
      q(repo) +
      " --head " +
      q(branch) +
      " --state open --json url --limit 1 --jq '.[0].url // empty'",
    "Check pull request after create failure",
    true,
  );
  if (lookup.exitCode === 0 && lookup.stdout.text.trim())
    return {
      ok: true,
      apply: true,
      mutated: true,
      repo,
      remote,
      baseBranch,
      headBranch: branch,
      title: input.title,
      draft: input.draft === true,
      assignee,
      commitCount,
      verificationPending: false,
      url: lookup.stdout.text.trim(),
      unverified: [],
    };
  throw new Error(
    "Pull request creation failed; no pull request exists for the branch.\n" + created.stderr.text,
  );
}
return {
  ok: true,
  apply: true,
  mutated: true,
  repo,
  remote,
  baseBranch,
  headBranch: branch,
  title: input.title,
  draft: input.draft === true,
  assignee,
  commitCount,
  verificationPending: false,
  url: created.stdout.text.trim(),
  unverified: [],
};
