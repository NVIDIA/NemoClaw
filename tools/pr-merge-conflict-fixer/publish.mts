#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type ConflictMatrixEntry, parseConflictMatrixEntry } from "./discover.mts";
import {
  applyResolutionPatch,
  ConflictFixerError,
  hasTreeChanges,
  prepareMerge,
  replaceWithTree,
  requireSha,
  samePaths,
  writeTree,
} from "./merge.mts";

type LivePullRequest = {
  base: {
    ref: string;
    repo: { full_name: string; node_id: string };
  };
  head: {
    ref: string;
    repo: { full_name: string } | null;
  };
  draft: boolean;
  state: string;
};

type LiveRef = {
  object: { sha: string };
};

type GitTreeEntry = {
  mode: string;
  path: string;
  sha: string | null;
  type: "blob" | "commit";
};

type GitHubRequest = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;

type GraphqlRequest = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConflictFixerError(`${name} is required`);
  return value;
}

export function validatePublicationState(
  entry: ConflictMatrixEntry,
  repository: string,
  pullRequest: LivePullRequest,
  mainRef: LiveRef,
): void {
  if (pullRequest.state !== "open") throw new ConflictFixerError("The pull request is not open");
  if (pullRequest.draft) throw new ConflictFixerError("The pull request is a draft");
  if (pullRequest.base.ref !== "main") {
    throw new ConflictFixerError("The pull request no longer targets main");
  }
  if (
    pullRequest.base.repo.full_name !== repository ||
    pullRequest.head.repo?.full_name !== repository
  ) {
    throw new ConflictFixerError("The pull request is not a same-repository pull request");
  }
  if (pullRequest.head.ref !== entry.head_ref) {
    throw new ConflictFixerError("The pull request head ref changed after the scan");
  }
  if (mainRef.object.sha !== entry.base_sha) {
    throw new ConflictFixerError("main changed after the scan");
  }
}

export function validateResolutionPatch(input: {
  entry: ConflictMatrixEntry;
  patchPath: string;
  sourceRepository: string;
  workDirectory: string;
}): {
  finalTree: string;
  repository: string;
} {
  const merge = prepareMerge(
    input.sourceRepository,
    input.workDirectory,
    input.entry.head_sha,
    input.entry.base_sha,
  );
  if (!merge) throw new ConflictFixerError("The recorded revisions no longer conflict");
  if (!samePaths(merge.conflictPaths, input.entry.conflict_paths)) {
    throw new ConflictFixerError("The conflict paths do not match the scan result");
  }

  replaceWithTree(merge.repository, merge.conflictTree);
  applyResolutionPatch(merge.repository, input.patchPath);
  const finalTree = writeTree(merge.repository);
  if (hasTreeChanges(merge.repository, merge.conflictTree, finalTree, ".github/workflows")) {
    throw new ConflictFixerError("The resolution patch changes GitHub workflows");
  }
  return { finalTree, repository: merge.repository };
}

function gitBuffer(repository: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, {
    cwd: repository,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function changedPathStatuses(
  repository: string,
  fromTree: string,
  toTree: string,
): Array<{ path: string; status: string }> {
  const fields = gitBuffer(repository, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    fromTree,
    toTree,
  ])
    .toString("utf8")
    .split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) {
    throw new ConflictFixerError("Git returned an invalid changed-path list");
  }
  const results: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const filePath = fields[index + 1];
    if (!status || !filePath || !/^[ADMT]$/u.test(status)) {
      throw new ConflictFixerError(`Git returned an unsupported tree change status: ${status}`);
    }
    results.push({ path: filePath, status });
  }
  return results;
}

function optionalTreeEntry(
  repository: string,
  tree: string,
  filePath: string,
): GitTreeEntry | null {
  const output = gitBuffer(repository, ["ls-tree", "-z", tree, "--", filePath]).toString("utf8");
  if (!output) return null;
  const separator = output.indexOf("\t");
  if (separator < 0) throw new ConflictFixerError(`Git tree does not contain ${filePath}`);
  const [mode, type, sha] = output.slice(0, separator).split(" ");
  if (!mode || (type !== "blob" && type !== "commit") || !sha || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new ConflictFixerError(`Git returned an invalid tree entry for ${filePath}`);
  }
  return { mode, path: filePath, sha, type };
}

function treeEntry(repository: string, tree: string, filePath: string): GitTreeEntry {
  const entry = optionalTreeEntry(repository, tree, filePath);
  if (!entry) throw new ConflictFixerError(`Git tree does not contain ${filePath}`);
  return entry;
}

function parentContainsBlob(repository: string, parent: string, entry: GitTreeEntry): boolean {
  const parentEntry = optionalTreeEntry(repository, parent, entry.path);
  return parentEntry?.type === "blob" && parentEntry.sha === entry.sha;
}

async function createGitHubTree(input: {
  baseSha: string;
  finalTree: string;
  headSha: string;
  repository: string;
  repositoryName: string;
  request: GitHubRequest;
}): Promise<string> {
  const entries: GitTreeEntry[] = [];
  for (const change of changedPathStatuses(input.repository, input.baseSha, input.finalTree)) {
    const sourceTree = change.status === "D" ? input.baseSha : input.finalTree;
    const entry = treeEntry(input.repository, sourceTree, change.path);
    if (change.status === "D") {
      entries.push({ ...entry, sha: null });
      continue;
    }
    if (
      entry.type === "blob" &&
      !parentContainsBlob(input.repository, input.headSha, entry) &&
      !parentContainsBlob(input.repository, input.baseSha, entry)
    ) {
      const content = gitBuffer(input.repository, ["cat-file", "blob", entry.sha ?? ""]);
      const created = (await input.request("POST", `/repos/${input.repositoryName}/git/blobs`, {
        content: content.toString("base64"),
        encoding: "base64",
      })) as { sha?: string };
      if (created.sha !== entry.sha) {
        throw new ConflictFixerError(`GitHub returned an unexpected blob SHA for ${entry.path}`);
      }
    }
    entries.push(entry);
  }

  const created = (await input.request("POST", `/repos/${input.repositoryName}/git/trees`, {
    base_tree: input.baseSha,
    tree: entries,
  })) as { sha?: string };
  if (created.sha !== input.finalTree) {
    throw new ConflictFixerError("GitHub returned a tree that differs from the validated tree");
  }
  return input.finalTree;
}

async function publishValidatedTree(input: {
  entry: ConflictMatrixEntry;
  finalTree: string;
  graphql: GraphqlRequest;
  pullRequest: LivePullRequest;
  repository: string;
  repositoryName: string;
  request: GitHubRequest;
}): Promise<string> {
  const tree = await createGitHubTree({
    baseSha: input.entry.base_sha,
    finalTree: input.finalTree,
    headSha: input.entry.head_sha,
    repository: input.repository,
    repositoryName: input.repositoryName,
    request: input.request,
  });
  const commit = (await input.request("POST", `/repos/${input.repositoryName}/git/commits`, {
    message: "merge: resolve conflicts with main",
    parents: [input.entry.head_sha, input.entry.base_sha],
    tree,
  })) as {
    sha?: string;
    verification?: { reason?: string; verified?: boolean };
  };
  const commitSha = requireSha(commit.sha ?? "", "created commit SHA");
  if (commit.verification?.verified !== true) {
    throw new ConflictFixerError(
      `GitHub did not verify the merge commit: ${commit.verification?.reason ?? "unknown reason"}`,
    );
  }

  const clientMutationId = commitSha;
  const mutation = `
    mutation UpdateConflictFixerRef($input: UpdateRefsInput!) {
      updateRefs(input: $input) {
        clientMutationId
      }
    }
  `;
  const result = (await input.graphql(mutation, {
    input: {
      clientMutationId,
      refUpdates: [
        {
          afterOid: commitSha,
          beforeOid: input.entry.head_sha,
          force: false,
          name: `refs/heads/${input.entry.head_ref}`,
        },
      ],
      repositoryId: input.pullRequest.base.repo.node_id,
    },
  })) as {
    updateRefs?: { clientMutationId?: string };
  };
  if (result.updateRefs?.clientMutationId !== clientMutationId) {
    throw new ConflictFixerError("GitHub did not confirm the atomic PR branch update");
  }
  return commitSha;
}

function githubClient(token: string): { graphql: GraphqlRequest; request: GitHubRequest } {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const parse = async (response: Response): Promise<unknown> => {
    const body = (await response.json()) as {
      data?: unknown;
      errors?: Array<{ message?: string }>;
      message?: string;
    };
    if (!response.ok || body.errors?.length) {
      const message =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") ||
        body.message ||
        `HTTP ${response.status}`;
      throw new ConflictFixerError(`GitHub API request failed: ${message}`);
    }
    return body.data ?? body;
  };
  return {
    graphql: async (query, variables) =>
      parse(
        await fetch("https://api.github.com/graphql", {
          body: JSON.stringify({ query, variables }),
          headers,
          method: "POST",
        }),
      ),
    request: async (method, apiPath, body) =>
      parse(
        await fetch(`https://api.github.com${apiPath}`, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers,
          method,
        }),
      ),
  };
}

export async function publishResolution(input: {
  entry: ConflictMatrixEntry;
  graphql: GraphqlRequest;
  patchPath: string;
  repositoryName: string;
  request: GitHubRequest;
  sourceRepository: string;
}): Promise<string> {
  const pullRequest = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/pulls/${input.entry.pr_number}`,
  )) as LivePullRequest;
  const mainRef = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/git/ref/heads/main`,
  )) as LiveRef;
  validatePublicationState(input.entry, input.repositoryName, pullRequest, mainRef);

  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "nemoclaw-publish-"));
  try {
    const validated = validateResolutionPatch({
      entry: input.entry,
      patchPath: input.patchPath,
      sourceRepository: input.sourceRepository,
      workDirectory: path.join(temporaryDirectory, "repository"),
    });
    return await publishValidatedTree({
      entry: input.entry,
      finalTree: validated.finalTree,
      graphql: input.graphql,
      pullRequest,
      repository: validated.repository,
      repositoryName: input.repositoryName,
      request: input.request,
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const entry = parseConflictMatrixEntry(required(process.env.MATRIX_ENTRY, "MATRIX_ENTRY"));
  const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const repositoryName = required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const artifactDirectory = required(process.env.ARTIFACT_DIR, "ARTIFACT_DIR");
  const patchPath = path.join(artifactDirectory, "resolution.patch");
  const client = githubClient(token);
  const commitSha = await publishResolution({
    entry,
    graphql: client.graphql,
    patchPath,
    repositoryName,
    request: client.request,
    sourceRepository: required(process.env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
  });
  console.log(`Published verified merge commit ${commitSha} to ${entry.head_ref}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
