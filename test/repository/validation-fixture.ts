// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function fixtureGit(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

export function writeFixture(root: string, file: string, contents: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

export function validationFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-validation-test-"));
  fixtureGit(root, "init", "--initial-branch=main");
  writeFixture(
    root,
    ".gitignore",
    "node_modules/\nnemoclaw/node_modules/\ndist/\nnemoclaw/dist/\nnemoclaw/runner-dist/\n",
  );
  writeFixture(root, "src/example.ts", "export const example = 1;\n");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-m", "test: fixture");
  fixtureGit(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}
