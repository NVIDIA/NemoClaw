// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Requires both Pi qualification receipts when a Pi image input changes. */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { directDockerfileCopySources } from "../lib/dockerfile-copy-sources.mts";

type GitResult = {
  error?: string;
  status: number | null;
  stdout: string;
};

type GitRunner = (args: readonly string[]) => GitResult;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PI_DOCKERFILES = ["agents/pi/Dockerfile", "agents/pi/Dockerfile.base"] as const;
export const PI_QUALIFICATION_RECEIPTS = [
  "ci/pi-agent-qualification-v1-linux-amd64.json",
  "ci/pi-agent-qualification-v1-linux-arm64.json",
] as const;

function ownsPath(source: string, changedPath: string): boolean {
  const normalizedSource = source.replace(/\/+$/u, "");
  return changedPath === normalizedSource || changedPath.startsWith(`${normalizedSource}/`);
}

export function missingPiQualificationReceiptRefreshes(
  changedPaths: readonly string[],
  imageSourcePaths: readonly string[],
  receiptPaths: readonly string[] = PI_QUALIFICATION_RECEIPTS,
): string[] {
  if (
    !changedPaths.some((changedPath) =>
      imageSourcePaths.some((source) => ownsPath(source, changedPath)),
    )
  ) {
    return [];
  }
  return receiptPaths.filter((receipt) => !changedPaths.includes(receipt));
}

function runGit(args: readonly string[]): GitResult {
  const result = spawnSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    error: result.error?.message,
    status: result.status,
    stdout: result.stdout ?? "",
  };
}

function requireGitOutput(result: GitResult, operation: string): string {
  if (result.error) throw new Error(`${operation}: ${result.error}`);
  if (result.status !== 0)
    throw new Error(`${operation}: git exited ${result.status ?? "without status"}`);
  return result.stdout;
}

function mergeBaseRevision(git: GitRunner, baseBranch: string | undefined): string {
  const baseRef = baseBranch ? `origin/${baseBranch}` : "origin/main";
  const revision = requireGitOutput(
    git(["merge-base", "HEAD", baseRef]),
    `Could not resolve the Pi receipt comparison base against ${baseRef}`,
  ).trim();
  if (!revision) {
    throw new Error(`Could not resolve the Pi receipt comparison base against ${baseRef}`);
  }
  return revision;
}

function changedPathsFromBase(git: GitRunner, revision: string): string[] {
  return requireGitOutput(
    git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", revision, "HEAD", "--"]),
    `Could not inspect changes after ${revision}`,
  )
    .split("\0")
    .filter(Boolean);
}

function piImageSourcePaths(rootDir: string): string[] {
  const copiedSources = PI_DOCKERFILES.flatMap((dockerfile) =>
    directDockerfileCopySources(path.join(rootDir, dockerfile), dockerfile).map(
      ({ source }) => source,
    ),
  );
  return [...new Set([".dockerignore", ...PI_DOCKERFILES, ...copiedSources])].sort();
}

export function checkPiQualificationReceiptRefresh(
  git: GitRunner = runGit,
  rootDir: string = REPO_ROOT,
  baseBranch: string | undefined = process.env.GITHUB_BASE_REF?.trim(),
): void {
  const revision = mergeBaseRevision(git, baseBranch);
  const changedPaths = changedPathsFromBase(git, revision);
  const missingReceipts = missingPiQualificationReceiptRefreshes(
    changedPaths,
    piImageSourcePaths(rootDir),
  );
  if (missingReceipts.length === 0) return;

  throw new Error(
    [
      "Pi image inputs changed without refreshing both qualification receipts.",
      "Publish one exact-commit AMD64 and ARM64 Pi candidate cohort, then update:",
      ...missingReceipts.map((receipt) => `- ${receipt}`),
    ].join("\n"),
  );
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  checkPiQualificationReceiptRefresh();
}
