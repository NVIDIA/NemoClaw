// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GUARD_SCRIPT = path.join(REPO_ROOT, "scripts", "check-legacy-migrated-paths.ts");

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
}

function initTempRepo(prefix: string): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  run("git", ["init", "-b", "main"], repoDir);
  run("git", ["config", "user.name", "Test User"], repoDir);
  run("git", ["config", "user.email", "test@example.com"], repoDir);
  run("git", ["config", "commit.gpgsign", "false"], repoDir);
  return repoDir;
}

describe("ts-migration:guard", () => {
  it(
    "blocks renaming a removed shim by checking the source path in R entries",
    { timeout: 15000 },
    () => {
      const repoDir = initTempRepo("nemoclaw-legacy-guard-");
      const originalPath = path.join(repoDir, "bin", "lib", "runner.js");
      const renamedPath = path.join(repoDir, "tmp", "runner.js");

      fs.mkdirSync(path.dirname(originalPath), { recursive: true });
      fs.writeFileSync(originalPath, "module.exports = {};\n");
      run("git", ["add", "."], repoDir);
      run("git", ["commit", "-m", "base"], repoDir);

      run("git", ["checkout", "-b", "feature"], repoDir);
      fs.mkdirSync(path.dirname(renamedPath), { recursive: true });
      run("git", ["mv", "bin/lib/runner.js", "tmp/runner.js"], repoDir);
      run("git", ["commit", "-m", "rename shim"], repoDir);

      const result = spawnSync(TSX, [GUARD_SCRIPT, "--base", "main", "--head", "HEAD"], {
        cwd: repoDir,
        encoding: "utf-8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Removed compatibility shims must not be reintroduced or edited directly:",
      );
      expect(`${result.stdout}${result.stderr}`).toContain(
        "bin/lib/runner.js -> src/lib/runner.ts",
      );
    },
  );
});
