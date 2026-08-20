// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
if (typeof input.workdir !== "string" || !input.workdir.trim())
  throw new Error("workdir is required");
if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 50)
  throw new Error("paths must contain 1 to 50 worktree paths");
if (typeof input.root !== "string" || !input.root.trim()) throw new Error("root is required");
const paths = [...new Set(input.paths)],
  root = input.root,
  isolationKey = input.isolationKey,
  dryRun = input.dryRun ?? true,
  failure = input.failure ?? "fail-fast";
if (!["fail-fast", "settled"].includes(failure))
  throw new Error("failure must be fail-fast or settled");
if (typeof isolationKey !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(isolationKey))
  throw new Error("isolationKey is invalid");
const namespace = root + "/" + isolationKey,
  parts = (value) => value.split("/").filter(Boolean),
  namespaceParts = parts(namespace);
const safe = (p) => {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > 4096 || /[\r\n\0]/.test(p))
    return false;
  const targetParts = parts(p);
  return (
    !targetParts.includes("..") &&
    !targetParts.includes(".") &&
    targetParts.length > namespaceParts.length &&
    namespaceParts.every((part, index) => targetParts[index] === part)
  );
};
if (
  typeof root !== "string" ||
  !root.startsWith("/") ||
  root === "/" ||
  /[\r\n\0]/.test(root) ||
  paths.some((p) => !safe(p))
)
  throw new Error("Every path must be a strict descendant of the caller isolation namespace");
if (!dryRun && input.apply !== true)
  throw new Error("Worktree removal requires dryRun:false and apply:true");
const listed = await tools.bash({
  command: "git worktree list --porcelain",
  workdir: input.workdir,
  description: "List registered worktrees for cleanup",
  timeoutMs: 30000,
});
if (listed.kind !== "foreground" || listed.exitCode !== 0)
  throw new Error("Could not list registered worktrees");
const registered = new Map();
let entry = null;
for (const line of listed.stdout.text.split(/\r?\n/)) {
  if (line.startsWith("worktree ")) {
    entry = { path: line.slice(9), head: "", branch: null, detached: false };
    registered.set(entry.path, entry);
  } else if (entry && line.startsWith("HEAD ")) entry.head = line.slice(5);
  else if (entry && line.startsWith("branch ")) entry.branch = line.slice(7);
  else if (entry && line === "detached") entry.detached = true;
}
const results = [],
  errors = [];
for (const path of paths) {
  try {
    const item = registered.get(path);
    if (!item) throw new Error("Path is not a registered Git worktree");
    if (!item.detached)
      throw new Error("Worktree is branch-attached; cleanup only removes detached worktrees");
    const status = await tools.bash({
      command: "git status --short",
      workdir: path,
      description: "Check isolated worktree before cleanup",
      timeoutMs: 30000,
    });
    if (status.kind !== "foreground" || status.exitCode !== 0)
      throw new Error("Could not inspect worktree");
    if (status.stdout.text.trim()) throw new Error("Worktree has uncommitted changes");
    if (dryRun) results.push({ path, head: item.head, action: "planned" });
    else {
      const remove = await tools.bash({
        command: "git worktree remove " + quote(path),
        workdir: input.workdir,
        description: "Remove clean isolated worktree",
        timeoutMs: 30000,
      });
      if (remove.kind !== "foreground" || remove.exitCode !== 0)
        throw new Error(
          remove.kind === "foreground"
            ? remove.stderr.text || "Worktree removal failed"
            : "Worktree removal did not finish",
        );
      results.push({ path, head: item.head, action: "removed" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ path, message });
    if (failure === "fail-fast") throw error;
  }
}
return {
  dryRun,
  apply: !dryRun,
  mutated: !dryRun && results.length > 0,
  root,
  failure,
  count: results.length,
  results,
  errors,
};
