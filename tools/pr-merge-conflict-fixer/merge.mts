// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type MergeState = {
  baseSha: string;
  conflictPaths: string[];
  conflictTree: string;
  headSha: string;
  repository: string;
};

export class ConflictFixerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictFixerError";
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function requireSha(value: string, name: string): string {
  if (!SHA_PATTERN.test(value)) {
    throw new ConflictFixerError(`${name} must be a lowercase 40-character Git SHA`);
  }
  return value;
}

function gitText(
  repository: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitBuffer(
  repository: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  return execFileSync("git", args, {
    cwd: repository,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitStatus(
  repository: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stderr: string; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function nulPaths(output: Buffer): string[] {
  const text = output.toString("utf8");
  if (!text) return [];
  const fields = text.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function ensureCommit(sourceRepository: string, sha: string): void {
  if (gitStatus(sourceRepository, ["cat-file", "-e", `${sha}^{commit}`]).status === 0) return;
  const fetched = gitStatus(sourceRepository, ["fetch", "--no-tags", "--force", "origin", sha]);
  if (fetched.status !== 0) {
    throw new ConflictFixerError(
      `Git could not fetch ${sha}: ${fetched.stderr.trim() || fetched.stdout.trim()}`,
    );
  }
  if (gitStatus(sourceRepository, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
    throw new ConflictFixerError(`Git did not fetch commit ${sha}`);
  }
}

export function listUnmergedPaths(repository: string): string[] {
  return nulPaths(gitBuffer(repository, ["diff", "--name-only", "--diff-filter=U", "-z"]));
}

export function listTreeChanges(repository: string, fromTree: string, toTree: string): string[] {
  return nulPaths(gitBuffer(repository, ["diff", "--name-only", "-z", fromTree, toTree]));
}

export function hasTreeChanges(
  repository: string,
  fromTree: string,
  toTree: string,
  pathspec: string,
): boolean {
  const result = gitStatus(repository, ["diff", "--quiet", fromTree, toTree, "--", pathspec]);
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new ConflictFixerError(
    `Git could not compare trees: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

export function writeTree(repository: string): string {
  return requireSha(gitText(repository, ["write-tree"]), "tree");
}

export function writeConflictTree(repository: string): string {
  const gitDir = path.resolve(repository, gitText(repository, ["rev-parse", "--git-dir"]));
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "nemoclaw-conflict-index-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  try {
    copyFileSync(path.join(gitDir, "index"), temporaryIndex);
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    gitText(repository, ["add", "-A"], env);
    return requireSha(gitText(repository, ["write-tree"], env), "conflict tree");
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function prepareMerge(
  sourceRepository: string,
  destination: string,
  headShaInput: string,
  baseShaInput: string,
): MergeState | null {
  const headSha = requireSha(headShaInput, "head SHA");
  const baseSha = requireSha(baseShaInput, "base SHA");
  ensureCommit(sourceRepository, headSha);
  ensureCommit(sourceRepository, baseSha);

  rmSync(destination, { force: true, recursive: true });
  const clone = gitStatus(sourceRepository, [
    "clone",
    "--no-hardlinks",
    "--no-checkout",
    sourceRepository,
    destination,
  ]);
  if (clone.status !== 0) {
    throw new ConflictFixerError(
      `Git could not create the merge workspace: ${clone.stderr.trim() || clone.stdout.trim()}`,
    );
  }

  gitText(destination, ["checkout", "--detach", headSha]);
  const merge = gitStatus(destination, [
    "-c",
    "user.name=NemoClaw Conflict Fixer",
    "-c",
    "user.email=actions@github.com",
    "merge",
    "--no-commit",
    "--no-ff",
    baseSha,
  ]);
  if (merge.status === 0) return null;

  const conflictPaths = listUnmergedPaths(destination);
  if (conflictPaths.length === 0) {
    throw new ConflictFixerError(
      `Git merge failed without conflict paths: ${merge.stderr.trim() || merge.stdout.trim()}`,
    );
  }

  return {
    baseSha,
    conflictPaths,
    conflictTree: writeConflictTree(destination),
    headSha,
    repository: destination,
  };
}

export function replaceWithTree(repository: string, tree: string): void {
  requireSha(tree, "tree");
  gitText(repository, ["read-tree", "--reset", "-u", tree]);
}

export function applyResolutionPatch(repository: string, patchPath: string): void {
  const applied = gitStatus(repository, ["apply", "--index", "--binary", patchPath]);
  if (applied.status !== 0) {
    throw new ConflictFixerError(
      `Git rejected the resolution patch: ${applied.stderr.trim() || applied.stdout.trim()}`,
    );
  }
}

export function samePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
