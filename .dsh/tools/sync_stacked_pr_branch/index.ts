// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const remote = input.remote ?? "origin";
if (
  typeof remote !== "string" ||
  !remote ||
  remote.length > 255 ||
  remote.startsWith("-") ||
  !/^[A-Za-z0-9._/-]+$/.test(remote)
)
  throw new Error("Invalid Git remote");
for (const [label, branch] of [
  ["head", input.headBranch],
  ["base", input.baseBranch],
]) {
  if (typeof branch !== "string" || !branch || branch.length > 255 || branch.startsWith("-"))
    throw new Error("Invalid " + label + " branch");
  const checked = await tools.bash({
    command: "git check-ref-format --branch " + quote(branch),
    workdir: input.workdir,
    description: "Validate stacked branch name",
    timeoutMs: 30000,
  });
  if (checked.kind !== "foreground" || checked.exitCode !== 0)
    throw new Error(
      "Invalid " +
        label +
        " branch " +
        branch +
        (checked.kind === "foreground" ? ": " + checked.stderr.text : ""),
    );
}
const statusBefore = await tools.bash({
  command: "git status --porcelain=v1",
  workdir: input.workdir,
  description: "Check stacked branch working tree",
  timeoutMs: 30000,
});
if (statusBefore.kind !== "foreground" || statusBefore.exitCode !== 0)
  throw new Error("Could not inspect working tree");
if (
  (input.resetToRemote === true || input.requireClean !== false) &&
  statusBefore.stdout.text.trim()
)
  throw new Error(
    "Working tree has uncommitted changes; commit or stash them before synchronizing the branch.\n" +
      statusBefore.stdout.text,
  );
const plan = [
  "git fetch " + quote(remote) + " " + quote(input.headBranch) + " " + quote(input.baseBranch),
  "git checkout " + quote(input.headBranch),
  ...(input.resetToRemote === true
    ? ["git reset --hard " + quote(remote + "/" + input.headBranch)]
    : []),
  "git merge --no-edit -- " + quote(remote + "/" + input.baseBranch),
];
if (input.apply !== true)
  return {
    applied: false,
    mode: "dry-run",
    plan,
    notes: ["No fetch, checkout, reset, or merge was performed."],
    resultJson: JSON.stringify({ ok: true, dryRun: true, statusBefore: statusBefore.stdout.text }),
  };
const run = async (command, description, timeoutMs) => {
  const result = await tools.bash({ command, workdir: input.workdir, description, timeoutMs });
  if (result.kind !== "foreground") throw new Error(description + " did not finish");
  return result;
};
const fetch = await run(
  "git fetch " + quote(remote) + " " + quote(input.headBranch) + " " + quote(input.baseBranch),
  "Fetch stacked branches",
  60000,
);
if (fetch.exitCode !== 0)
  return {
    applied: true,
    mode: "apply",
    plan,
    notes: ["Stopped at fetch failure."],
    resultJson: JSON.stringify({
      ok: false,
      step: "fetch",
      fetch: {
        code: fetch.exitCode,
        stdout: fetch.stdout.text.slice(-2000),
        stderr: fetch.stderr.text.slice(-4000),
        truncated: fetch.stdout.truncated || fetch.stderr.truncated,
      },
    }),
  };
const checkout = await run(
  "git checkout " + quote(input.headBranch),
  "Check out stacked branch",
  30000,
);
if (checkout.exitCode !== 0)
  return {
    applied: true,
    mode: "apply",
    plan,
    notes: ["Stopped at checkout failure."],
    resultJson: JSON.stringify({
      ok: false,
      step: "checkout",
      checkout: {
        code: checkout.exitCode,
        stdout: checkout.stdout.text.slice(-2000),
        stderr: checkout.stderr.text.slice(-4000),
        truncated: checkout.stdout.truncated || checkout.stderr.truncated,
      },
    }),
  };
let reset = null;
if (input.resetToRemote === true) {
  reset = await run(
    "git reset --hard " + quote(remote + "/" + input.headBranch),
    "Reset stacked branch to remote",
    30000,
  );
  if (reset.exitCode !== 0)
    return {
      applied: true,
      mode: "apply",
      plan,
      notes: ["Stopped at reset failure."],
      resultJson: JSON.stringify({
        ok: false,
        step: "reset",
        reset: {
          code: reset.exitCode,
          stdout: reset.stdout.text.slice(-2000),
          stderr: reset.stderr.text.slice(-4000),
          truncated: reset.stdout.truncated || reset.stderr.truncated,
        },
      }),
    };
}
const merge = await run(
  "git merge --no-edit -- " + quote(remote + "/" + input.baseBranch),
  "Merge stacked branch base",
  120000,
);
const finalStatus = await run("git status --short --branch", "Read stacked branch status", 30000);
const log = await run("git log -5 --oneline --decorate", "Read stacked branch history", 30000);
const detail = {
  ok: merge.exitCode === 0,
  fetch: { code: fetch.exitCode, stderr: fetch.stderr.text.slice(-2000) },
  checkout: {
    code: checkout.exitCode,
    stdout: checkout.stdout.text.slice(-2000),
    stderr: checkout.stderr.text.slice(-2000),
  },
  reset: reset
    ? {
        code: reset.exitCode,
        stdout: reset.stdout.text.slice(-2000),
        stderr: reset.stderr.text.slice(-2000),
      }
    : null,
  merge: {
    code: merge.exitCode,
    stdout: merge.stdout.text.slice(-8000),
    stderr: merge.stderr.text.slice(-4000),
    truncated: merge.stdout.truncated || merge.stderr.truncated,
  },
  status: finalStatus.stdout.text,
  log: log.stdout.text,
};
return {
  applied: true,
  mode: "apply",
  plan,
  notes: merge.exitCode === 0 ? [] : ["Merge failed; conflicts remain for manual resolution."],
  resultJson: JSON.stringify(detail),
};
