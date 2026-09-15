// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  createGitHubTree,
  createVerifiedCommit,
  updateVerifiedRef,
} from "../../../tools/pull-requests/publication.mts";

const temporaryDirectories: string[] = [];
const git = (repository: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
  temporaryDirectories.length = 0;
});

it("rejects non-regular file modes before publishing a tree (#7542)", async () => {
  const repository = mkdtempSync(path.join(tmpdir(), "nemoclaw-publication-test-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Publication Test"]);
  git(repository, ["config", "user.email", "publication@example.test"]);
  const file = path.join(repository, "example.txt");
  writeFileSync(file, "content\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "test: add regular file"]);
  const headSha = git(repository, ["rev-parse", "HEAD"]);
  chmodSync(file, 0o755);
  git(repository, ["add", "example.txt"]);
  const finalTree = git(repository, ["write-tree"]);
  const request = vi.fn();

  await expect(
    createGitHubTree({
      baseSha: headSha,
      finalTree,
      headSha,
      repository,
      repositoryName: "NVIDIA/NemoClaw",
      request,
    }),
  ).rejects.toThrow("unsupported regular-file mode");
  expect(request).not.toHaveBeenCalled();
});

it("creates one-parent content-addressed commits only after GitHub verification (#10791)", async () => {
  const repository = mkdtempSync(path.join(tmpdir(), "nemoclaw-publication-test-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Publication Test"]);
  git(repository, ["config", "user.email", "publication@example.test"]);
  const file = path.join(repository, "example.txt");
  writeFileSync(file, "before\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "test: add regular file"]);
  const headSha = git(repository, ["rev-parse", "HEAD"]);
  writeFileSync(file, "after\n");
  git(repository, ["add", "example.txt"]);
  const finalTree = git(repository, ["write-tree"]);
  const blobSha = git(repository, ["rev-parse", ":example.txt"]);
  const commitSha = "c".repeat(40);
  const request = vi
    .fn()
    .mockResolvedValueOnce({ sha: blobSha })
    .mockResolvedValueOnce({ sha: finalTree })
    .mockResolvedValueOnce({ sha: commitSha })
    .mockResolvedValueOnce({
      sha: commitSha,
      verification: { verified: false, reason: "unsigned" },
    })
    .mockResolvedValueOnce({
      sha: commitSha,
      verification: { verified: true, reason: "valid" },
    });
  const sleep = vi.fn(async () => {});

  await expect(
    createVerifiedCommit({
      finalTree,
      headSha,
      message: "fix: repair exact finding",
      repository,
      repositoryName: "NVIDIA/NemoClaw",
      request,
      sleep,
    }),
  ).resolves.toBe(commitSha);
  expect(request).toHaveBeenCalledTimes(5);
  expect(request.mock.calls[2]).toEqual([
    "POST",
    "/repos/NVIDIA/NemoClaw/git/commits",
    expect.objectContaining({ parents: [headSha], tree: finalTree }),
  ]);
  expect(sleep).toHaveBeenCalledOnce();
});

it("updates the PR ref with an exact non-force compare-and-swap (#10791)", async () => {
  const commitSha = "c".repeat(40);
  const headSha = "a".repeat(40);
  const graphql = vi.fn(async (_query: string, variables: Record<string, unknown>) => ({
    updateRefs: {
      clientMutationId: (variables.input as { clientMutationId: string }).clientMutationId,
    },
  }));

  await updateVerifiedRef({
    commitSha,
    graphql,
    headRef: "fix/example",
    headSha,
    repositoryId: "R_repo",
  });

  expect(graphql).toHaveBeenCalledWith(
    expect.stringContaining("updateRefs"),
    expect.objectContaining({
      input: {
        clientMutationId: commitSha,
        refUpdates: [
          {
            afterOid: commitSha,
            beforeOid: headSha,
            force: false,
            name: "refs/heads/fix/example",
          },
        ],
        repositoryId: "R_repo",
      },
    }),
  );
});
