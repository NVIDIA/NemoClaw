// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOnlyHookConfiguration } from "./read-only-config.mts";
import { executeValidationCommand } from "./validation-command.mts";

type Execute = (command: string, args: string[]) => number;

export function validatePr(root: string, execute: Execute): number {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.error || status.status !== 0 || status.stdout.length !== 0)
    throw new Error("Commit all changes before publication validation");
  const temporary = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-validation-"));
  try {
    const config = path.join(temporary, "hooks.yaml");
    writeFileSync(
      config,
      readOnlyHookConfiguration(readFileSync(path.join(root, ".pre-commit-config.yaml"), "utf8")),
    );
    const prek = [
      "prek",
      "--config",
      config,
      "run",
      "--from-ref",
      "origin/main",
      "--to-ref",
      "HEAD",
    ];
    const checks = [
      [...prek, "--stage", "pre-commit"],
      ["commitlint", "--from", "origin/main", "--to", "HEAD"],
      [...prek, "--stage", "pre-push"],
    ];
    for (const args of checks) {
      const result = execute("npx", ["--no-install", ...args]);
      if (result !== 0) return result;
    }
    const after = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    });
    if (after.error || after.status !== 0 || after.stdout.length !== 0)
      throw new Error("Validation changed repository files");
    return 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "../..");
  process.exitCode = validatePr(root, (command, args) => {
    // Prek 0.3.6 otherwise substitutes native fixers for the copy wrappers.
    const env =
      args.at(-1) === "pre-commit" ? { ...process.env, PREK_NO_FAST_PATH: "1" } : process.env;
    return executeValidationCommand(root, [command, ...args], env);
  });
}
