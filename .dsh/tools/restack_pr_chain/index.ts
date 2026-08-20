// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
if (
  !Array.isArray(input.branches) ||
  input.branches.length < 1 ||
  input.branches.length > 20 ||
  new Set(input.branches).size !== input.branches.length
)
  throw new Error("branches must contain 1-20 unique names");
const remote = input.remote ?? "origin",
  base = input.base ?? "main";
if (
  typeof remote !== "string" ||
  !remote ||
  remote.length > 255 ||
  remote.startsWith("-") ||
  !/^[A-Za-z0-9._/-]+$/.test(remote)
)
  throw new Error("Invalid Git remote");
for (const [label, branch] of [
  ["base", base],
  ...input.branches.map((branch) => ["head", branch]),
]) {
  if (typeof branch !== "string" || !branch || branch.length > 255 || branch.startsWith("-"))
    throw new Error("Invalid " + label + " branch");
  const checked = await tools.bash({
    command: "git check-ref-format --branch " + quote(branch),
    workdir: input.workdir,
    description: "Validate restack branch name",
    timeoutMs: 30000,
  });
  if (checked.kind !== "foreground" || checked.exitCode !== 0)
    throw new Error("Invalid " + label + " branch " + branch);
}
const initial = await tools.bash({
  command: "git status --porcelain=v1",
  workdir: input.workdir,
  description: "Check restack working tree",
  timeoutMs: 30000,
});
if (initial.kind !== "foreground" || initial.exitCode !== 0)
  throw new Error("Could not inspect working tree");
if (initial.stdout.text.trim())
  throw new Error(
    "Working tree has uncommitted changes; commit or stash them before restacking.\n" +
      initial.stdout.text,
  );
let parent = base;
const plan = [];
for (const branch of input.branches) {
  plan.push("synchronize " + branch + " from " + remote + "/" + parent);
  if (input.validateEach !== false)
    plan.push("run focused non-writing validation against " + remote + "/" + parent);
  plan.push("git push " + remote + " HEAD:refs/heads/" + branch);
  parent = branch;
}
if (input.apply !== true)
  return {
    applied: false,
    mode: "dry-run",
    plan,
    notes: [
      "No fetch, checkout, reset, merge, validation, or push was performed.",
      "Applied execution stops on the first synchronization, validation, cleanliness, or push failure.",
    ],
    resultJson: JSON.stringify({ ok: true, dryRun: true }),
  };
const results = [];
let currentBase = base;
for (const branch of input.branches) {
  const sync = await tools.sync_stacked_pr_branch({
    workdir: input.workdir,
    headBranch: branch,
    baseBranch: currentBase,
    remote,
    resetToRemote: true,
    requireClean: true,
    apply: true,
  });
  let syncDetail = {};
  try {
    syncDetail = JSON.parse(sync.resultJson);
  } catch {
    syncDetail = { ok: false, reason: "Invalid synchronization result" };
  }
  const branchStatus = await tools.bash({
    command: "git status --short --branch",
    workdir: input.workdir,
    description: "Read restacked branch status",
    timeoutMs: 30000,
  });
  let validation = null;
  if (syncDetail.ok && input.validateEach !== false)
    validation = await tools.run_nemoclaw_focused_repair_validation({
      workdir: input.workdir,
      baseRef: remote + "/" + currentBase,
      formatWrite: false,
      dryRun: false,
    });
  const item = {
    branch,
    base: currentBase,
    sync,
    validation,
    status: branchStatus.kind === "foreground" ? branchStatus.stdout.text : "",
  };
  results.push(item);
  if (!syncDetail.ok || (validation && !validation.ok))
    return {
      applied: true,
      mode: "apply",
      plan,
      notes: ["Stopped at the first synchronization or validation failure."],
      resultJson: JSON.stringify({ ok: false, results }),
    };
  const clean = await tools.bash({
    command: "git status --porcelain=v1",
    workdir: input.workdir,
    description: "Check post-validation cleanliness",
    timeoutMs: 30000,
  });
  if (clean.kind !== "foreground" || clean.exitCode !== 0)
    throw new Error("Could not inspect post-validation working tree");
  if (clean.stdout.text.trim()) {
    item.postValidationStatus = clean.stdout.text;
    return {
      applied: true,
      mode: "apply",
      plan,
      notes: ["Validation changed tracked or untracked files; no push was attempted."],
      resultJson: JSON.stringify({
        ok: false,
        reason: "validation changed tracked or untracked files",
        results,
      }),
    };
  }
  const push = await tools.bash({
    command: "git push " + quote(remote) + " " + quote("HEAD:refs/heads/" + branch),
    workdir: input.workdir,
    description: "Push restacked branch",
    timeoutMs: 120000,
  });
  if (push.kind !== "foreground") throw new Error("Git push did not finish");
  item.push = {
    code: push.exitCode,
    stdout: push.stdout.text.slice(-2000),
    stderr: push.stderr.text.slice(-4000),
    truncated: push.stdout.truncated || push.stderr.truncated,
  };
  if (push.exitCode !== 0)
    throw new Error(
      "Git push failed; stop and resolve GitHub access before continuing.\n" + push.stderr.text,
    );
  currentBase = branch;
}
return {
  applied: true,
  mode: "apply",
  plan,
  notes: [],
  resultJson: JSON.stringify({ ok: true, results }),
};
