// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
if (typeof input.workdir !== "string" || !input.workdir.trim())
  throw new Error("workdir is required");
if (!Number.isSafeInteger(input.number) || input.number < 1)
  throw new Error("number must be a positive integer");
if (typeof input.root !== "string" || !input.root.trim()) throw new Error("root is required");
const repo = input.repo ?? "NVIDIA/NemoClaw",
  root = input.root,
  remote = input.remote ?? "origin",
  reuseExisting = input.reuseExisting ?? false,
  replaceExisting = input.replaceExisting ?? false,
  requirePrimaryClean = input.requirePrimaryClean ?? false,
  requireOpen = input.requireOpen ?? true,
  dryRun = input.dryRun ?? true;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (
  typeof remote !== "string" ||
  !remote ||
  remote.length > 255 ||
  remote.startsWith("-") ||
  !/^[A-Za-z0-9._/-]+$/.test(remote)
)
  throw new Error("Invalid Git remote");
const safeAbsolute = (value, label) => {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 4096 ||
    /[\r\n\0]/.test(value) ||
    value === "/"
  )
    throw new Error(label + " must be a safe absolute path other than /");
};
safeAbsolute(root, "root");
if (input.path !== undefined) safeAbsolute(input.path, "path");
if (reuseExisting && replaceExisting)
  throw new Error("reuseExisting and replaceExisting cannot both be true");
if (!dryRun && input.apply !== true)
  throw new Error("Worktree mutation requires dryRun:false and apply:true");
let isolationKey = input.isolationKey;
if (isolationKey === undefined) {
  const env = await tools.bash({
    command: "printf '%s' \"$DSH_SESSION_ID\"",
    workdir: input.workdir,
    description: "Read worktree isolation key",
    timeoutMs: 10000,
  });
  if (env.kind !== "foreground" || env.exitCode !== 0 || !env.stdout.text.trim())
    throw new Error("isolationKey is required outside a managed DSH session");
  isolationKey = env.stdout.text.trim();
}
if (typeof isolationKey !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(isolationKey))
  throw new Error("isolationKey must contain only letters, numbers, dot, underscore, or hyphen");
const namespace = root + "/" + isolationKey,
  targetPath = input.path ?? namespace + "/" + input.number;
if (targetPath === input.workdir)
  throw new Error("Isolated worktree path must differ from the primary checkout");
const parts = (value) => value.split("/").filter(Boolean);
const rootParts = parts(root),
  namespaceParts = parts(namespace),
  targetParts = parts(targetPath);
if (
  targetParts.includes("..") ||
  targetParts.includes(".") ||
  namespaceParts.some((part, index) => targetParts[index] !== part) ||
  targetParts.length <= namespaceParts.length
)
  throw new Error("path must be a strict descendant of the caller isolation namespace");
const status = await tools.bash({
  command: "git status --short",
  workdir: input.workdir,
  description: "Check primary worktree cleanliness",
  timeoutMs: 30000,
});
if (status.kind !== "foreground" || status.exitCode !== 0)
  throw new Error("Could not inspect primary worktree");
if (requirePrimaryClean && status.stdout.text.trim())
  throw new Error("Primary worktree has uncommitted changes");
const view = await tools.bash({
  command:
    "gh pr view " +
    input.number +
    " --repo " +
    quote(repo) +
    " --json number,url,state,isDraft,headRefOid,headRefName,headRepository,headRepositoryOwner,maintainerCanModify,baseRefName,baseRefOid",
  workdir: input.workdir,
  description: "Inspect isolated worktree target",
  timeoutMs: 30000,
});
if (view.kind !== "foreground" || view.exitCode !== 0)
  throw new Error(
    view.kind === "foreground"
      ? view.stderr.text || "GitHub read failed for PR #" + input.number
      : "GitHub read did not finish",
  );
const item = JSON.parse(view.stdout.text);
if (requireOpen && item.state !== "OPEN")
  throw new Error("PR #" + input.number + " state is " + item.state + "; an open PR is required");
if (
  !/^[0-9a-f]{40}$/.test(String(item.headRefOid ?? "")) ||
  !/^[0-9a-f]{40}$/.test(String(item.baseRefOid ?? ""))
)
  throw new Error("Pull request returned an invalid commit SHA");
const result = {
  repo,
  remote,
  root,
  isolationKey,
  number: item.number,
  url: item.url,
  path: targetPath,
  commit: item.headRefOid,
  baseCommit: item.baseRefOid,
  baseBranch: item.baseRefName,
  sourceRepository:
    item.headRepository?.nameWithOwner ??
    (item.headRepositoryOwner?.login ?? "") + "/" + (item.headRepository?.name ?? ""),
  sourceBranch: item.headRefName,
  maintainerCanModify: item.maintainerCanModify,
  isDraft: item.isDraft,
  state: item.state,
};
if (dryRun)
  return {
    dryRun: true,
    apply: false,
    mutated: false,
    ...result,
    action: "planned",
    warning: "No directory, ref, or worktree was changed.",
  };
const run = async (command, description, timeoutMs = 30000, workdir = input.workdir) => {
  const r = await tools.bash({ command, workdir, description, timeoutMs });
  if (r.kind !== "foreground") throw new Error(description + " did not finish");
  if (r.exitCode !== 0) throw new Error(r.stderr.text || r.stdout.text || description + " failed");
  return r.stdout.text;
};
await run(
  "mkdir -p " + quote(targetPath.slice(0, targetPath.lastIndexOf("/"))),
  "Create isolated worktree parent",
  10000,
);
await run(
  "git fetch " +
    quote(remote) +
    " " +
    quote("+refs/pull/" + input.number + "/head:refs/remotes/pull/" + input.number),
  "Fetch exact pull request commit",
  120000,
);
const fetched = (
  await run(
    "git rev-parse " + quote("refs/remotes/pull/" + input.number),
    "Verify fetched pull request commit",
    10000,
  )
).trim();
if (fetched !== item.headRefOid)
  throw new Error("Latest PR commit changed during preparation; retry with a fresh snapshot");
const listed = await run("git worktree list --porcelain", "List registered Git worktrees", 30000),
  registered = new Map();
let entry = null;
for (const line of listed.split(/\r?\n/)) {
  if (line.startsWith("worktree ")) {
    entry = { path: line.slice(9), head: "", detached: false };
    registered.set(entry.path, entry);
  } else if (entry && line.startsWith("HEAD ")) entry.head = line.slice(5);
  else if (entry && line === "detached") entry.detached = true;
}
let action = "created";
const registeredEntry = registered.get(targetPath);
if (registeredEntry) {
  const wtStatus = await tools.bash({
    command: "git status --short",
    workdir: targetPath,
    description: "Check isolated worktree cleanliness",
    timeoutMs: 30000,
  });
  if (wtStatus.kind !== "foreground" || wtStatus.exitCode !== 0)
    throw new Error("Could not inspect worktree " + targetPath);
  if (wtStatus.stdout.text.trim())
    throw new Error(
      "Worktree " + targetPath + " has uncommitted changes and will not be reused or replaced",
    );
  if (!registeredEntry.detached)
    throw new Error("Existing worktree is branch-attached and will not be reused or replaced");
  const resolved = (
    await run("git rev-parse HEAD", "Resolve isolated worktree commit", 10000, targetPath)
  ).trim();
  if (resolved === item.headRefOid) {
    if (!reuseExisting)
      throw new Error(
        "Worktree " +
          targetPath +
          " already exists. Pass reuseExisting:true to reuse this clean exact-commit worktree.",
      );
    action = "reused";
  } else {
    if (!replaceExisting)
      throw new Error(
        "Worktree " +
          targetPath +
          " is at " +
          resolved +
          "; expected " +
          item.headRefOid +
          ". Pass replaceExisting:true to replace this clean worktree.",
      );
    await run("git worktree remove " + quote(targetPath), "Remove stale isolated worktree", 30000);
    action = "replaced";
  }
} else {
  const exists = await tools.bash({
    command: "test -e " + quote(targetPath),
    workdir: input.workdir,
    description: "Check isolated worktree path",
    timeoutMs: 10000,
  });
  if (exists.kind !== "foreground")
    throw new Error("Could not inspect worktree path " + targetPath);
  if (exists.exitCode === 0)
    throw new Error("Path " + targetPath + " exists but is not a registered Git worktree");
  if (exists.exitCode !== 1) throw new Error("Could not inspect worktree path " + targetPath);
}
if (action !== "reused")
  await run(
    "git worktree add --detach " + quote(targetPath) + " " + quote(item.headRefOid),
    "Create exact-commit worktree",
    30000,
  );
const head = (
  await run("git rev-parse HEAD", "Verify isolated worktree commit", 10000, targetPath)
).trim();
if (head !== item.headRefOid) throw new Error("Prepared worktree resolved to an unexpected commit");
return { dryRun: false, apply: true, mutated: action !== "reused", ...result, action };
