#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAllowedDocumentationPath, PostMergeDocsError, requireSha } from "./artifact.mts";
import {
  BOT_LOGIN,
  BOT_SIGN_OFF,
  parseRetirementPendingMarker,
  parseRetiredEmptyMarker,
  PR_BODY_MAX_BYTES,
  ROLLING_BRANCH,
  ROLLING_TITLE,
  validateManagedBlock,
} from "./contract.mts";
import { HARDENED_GIT_ENV, hardenedGitArgs, mergeTreeSha, prepareCombinedBase } from "./base.mts";

type Request = (method: "GET", path: string) => Promise<unknown>;
type Pull = {
  author_association?: string;
  base: { ref: string; repo: { full_name: string } };
  body: string | null;
  head: { ref: string; repo: { full_name: string } | null; sha: string };
  merged_at: string | null;
  merge_commit_sha: string | null;
  number: number;
  state: string;
  user: { login: string } | null;
};

export type Discovery = {
  rangeStartTag: string;
  rangeStartSha: string;
  rollingHeadSha: string | null;
  rollingPrNumber: number | null;
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new PostMergeDocsError(`${name} is required`);
  return value;
}

function semver(value: string): [number, number, number] | null {
  const match = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(value);
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as [
    number,
    number,
    number,
  ];
  return version.every(Number.isSafeInteger) ? version : null;
}

export function latestReachableSemverTag(
  repository: string,
  mainSha: string,
): {
  tag: string;
  sha: string;
} {
  requireSha(mainSha, "main SHA");
  const tags = execFileSync("git", hardenedGitArgs(["tag", "--merged", mainSha]), {
    cwd: repository,
    encoding: "utf8",
    env: HARDENED_GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((tag) => {
      const version = semver(tag);
      return version ? [{ tag, version }] : [];
    })
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        const delta = right.version[index] - left.version[index];
        if (delta !== 0) return delta;
      }
      return 0;
    });
  const selected = tags[0];
  if (!selected) throw new PostMergeDocsError("main has no reachable exact semver tag");
  const tagType = execFileSync("git", hardenedGitArgs(["cat-file", "-t", selected.tag]), {
    cwd: repository,
    encoding: "utf8",
    env: HARDENED_GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (tagType !== "tag")
    throw new PostMergeDocsError("latest reachable semver tag must be annotated");
  const sha = requireSha(
    execFileSync("git", hardenedGitArgs(["rev-list", "-n", "1", selected.tag]), {
      cwd: repository,
      encoding: "utf8",
      env: HARDENED_GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
    "peeled semver tag SHA",
  );
  return { tag: selected.tag, sha };
}

function isAncestor(repository: string, ancestor: string, descendant: string): boolean {
  return (
    spawnSync("git", hardenedGitArgs(["merge-base", "--is-ancestor", ancestor, descendant]), {
      cwd: repository,
      env: HARDENED_GIT_ENV,
      stdio: "ignore",
    }).status === 0
  );
}

export function validatePendingRetirementTree(input: {
  sourceRepository: string;
  pendingMainSha: string;
  rollingHeadSha: string;
  currentMainSha: string;
}): { mainTreeSha: string } {
  const pendingMainSha = requireSha(input.pendingMainSha, "pending retirement main SHA");
  const rollingHeadSha = requireSha(input.rollingHeadSha, "pending retirement head SHA");
  const currentMainSha = requireSha(input.currentMainSha, "current main SHA");
  if (!isAncestor(input.sourceRepository, pendingMainSha, currentMainSha)) {
    throw new PostMergeDocsError(
      "closed pending retirement main is not an ancestor of current main",
    );
  }
  const mainTreeSha = requireSha(
    execFileSync("git", hardenedGitArgs(["rev-parse", `${pendingMainSha}^{tree}`]), {
      cwd: input.sourceRepository,
      encoding: "utf8",
      env: HARDENED_GIT_ENV,
    }).trim(),
    "pending retirement main tree",
  );
  const rollingTreeSha = requireSha(
    execFileSync("git", hardenedGitArgs(["rev-parse", `${rollingHeadSha}^{tree}`]), {
      cwd: input.sourceRepository,
      encoding: "utf8",
      env: HARDENED_GIT_ENV,
    }).trim(),
    "pending retirement rolling tree",
  );
  const reconstructedTreeSha = mergeTreeSha(input.sourceRepository, rollingHeadSha, pendingMainSha);
  if (rollingTreeSha !== mainTreeSha || reconstructedTreeSha !== mainTreeSha) {
    throw new PostMergeDocsError(
      "closed pending retirement tree does not match its reviewed main commit",
    );
  }
  return { mainTreeSha };
}

function localManagedTreeIsDocumentationOnly(
  repository: string,
  baseTree: string,
  rollingHeadSha: string,
): boolean {
  try {
    const output = execFileSync(
      "git",
      hardenedGitArgs(["diff", "--name-only", "--no-renames", "-z", baseTree, rollingHeadSha]),
      { cwd: repository, env: HARDENED_GIT_ENV },
    );
    const paths = output.toString("utf8").split("\0").filter(Boolean);
    if (paths.some((file) => !isAllowedDocumentationPath(file))) return false;
    return paths.every((file) => {
      const entry = execFileSync("git", hardenedGitArgs(["ls-tree", rollingHeadSha, "--", file]), {
        cwd: repository,
        encoding: "utf8",
        env: HARDENED_GIT_ENV,
      }).trim();
      return entry === "" || entry.startsWith("100644 blob ");
    });
  } catch {
    return false;
  }
}

function validateOpenPull(pull: Pull, repository: string, rollingHeadSha: string): void {
  if (
    pull.state !== "open" ||
    pull.base.ref !== "main" ||
    pull.base.repo.full_name !== repository ||
    pull.head.ref !== ROLLING_BRANCH ||
    pull.head.repo?.full_name !== repository ||
    pull.head.sha !== rollingHeadSha ||
    pull.user?.login !== BOT_LOGIN ||
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    Buffer.byteLength(pull.body ?? "", "utf8") > PR_BODY_MAX_BYTES
  ) {
    throw new PostMergeDocsError(
      "open rolling documentation PR does not match the trusted identity",
    );
  }
  try {
    validateManagedBlock(pull.body ?? "");
  } catch (error) {
    throw new PostMergeDocsError(error instanceof Error ? error.message : String(error));
  }
}

function findPendingRetirement(input: {
  pulls: Pull[];
  repository: string;
  sourceRepository: string;
  rollingHeadSha: string;
  currentMainSha: string;
}): Pull | null {
  const pendingPulls = input.pulls.filter((pull) =>
    (pull.body ?? "").includes("nemoclaw-post-merge-docs:retirement-pending"),
  );
  if (pendingPulls.length > 1) {
    throw new PostMergeDocsError("ambiguous pending retirement for the rolling branch");
  }
  const pendingPull = pendingPulls[0];
  if (!pendingPull) return null;
  if (input.pulls[0]?.number !== pendingPull.number) {
    throw new PostMergeDocsError("ambiguous pending retirement is not the latest rolling PR");
  }
  if (pendingPull.state !== "closed" || pendingPull.merged_at !== null) {
    throw new PostMergeDocsError("pending retirement is not closed without merge");
  }
  validateOpenPull({ ...pendingPull, state: "open" }, input.repository, input.rollingHeadSha);
  const marker = parseRetirementPendingMarker(pendingPull.body ?? "");
  if (!marker) {
    throw new PostMergeDocsError("closed pending retirement marker is malformed");
  }
  if (marker.headSha !== input.rollingHeadSha) {
    throw new PostMergeDocsError("closed pending retirement does not match the rolling branch");
  }
  validatePendingRetirementTree({
    sourceRepository: input.sourceRepository,
    pendingMainSha: marker.mainSha,
    rollingHeadSha: marker.headSha,
    currentMainSha: input.currentMainSha,
  });
  return pendingPull;
}

export async function discoverState(input: {
  repository: string;
  mainSha: string;
  sourceRepository: string;
  request: Request;
}): Promise<Discovery> {
  const mainSha = requireSha(input.mainSha, "exact main SHA");
  const liveMain = (await input.request(
    "GET",
    `/repos/${input.repository}/git/ref/heads/main`,
  )) as { object?: { sha?: string } };
  if (requireSha(liveMain.object?.sha ?? "", "live main SHA") !== mainSha) {
    throw new PostMergeDocsError("exact main commit is stale");
  }
  const range = latestReachableSemverTag(input.sourceRepository, mainSha);
  const branch = (await input.request(
    "GET",
    `/repos/${input.repository}/git/ref/heads/${ROLLING_BRANCH}`,
  )) as { object?: { sha?: string } } | null;
  const rollingHeadSha = branch ? requireSha(branch.object?.sha ?? "", "rolling branch SHA") : null;
  const pullHead = encodeURIComponent(`${input.repository.split("/")[0]}:${ROLLING_BRANCH}`);
  const openPulls = (await input.request(
    "GET",
    `/repos/${input.repository}/pulls?state=open&base=main&head=${pullHead}&per_page=100`,
  )) as Pull[];
  if (!Array.isArray(openPulls)) {
    throw new PostMergeDocsError("GitHub returned an invalid open rolling PR list");
  }
  const open = openPulls.filter((pull) => pull.state === "open");
  if (open.length > 1) {
    throw new PostMergeDocsError("more than one rolling documentation PR is open");
  }
  const pulls = (await input.request(
    "GET",
    `/repos/${input.repository}/pulls?state=all&base=main&head=${pullHead}&per_page=100&sort=created&direction=desc`,
  )) as Pull[];
  if (!Array.isArray(pulls))
    throw new PostMergeDocsError("GitHub returned an invalid rolling PR list");
  if (!open[0] && pulls.some((pull) => pull.state === "open")) {
    throw new PostMergeDocsError("rolling documentation PR state changed during discovery");
  }
  if (open[0]) {
    if (!rollingHeadSha) throw new PostMergeDocsError("rolling PR exists without its branch");
    validateOpenPull(open[0], input.repository, rollingHeadSha);
    return {
      rangeStartTag: range.tag,
      rangeStartSha: range.sha,
      rollingHeadSha,
      rollingPrNumber: open[0].number,
    };
  }
  if (rollingHeadSha) {
    const pendingRetirement = findPendingRetirement({
      pulls,
      repository: input.repository,
      sourceRepository: input.sourceRepository,
      rollingHeadSha,
      currentMainSha: mainSha,
    });
    if (pendingRetirement) {
      return {
        rangeStartTag: range.tag,
        rangeStartSha: range.sha,
        rollingHeadSha,
        rollingPrNumber: pendingRetirement.number,
      };
    }
    const rollingTree = execFileSync(
      "git",
      hardenedGitArgs(["rev-parse", `${rollingHeadSha}^{tree}`]),
      { cwd: input.sourceRepository, encoding: "utf8", env: HARDENED_GIT_ENV },
    ).trim();
    const mainTree = execFileSync("git", hardenedGitArgs(["rev-parse", `${mainSha}^{tree}`]), {
      cwd: input.sourceRepository,
      encoding: "utf8",
      env: HARDENED_GIT_ENV,
    }).trim();
    if (rollingTree === mainTree) {
      const latestForHead = pulls.find((pull) => pull.head.sha === rollingHeadSha);
      if (latestForHead?.state === "closed" && latestForHead.merged_at === null) {
        validateOpenPull({ ...latestForHead, state: "open" }, input.repository, rollingHeadSha);
        const retired = parseRetiredEmptyMarker(latestForHead.body ?? "");
        if (retired && retired.mainSha === mainSha && retired.headSha === rollingHeadSha) {
          return {
            rangeStartTag: range.tag,
            rangeStartSha: range.sha,
            rollingHeadSha,
            rollingPrNumber: null,
          };
        }
      }
      return {
        rangeStartTag: range.tag,
        rangeStartSha: range.sha,
        rollingHeadSha,
        rollingPrNumber: null,
      };
    }
  }
  if (rollingHeadSha) {
    if (pulls[0]?.state === "closed" && !pulls[0].merged_at) {
      const retiredHeadSha = requireSha(pulls[0].head.sha, "retired rolling PR head SHA");
      validateOpenPull({ ...pulls[0], state: "open" }, input.repository, retiredHeadSha);
      const marker = parseRetiredEmptyMarker(pulls[0].body ?? "");
      let equalTrees = false;
      if (marker) {
        try {
          const reconstructedTree = mergeTreeSha(
            input.sourceRepository,
            marker.headSha,
            marker.mainSha,
          );
          const mainTree = execFileSync(
            "git",
            hardenedGitArgs(["rev-parse", `${marker.mainSha}^{tree}`]),
            { cwd: input.sourceRepository, encoding: "utf8", env: HARDENED_GIT_ENV },
          ).trim();
          equalTrees = reconstructedTree === mainTree;
        } catch {
          equalTrees = false;
        }
      }
      if (
        !marker ||
        marker.headSha !== retiredHeadSha ||
        !equalTrees ||
        !isAncestor(input.sourceRepository, marker.mainSha, mainSha)
      ) {
        throw new PostMergeDocsError(
          "the latest rolling documentation PR was closed without merge",
        );
      }
      if (rollingHeadSha === retiredHeadSha) {
        return {
          rangeStartTag: range.tag,
          rangeStartSha: range.sha,
          rollingHeadSha,
          rollingPrNumber: null,
        };
      }
    }
    const retired = pulls.find((pull) => pull.head.sha === rollingHeadSha);
    if (retired) validateOpenPull({ ...retired, state: "open" }, input.repository, rollingHeadSha);
    if (retired && !retired.merged_at) {
      throw new PostMergeDocsError("the rolling documentation PR was closed without merge");
    }
    if (
      !retired?.merged_at ||
      !retired.merge_commit_sha ||
      !isAncestor(input.sourceRepository, retired.merge_commit_sha, mainSha)
    ) {
      const commit = (await input.request(
        "GET",
        `/repos/${input.repository}/commits/${rollingHeadSha}`,
      )) as {
        author?: { login?: string };
        committer?: { login?: string };
        commit?: {
          author?: { name?: string; email?: string };
          committer?: { name?: string; email?: string };
          message?: string;
          verification?: { verified?: boolean };
          tree?: { sha?: string };
        };
        parents?: Array<{ sha?: string }>;
      };
      const parents = commit.parents?.map((parent) => parent.sha ?? "") ?? [];
      const parentShape =
        (parents.length === 1 || parents.length === 2) &&
        parents.every((parent) => /^[0-9a-f]{40}$/u.test(parent));
      let baseTree: string | null = null;
      if (parentShape && parents.length === 1) {
        baseTree = execFileSync("git", hardenedGitArgs(["rev-parse", `${parents[0]}^{tree}`]), {
          cwd: input.sourceRepository,
          encoding: "utf8",
          env: HARDENED_GIT_ENV,
        }).trim();
      } else if (parentShape && parents.length === 2) {
        const temporary = fs.mkdtempSync(
          path.join(process.env.RUNNER_TEMP ?? "/tmp", "docs-orphan-"),
        );
        try {
          baseTree = prepareCombinedBase({
            sourceRepository: input.sourceRepository,
            destination: path.join(temporary, "repo"),
            rollingHeadSha: parents[0],
            mainSha: parents[1],
          }).baseTreeSha;
        } finally {
          fs.rmSync(temporary, { force: true, recursive: true });
        }
      }
      const managedOrphan =
        commit.author?.login === BOT_LOGIN &&
        commit.committer?.login === "web-flow" &&
        commit.commit?.author?.name === BOT_LOGIN &&
        commit.commit.author.email === "41898282+github-actions[bot]@users.noreply.github.com" &&
        commit.commit.committer?.name === "GitHub" &&
        commit.commit.committer.email === "noreply@github.com" &&
        commit.commit?.verification?.verified === true &&
        commit.commit.message === `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}` &&
        commit.commit.tree?.sha ===
          execFileSync("git", hardenedGitArgs(["rev-parse", `${rollingHeadSha}^{tree}`]), {
            cwd: input.sourceRepository,
            encoding: "utf8",
            env: HARDENED_GIT_ENV,
          }).trim() &&
        baseTree !== null &&
        localManagedTreeIsDocumentationOnly(input.sourceRepository, baseTree, rollingHeadSha);
      if (!managedOrphan) {
        throw new PostMergeDocsError(
          "rolling branch has no trusted open, merged, or recoverable managed PR state",
        );
      }
    }
  }
  return {
    rangeStartTag: range.tag,
    rangeStartSha: range.sha,
    rollingHeadSha,
    rollingPrNumber: null,
  };
}

function client(token: string): Request {
  return async (_method, apiPath) => {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status === 404) return null;
    const body = (await response.json()) as { message?: string };
    if (!response.ok)
      throw new PostMergeDocsError(`GitHub API request failed: ${body.message ?? response.status}`);
    return body;
  };
}

async function main(): Promise<void> {
  const output = required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  const result = await discoverState({
    repository: required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    mainSha: required(process.env.GITHUB_SHA, "GITHUB_SHA"),
    sourceRepository: required(process.env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
    request: client(required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN")),
  });
  fs.appendFileSync(
    output,
    [
      `range_start_tag=${result.rangeStartTag}`,
      `range_start_sha=${result.rangeStartSha}`,
      `rolling_head_sha=${result.rollingHeadSha ?? ""}`,
      `rolling_pr_number=${result.rollingPrNumber ?? ""}`,
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
