// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs local repository checks that are not first-class Biome rules. */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CheckCommand = {
  name: string;
  command: string;
  args: string[];
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = process.platform === "win32" ? "tsx.cmd" : "tsx";
const CHECKS: readonly CheckCommand[] = [
  {
    name: "direct-credential-env",
    command: TSX,
    args: ["scripts/checks/direct-credential-env.ts", "src/lib/onboard.ts"],
  },
  {
    name: "no-coverage-ignore",
    command: TSX,
    args: ["scripts/checks/no-coverage-ignore.ts"],
  },
  {
    name: "layer-import-boundaries",
    command: TSX,
    args: ["scripts/checks/layer-import-boundaries.ts"],
  },
];

function main(): void {
  for (const check of CHECKS) {
    const result = spawnSync(check.command, check.args, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(`Check failed: ${check.name}`);
      process.exit(result.status ?? 1);
    }
  }
}

main();
