// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createGitHubTree } from "../../../tools/pull-requests/publication.mts";

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
  ).rejects.toThrow("not a mode-100644 file");
  expect(request).not.toHaveBeenCalled();
});
