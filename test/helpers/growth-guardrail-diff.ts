// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { hasMaintainerBudgetApproval } from "./e2e-budget-approval";

export type PullRequestFile = {
  readonly filename: string;
  readonly previous_filename?: string | null;
  readonly status?: string;
};

export type GrowthGuardrailDiff = {
  readonly files: readonly PullRequestFile[];
  readonly pullRequestNumber: number | null;
  readonly exceptionPolicySource: "base" | "head";
  readBudgetApproval?(digest: string): Promise<boolean>;
  readBase(paths: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
  readHead(paths: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function parseChangedFiles(source: string): PullRequestFile[] {
  const fields = source.split("\0");
  const files: PullRequestFile[] = [];
  let index = 0;

  while (index < fields.length && fields[index]) {
    const code = fields[index++];
    if (code.startsWith("R")) {
      const previous = fields[index++];
      const filename = fields[index++];
      files.push({ filename, previous_filename: previous, status: "renamed" });
      continue;
    }
    if (code.startsWith("C")) {
      const previous = fields[index++];
      const filename = fields[index++];
      files.push({ filename, previous_filename: previous, status: "added" });
      continue;
    }

    const filename = fields[index++];
    const status = code === "A" ? "added" : code === "D" ? "removed" : "modified";
    files.push({ filename, status });
  }

  return files;
}

function readGitFile(ref: string, file: string, repoRoot = REPO_ROOT): string | null {
  const result = spawnSync("git", ["show", `${ref}:${file}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout : null;
}

function readWorktreeFile(file: string): string | null {
  const absolute = path.join(REPO_ROOT, file);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function readFilesCached(
  paths: readonly string[],
  cache: Map<string, string | null>,
  read: (file: string) => string | null,
): ReadonlyMap<string, string | null> {
  const uniquePaths = [...new Set(paths)];
  uniquePaths.filter((file) => !cache.has(file)).forEach((file) => cache.set(file, read(file)));
  return new Map(uniquePaths.map((file) => [file, cache.get(file) ?? null]));
}

function selectLocalComparisonBase(
  mergeBase: string,
  mergeHead: string | null,
  mergeHeadIsBaseAncestor: boolean,
): string {
  return mergeHead !== null && mergeHeadIsBaseAncestor ? mergeHead : mergeBase;
}

function parseAncestorProbe(status: number | null, error: Error | undefined): boolean {
  if (error !== undefined) throw error;
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed with status ${status ?? "unknown"}`);
}

function resolveLocalComparisonBase(baseRef: string): string {
  const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const mergeHeadResult = spawnSync("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const mergeHead = mergeHeadResult.status === 0 ? mergeHeadResult.stdout.trim() : null;
  const ancestorResult =
    mergeHead === null
      ? null
      : spawnSync("git", ["merge-base", "--is-ancestor", mergeHead, baseRef], {
          cwd: REPO_ROOT,
          stdio: "ignore",
        });
  const mergeHeadIsBaseAncestor =
    ancestorResult !== null
      ? parseAncestorProbe(ancestorResult.status, ancestorResult.error)
      : false;

  return selectLocalComparisonBase(mergeBase, mergeHead, mergeHeadIsBaseAncestor);
}

function loadLocalDiff(): GrowthGuardrailDiff {
  const baseRef = process.env.NEMOCLAW_GROWTH_BASE_REF ?? "origin/main";
  execFileSync("git", ["rev-parse", "--verify", baseRef], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  const comparisonBase = resolveLocalComparisonBase(baseRef);

  const changed = execFileSync("git", ["diff", "--name-status", "-z", "-M", comparisonBase, "--"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const files = parseChangedFiles(changed);
  const known = new Set(files.map(({ filename }) => filename));
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  for (const filename of untracked.split("\0").filter(Boolean)) {
    if (!known.has(filename)) files.push({ filename, status: "added" });
  }
  const baseCache = new Map<string, string | null>();
  const headCache = new Map<string, string | null>();

  return {
    files,
    pullRequestNumber: null,
    exceptionPolicySource: "head",
    async readBase(paths) {
      return readFilesCached(paths, baseCache, (file) => readGitFile(comparisonBase, file));
    },
    async readHead(paths) {
      return readFilesCached(paths, headCache, readWorktreeFile);
    },
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment: ${name}`);
  return value;
}

function assertPullNumber(value: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("PR_NUMBER must be a positive integer");
}

function assertCommitSha(sha: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${label} must be a full commit SHA`);
}

function preparePullRequestTree(
  prNumber: string,
  expectedHeadSha: string,
  baseSha: string,
  repoRoot: string,
): string {
  const initialDepth = 32;
  const historyDepth = 1024;
  const timeout = 30_000;
  const git = (phase: string, args: string[]): string => {
    try {
      return execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout,
      }).trim();
    } catch (cause) {
      throw new Error(
        `PR #${prNumber}: growth comparison preparation failed during ${phase} ` +
          `(history limit ${historyDepth} commits, command limit ${timeout}ms).`,
        { cause },
      );
    }
  };
  const shallow = git("history inspection", ["rev-parse", "--is-shallow-repository"]);
  const fetchHistory = (depth: number): void => {
    if (shallow === "true") {
      git("trusted-base history fetch", [
        "fetch",
        "--no-tags",
        `--depth=${depth}`,
        "origin",
        baseSha,
      ]);
    }
    git("PR commit fetch", [
      "fetch",
      "--no-tags",
      `--depth=${depth}`,
      "origin",
      `refs/pull/${prNumber}/head`,
    ]);
    const fetchedHead = git("PR commit verification", ["rev-parse", "FETCH_HEAD"]);
    if (fetchedHead !== expectedHeadSha)
      throw new Error(`PR #${prNumber}: Fetched PR head does not match HEAD_SHA`);
  };
  fetchHistory(initialDepth);
  const mergeBase = spawnSync("git", ["merge-base", baseSha, expectedHeadSha], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
  });
  if (mergeBase.error || (mergeBase.status !== 0 && mergeBase.status !== 1)) {
    throw new Error(
      `PR #${prNumber}: growth comparison preparation failed during merge base inspection.`,
      {
        cause: mergeBase.error,
      },
    );
  }
  // Deepen once before rejecting a branch whose merge base is beyond the shallow fetch.
  if (mergeBase.status === 1) fetchHistory(historyDepth);
  // Merge candidate objects without checking out or executing candidate code.
  const mergedTree = git("merge tree construction", [
    "merge-tree",
    "--write-tree",
    "--no-messages",
    baseSha,
    expectedHeadSha,
  ]);
  if (!/^[0-9a-f]{40}$/.test(mergedTree))
    throw new Error(`PR #${prNumber}: Invalid prospective merge tree SHA`);
  return mergedTree;
}

/** Independent pull_request_target enforcement must never consume candidate policy. */
function pullRequestExceptionPolicySource(eventName: string | undefined): "base" | "head" {
  return eventName === "pull_request" ? "head" : "base";
}

function loadPullRequestDiff(repoRoot = REPO_ROOT): GrowthGuardrailDiff {
  const prNumber = requiredEnvironment("PR_NUMBER");
  const baseSha = requiredEnvironment("BASE_SHA");
  const headSha = requiredEnvironment("HEAD_SHA");
  assertPullNumber(prNumber);
  assertCommitSha(baseSha, "BASE_SHA");
  assertCommitSha(headSha, "HEAD_SHA");
  const mergedTree = preparePullRequestTree(prNumber, headSha, baseSha, repoRoot);
  const changed = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "-M", baseSha, mergedTree, "--"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  const baseCache = new Map<string, string | null>();
  const headCache = new Map<string, string | null>();

  return {
    files: parseChangedFiles(changed),
    pullRequestNumber: Number(prNumber),
    exceptionPolicySource: pullRequestExceptionPolicySource(process.env.GITHUB_EVENT_NAME),
    ...(["pull_request_target", "issue_comment"].includes(process.env.GITHUB_EVENT_NAME ?? "") &&
    process.env.GITHUB_REPOSITORY === "NVIDIA/NemoClaw"
      ? {
          async readBudgetApproval(digest: string) {
            return hasMaintainerBudgetApproval(Number(prNumber), digest);
          },
        }
      : {}),
    async readBase(paths) {
      return readFilesCached(paths, baseCache, (file) => readGitFile(baseSha, file, repoRoot));
    },
    async readHead(paths) {
      return readFilesCached(paths, headCache, (file) => readGitFile(mergedTree, file, repoRoot));
    },
  };
}

export function loadGrowthGuardrailDiff(): Promise<GrowthGuardrailDiff> {
  return Promise.resolve(process.env.PR_NUMBER ? loadPullRequestDiff() : loadLocalDiff());
}

export const testOnly = {
  loadPullRequestDiff,
  pullRequestExceptionPolicySource,
  parseAncestorProbe,
  parseChangedFiles,
  readFilesCached,
  selectLocalComparisonBase,
};
