#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ConflictFixerError, hasTreeChanges, prepareMerge, requireSha } from "./merge.mts";

export type PullRequest = {
  base: { ref: string };
  draft: boolean;
  head: {
    ref: string;
    repo: { full_name: string } | null;
    sha: string;
  };
  number: number;
  state: string;
};

export type ConflictMatrixEntry = {
  base_sha: string;
  conflict_paths: string[];
  head_ref: string;
  head_sha: string;
  pr_number: number;
};

export function parseConflictMatrixEntry(value: string): ConflictMatrixEntry {
  const parsed = JSON.parse(value) as ConflictMatrixEntry;
  if (
    !parsed ||
    !Number.isInteger(parsed.pr_number) ||
    parsed.pr_number < 1 ||
    typeof parsed.head_ref !== "string" ||
    !Array.isArray(parsed.conflict_paths) ||
    !parsed.conflict_paths.every((item) => typeof item === "string")
  ) {
    throw new ConflictFixerError("MATRIX_ENTRY is invalid");
  }
  requireSha(parsed.head_sha, "PR head SHA");
  requireSha(parsed.base_sha, "base SHA");
  return parsed;
}

export type ConflictInspection = {
  conflictPaths: string[];
  updatesWorkflow: boolean;
};

type DiscoverOptions = {
  checkConflict?: (pullRequest: PullRequest, baseSha: string) => ConflictInspection | null;
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConflictFixerError(`${name} is required`);
  return value;
}

export function eligibleSameRepositoryPullRequests(
  pullRequests: readonly PullRequest[],
  repository: string,
): PullRequest[] {
  return pullRequests.filter(
    (pullRequest) =>
      pullRequest.state === "open" &&
      !pullRequest.draft &&
      pullRequest.base.ref === "main" &&
      pullRequest.head.repo?.full_name === repository,
  );
}

export function selectConflictingPullRequests(
  pullRequests: readonly PullRequest[],
  repository: string,
  baseShaInput: string,
  options: DiscoverOptions = {},
): ConflictMatrixEntry[] {
  const baseSha = requireSha(baseShaInput, "base SHA");
  const checkConflict =
    options.checkConflict ??
    (() => {
      throw new ConflictFixerError("checkConflict is required");
    });

  return eligibleSameRepositoryPullRequests(pullRequests, repository).flatMap((pullRequest) => {
    const conflict = checkConflict(pullRequest, baseSha);
    if (!conflict) return [];
    if (conflict.updatesWorkflow) {
      console.warn(
        `Skipping PR #${pullRequest.number}: its merge changes .github/workflows; resolve it manually.`,
      );
      return [];
    }
    return [
      {
        base_sha: baseSha,
        conflict_paths: conflict.conflictPaths,
        head_ref: pullRequest.head.ref,
        head_sha: requireSha(pullRequest.head.sha, "PR head SHA"),
        pr_number: pullRequest.number,
      },
    ];
  });
}

async function listOpenPullRequests(
  repository: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<PullRequest[]> {
  const pullRequests: PullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request(
      `https://api.github.com/repos/${repository}/pulls?state=open&base=main&per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new ConflictFixerError(
        `GitHub pull request listing failed with HTTP ${response.status}`,
      );
    }
    const pageItems = (await response.json()) as PullRequest[];
    pullRequests.push(...pageItems);
    if (pageItems.length < 100) return pullRequests;
  }
}

export async function discoverConflicts(env = process.env): Promise<ConflictMatrixEntry[]> {
  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const baseSha = requireSha(required(env.GITHUB_SHA, "GITHUB_SHA"), "GITHUB_SHA");
  const token = required(env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const sourceRepository = required(env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE");
  const pullRequests = await listOpenPullRequests(repository, token);

  return selectConflictingPullRequests(pullRequests, repository, baseSha, {
    checkConflict: (pullRequest) => {
      const temporaryDirectory = mkdtempSync(
        path.join(tmpdir(), `nemoclaw-pr-${pullRequest.number}-`),
      );
      const mergeRepository = path.join(temporaryDirectory, "repository");
      try {
        return inspectConflict(sourceRepository, mergeRepository, pullRequest.head.sha, baseSha);
      } finally {
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
  });
}

export function inspectConflict(
  sourceRepository: string,
  mergeRepository: string,
  headSha: string,
  baseSha: string,
): ConflictInspection | null {
  const merge = prepareMerge(sourceRepository, mergeRepository, headSha, baseSha);
  return merge
    ? {
        conflictPaths: merge.conflictPaths,
        updatesWorkflow: hasTreeChanges(
          merge.repository,
          merge.headSha,
          merge.conflictTree,
          ".github/workflows",
        ),
      }
    : null;
}

async function main(): Promise<void> {
  const outputPath = required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  const entries = await discoverConflicts();
  appendFileSync(
    outputPath,
    `count=${entries.length}\nmatrix=${JSON.stringify({ include: entries.map((item) => ({ item })) })}\n`,
  );
  console.log(`Selected ${entries.length} conflicting same-repository pull request(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
