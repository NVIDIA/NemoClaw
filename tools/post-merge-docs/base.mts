// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { PostMergeDocsError, requireSha } from "./artifact.mts";

export const HARDENED_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

export function hardenedGitArgs(args: readonly string[]): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.process=",
    "-c",
    "filter.lfs.required=false",
    ...args,
  ];
}

export function mergeTreeSha(repository: string, rollingHeadSha: string, mainSha: string): string {
  requireSha(rollingHeadSha, "rolling branch SHA");
  requireSha(mainSha, "main SHA");
  const result = spawnSync(
    "git",
    hardenedGitArgs(["merge-tree", "--write-tree", rollingHeadSha, mainSha]),
    {
      cwd: repository,
      encoding: "utf8",
      env: HARDENED_GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new PostMergeDocsError(
      `rolling documentation branch conflicts with exact main: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return requireSha(result.stdout.split(/\r?\n/u)[0] ?? "", "combined documentation tree");
}

function run(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", hardenedGitArgs(args), {
    cwd: repository,
    encoding: "utf8",
    env: HARDENED_GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new PostMergeDocsError(
      `Git ${args[0] ?? "command"} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

export function prepareCombinedBase(input: {
  sourceRepository: string;
  destination: string;
  mainSha: string;
  rollingHeadSha: string | null;
}): { repository: string; baseTreeSha: string } {
  requireSha(input.mainSha, "main SHA");
  if (input.rollingHeadSha) requireSha(input.rollingHeadSha, "rolling branch SHA");
  fs.rmSync(input.destination, { force: true, recursive: true });
  run(input.sourceRepository, [
    "clone",
    "--no-hardlinks",
    "--no-checkout",
    input.sourceRepository,
    input.destination,
  ]);
  run(input.destination, ["checkout", "--detach", input.rollingHeadSha ?? input.mainSha]);
  if (input.rollingHeadSha) {
    const merge = spawnSync(
      "git",
      hardenedGitArgs([
        "-c",
        "user.name=NemoClaw Documentation Bot",
        "-c",
        "user.email=actions@github.com",
        "merge",
        "--no-commit",
        "--no-ff",
        input.mainSha,
      ]),
      {
        cwd: input.destination,
        encoding: "utf8",
        env: HARDENED_GIT_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (merge.status !== 0) {
      throw new PostMergeDocsError(
        `rolling documentation branch conflicts with exact main: ${(merge.stderr || merge.stdout).trim()}`,
      );
    }
  }
  return {
    repository: input.destination,
    baseTreeSha: requireSha(run(input.destination, ["write-tree"]), "combined documentation tree"),
  };
}
