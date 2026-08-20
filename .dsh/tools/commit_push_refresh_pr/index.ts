// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const repo = input.repository ?? "NVIDIA/NemoClaw";
const remote = input.remote ?? "origin";
if (typeof input.workdir !== "string" || !input.workdir.trim())
  throw new Error("workdir is required");
if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1)
  throw new Error("pullNumber must be a positive integer");
if (
  typeof input.message !== "string" ||
  !/^(feat|fix|docs|chore|refactor|test|ci|perf|merge)(\([^)]+\))?!?: .+/u.test(
    input.message.trim(),
  )
)
  throw new Error("A Conventional Commit message is required");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
  throw new Error("repository must be owner/name");
if (!/^[A-Za-z0-9_.-]+$/.test(remote) || remote.startsWith("-"))
  throw new Error("remote is invalid");
if (input.all === true && input.files?.length) throw new Error("Pass files or all:true, not both");
if (!input.all && (!Array.isArray(input.files) || input.files.length === 0))
  throw new Error("Pass files or all:true so commit contents are explicit");
if (
  (input.files?.length ?? 0) > 200 ||
  input.files?.some((file) => typeof file !== "string" || !file || file.includes("\0"))
)
  throw new Error("files must contain 1 to 200 valid paths");
const willPush = input.push !== false;
const willRefresh = input.refreshBody !== false;
if (willRefresh && !willPush)
  throw new Error("Evidence cannot be updated for an unpushed commit; pass refreshBody:false");
if (willRefresh && (!input.docsResult || !input.docsEvidence?.trim() || !input.docsAgent?.trim()))
  throw new Error("Updating PR evidence requires a documentation writer receipt");
if ((input.broadGatePassed === undefined) !== (input.broadGateEvidence === undefined))
  throw new Error("broadGatePassed and broadGateEvidence must be provided together");
const run = async (command, description, timeoutMs = 60000) => {
  const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
  if (result.kind !== "foreground")
    throw new Error(description + " did not finish in the foreground");
  if (result.exitCode !== 0)
    throw new Error(
      description + " failed.\n" + (result.stdout.text + "\n" + result.stderr.text).trim(),
    );
  if (result.stdout.truncated) throw new Error(description + " exceeded its bounded output");
  return result.stdout.text;
};
const pr = JSON.parse(
  await run(
    "gh pr view " +
      quote(String(input.pullNumber)) +
      " --repo " +
      quote(repo) +
      " --json headRefName,headRefOid,url,title,state",
    "Read pull request identity",
  ),
);
if (pr.state !== "OPEN") throw new Error("PR #" + input.pullNumber + " is not open");
const branch = input.branch ?? pr.headRefName;
if (
  typeof branch !== "string" ||
  !branch ||
  branch.startsWith("-") ||
  !/^[A-Za-z0-9._\/-]+$/.test(branch)
)
  throw new Error("Could not resolve a valid PR source branch");
if (branch !== pr.headRefName)
  throw new Error("branch must match the PR source branch " + pr.headRefName);
const localHeadBefore = (await run("git rev-parse HEAD", "Read local commit")).trim();
if (localHeadBefore !== pr.headRefOid)
  throw new Error(
    "Local commit " +
      localHeadBefore +
      " differs from PR commit " +
      pr.headRefOid +
      "; do not commit",
  );
const nulNames = async (cached) =>
  (
    await run(
      "git diff " + (cached ? "--cached " : "") + "--name-only -z",
      cached ? "Read staged paths" : "Read changed paths",
    )
  )
    .split("\0")
    .filter(Boolean);
const requested = new Set(input.files ?? []);
const stagedBefore = await nulNames(true);
const indexTreeBefore = (await run("git write-tree", "Record index state")).trim();
if (!input.all) {
  const unexpected = stagedBefore.filter((file) => !requested.has(file));
  if (unexpected.length)
    throw new Error(
      "Index already contains files outside the requested commit:\n" + unexpected.join("\n"),
    );
}
const plan = [
  input.all ? "git add -A" : "git add -- <" + input.files.length + " explicit files>",
  "reject unexpected pre-staged and post-stage files",
  "verify local HEAD equals the current PR head",
  "create a Signed-off-by commit with the supplied Conventional Commit message",
  ...(willPush
    ? [
        "push HEAD to the exact PR source branch",
        "verify the PR head equals the new local commit with at most five reads",
      ]
    : []),
  ...(willRefresh ? ["refresh PR body evidence only after exact remote-head verification"] : []),
  ...(input.monitor === true ? ["monitor current checks and review findings"] : []),
];
if (input.apply !== true) {
  return {
    applied: false,
    mode: "dry-run",
    plan,
    notes: [
      "Read-only guards passed. No index, commit, push, cache, or GitHub write was performed.",
    ],
    resultJson: JSON.stringify({
      pr,
      branch,
      localHead: localHeadBefore,
      stagedBefore,
      requestedFiles: [...requested],
      willPush,
      willRefresh,
    }),
  };
}
await run(
  input.all ? "git add -A" : "git add -- " + input.files.map(quote).join(" "),
  "Stage selected commit files",
);
const stagedFiles = await nulNames(true);
if (!stagedFiles.length) throw new Error("No staged changes after git add; nothing to commit");
if (!input.all) {
  const unexpected = stagedFiles.filter((file) => !requested.has(file));
  if (unexpected.length) {
    await run("git read-tree " + quote(indexTreeBefore), "Restore index after rejected staging");
    throw new Error(
      "Refusing to commit files outside the requested set:\n" + unexpected.join("\n"),
    );
  }
}
const staged = await run("git diff --cached --name-status", "Read staged change summary");
await run("git commit -s -m " + quote(input.message.trim()), "Create signed-off commit", 120000);
const localHead = (await run("git rev-parse HEAD", "Read committed revision")).trim();
let pushResult = null;
let receipt = null;
let readiness = null;
let monitored = null;
if (willPush) {
  const beforePush = JSON.parse(
    await run(
      "gh pr view " +
        quote(String(input.pullNumber)) +
        " --repo " +
        quote(repo) +
        " --json headRefOid,headRefName,state",
      "Recheck pull request before push",
    ),
  );
  if (
    beforePush.state !== "OPEN" ||
    beforePush.headRefOid !== localHeadBefore ||
    beforePush.headRefName !== branch
  )
    throw new Error("PR identity changed after commit; do not push or update evidence");
  pushResult = await run(
    "git push " + quote(remote) + " " + quote("HEAD:refs/heads/" + branch),
    "Push pull request commit",
    120000,
  );
  let remoteHead = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const viewed = JSON.parse(
      await run(
        "gh pr view " +
          quote(String(input.pullNumber)) +
          " --repo " +
          quote(repo) +
          " --json headRefOid",
        "Verify pushed pull request commit",
      ),
    );
    remoteHead = viewed.headRefOid ?? "";
    if (remoteHead === localHead) break;
    if (attempt < 4) await run("sleep 1", "Wait for pull request commit");
  }
  if (remoteHead !== localHead)
    throw new Error(
      "PR commit did not update to pushed commit " + localHead + "; do not update evidence",
    );
}
if (willRefresh)
  receipt = await tools.refresh_pr_body_evidence({
    number: input.pullNumber,
    repo,
    workdir: input.workdir,
    expectedHeadSha: localHead,
    docsReceipt: { result: input.docsResult, evidence: input.docsEvidence, agent: input.docsAgent },
    targetedValidationLine: input.targetedValidationLine,
    broadGate:
      input.broadGatePassed === undefined
        ? undefined
        : { passed: input.broadGatePassed, evidence: input.broadGateEvidence },
    apply: true,
  });
if (willPush)
  readiness = await tools.summarize_pr_readiness({
    number: input.pullNumber,
    repo,
    workdir: input.workdir,
    includeComments: false,
  });
if (willPush && input.monitor === true)
  monitored = await tools.monitor_pr_until_actionable({
    pullNumber: input.pullNumber,
    repository: repo,
    workdir: input.workdir,
    expectedHeadSha: localHead,
    timeoutMs: 300000,
    intervalMs: 20000,
  });
const [after, log] = await Promise.all([
  run("git status --short --branch", "Read final working tree status"),
  run("git log --oneline --decorate --max-count=5", "Read recent commit log"),
]);
return {
  applied: true,
  mode: "apply",
  plan,
  notes: [],
  resultJson: JSON.stringify({
    ok: true,
    pr,
    branch,
    localHead,
    stagedFiles,
    staged,
    push: pushResult,
    receipt,
    readiness,
    monitor: monitored,
    after,
    log,
  }),
};
