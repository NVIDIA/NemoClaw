// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertRepositoryName, createPrBlobClient, type PullRequestFile } from "./pr-blob-client";

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

function readFiles(
  paths: readonly string[],
  read: (file: string) => string | null,
): ReadonlyMap<string, string | null> {
  return new Map([...new Set(paths)].map((file) => [file, read(file)]));
}

function loadLocalDiff(): GrowthGuardrailDiff {
  const baseRef = process.env.NEMOCLAW_GROWTH_BASE_REF ?? "origin/main";
  execFileSync("git", ["rev-parse", "--verify", baseRef], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

  const changed = execFileSync("git", ["diff", "--name-status", "-z", "-M", mergeBase, "--"], {
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

  return {
    files,
    async readBase(paths) {
      return readFiles(paths, (file) => readGitFile(mergeBase, file));
    },
    async readHead(paths) {
      return readFiles(paths, readWorktreeFile);
    },
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment: ${name}`);
  return value;
}

async function loadPullRequestDiff(): Promise<GrowthGuardrailDiff> {
  const token = requiredEnvironment("GH_TOKEN");
  const repository = requiredEnvironment("REPO");
  const prNumber = requiredEnvironment("PR_NUMBER");
  const baseSha = requiredEnvironment("BASE_SHA");
  const headRepository = requiredEnvironment("HEAD_REPO");
  const headSha = requiredEnvironment("HEAD_SHA");
  assertRepositoryName(repository, "REPO");
  assertRepositoryName(headRepository, "HEAD_REPO");
  const client = createPrBlobClient({ token });
  const files = await client.getPullFiles(repository, prNumber);

  return {
    files,
    readBase(paths) {
      return client.fetchBlobs(repository, baseSha, paths);
    },
    readHead(paths) {
      return client.fetchBlobs(headRepository, headSha, paths);
    },
  };
}

export function loadGrowthGuardrailDiff(): Promise<GrowthGuardrailDiff> {
  return process.env.NEMOCLAW_GROWTH_PR === "1"
    ? loadPullRequestDiff()
    : Promise.resolve(loadLocalDiff());
}

export const testOnly = { parseChangedFiles };
