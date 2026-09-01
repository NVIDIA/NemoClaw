// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type PullRequestFile = {
  readonly filename: string;
  readonly previous_filename?: string | null;
  readonly status?: string;
};

export type GrowthGuardrailDiff = {
  readonly files: readonly PullRequestFile[];
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

function readGitFile(ref: string, file: string): string | null {
  const result = spawnSync("git", ["show", `${ref}:${file}`], {
    cwd: REPO_ROOT,
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
  uniquePaths
    .filter((file) => !cache.has(file))
    .forEach((file) => cache.set(file, read(file)));
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

function fetchPullHead(prNumber: string, expectedHeadSha: string): void {
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", `refs/pull/${prNumber}/head`], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  const fetchedHead = execFileSync("git", ["rev-parse", "FETCH_HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (fetchedHead !== expectedHeadSha) throw new Error("Fetched PR head does not match HEAD_SHA");
}

function loadPullRequestDiff(): GrowthGuardrailDiff {
  const prNumber = requiredEnvironment("PR_NUMBER");
  const baseSha = requiredEnvironment("BASE_SHA");
  const headSha = requiredEnvironment("HEAD_SHA");
  assertPullNumber(prNumber);
  assertCommitSha(baseSha, "BASE_SHA");
  assertCommitSha(headSha, "HEAD_SHA");
  fetchPullHead(prNumber, headSha);
  const changed = execFileSync("git", ["diff", "--name-status", "-z", "-M", baseSha, headSha, "--"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const baseCache = new Map<string, string | null>();
  const headCache = new Map<string, string | null>();

  return {
    files: parseChangedFiles(changed),
    async readBase(paths) {
      return readFilesCached(paths, baseCache, (file) => readGitFile(baseSha, file));
    },
    async readHead(paths) {
      return readFilesCached(paths, headCache, (file) => readGitFile(headSha, file));
    },
  };
}

export function loadGrowthGuardrailDiff(): Promise<GrowthGuardrailDiff> {
  return Promise.resolve(process.env.PR_NUMBER ? loadPullRequestDiff() : loadLocalDiff());
}

export const testOnly = {
  parseAncestorProbe,
  parseChangedFiles,
  readFilesCached,
  selectLocalComparisonBase,
};
