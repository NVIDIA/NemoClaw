// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs local repository checks that are not first-class Biome rules. */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CheckCommand = {
  name: string;
  command: string;
  args: string[];
};

type CheckSpawnResult = {
  status: number | null;
  error?: Error;
};

type CheckSpawn = (command: string, args: string[], options: SpawnSyncOptions) => CheckSpawnResult;

type SpawnInvocation = {
  command: string;
  args: string[];
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = process.platform === "win32" ? "tsx.cmd" : "tsx";
export const CHECKS: readonly CheckCommand[] = [
  {
    name: "direct-credential-env",
    command: TSX,
    args: [
      "scripts/checks/direct-credential-env.ts",
      "src/lib/onboard.ts",
      "src/lib/onboard/provider-key-bridge.ts",
      "src/lib/onboard/providers.ts",
    ],
  },
  {
    name: "local-credential-helper-pin",
    command: TSX,
    args: ["scripts/checks/local-credential-helper-pin.ts"],
  },
  {
    name: "hermes-light-skin-boundary",
    command: TSX,
    args: ["scripts/checks/hermes-light-skin-boundary.ts"],
  },
  {
    name: "dependency-pins",
    command: TSX,
    args: ["scripts/checks/dependency-pins.ts"],
  },
  {
    name: "no-coverage-ignore",
    command: TSX,
    args: ["scripts/checks/no-coverage-ignore.ts"],
  },
  {
    name: "openshell-policy-mutation-read",
    command: TSX,
    args: ["scripts/checks/openshell-policy-mutation-read.ts"],
  },
  {
    name: "layer-import-boundaries",
    command: TSX,
    args: ["scripts/checks/layer-import-boundaries.ts"],
  },
  {
    name: "no-test-dist-imports",
    command: TSX,
    args: ["scripts/checks/no-test-dist-imports.ts"],
  },
  {
    name: "test-create-require-budget",
    command: TSX,
    args: ["scripts/checks/test-create-require-budget.ts"],
  },
  {
    name: "vitest-project-overlap",
    command: TSX,
    args: ["scripts/checks/vitest-project-overlap.ts"],
  },
  {
    name: "test-title-style",
    command: TSX,
    args: ["scripts/checks/test-title-style.ts"],
  },
  {
    name: "no-unit-blocks-in-live-e2e",
    command: TSX,
    args: ["scripts/checks/no-unit-blocks-in-live-e2e.ts"],
  },
];

type RunChecksOptions = {
  checks?: readonly CheckCommand[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: CheckSpawn;
  exit?: (code?: number) => never;
};

export function buildCheckSpawnInvocation(
  check: CheckCommand,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnInvocation {
  if (platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", check.command, ...check.args],
    };
  }
  return {
    command: check.command,
    args: check.args,
  };
}

export function runChecks(options: RunChecksOptions = {}): void {
  const checks = options.checks ?? CHECKS;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const spawn: CheckSpawn =
    options.spawn ?? ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions));
  const exit = options.exit ?? process.exit;
  for (const check of checks) {
    const invocation = buildCheckSpawnInvocation(check, platform, env);
    const result = spawn(invocation.command, invocation.args, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(`Check failed: ${check.name}`);
      if (result.status === null && result.error?.message) {
        console.error(result.error.message);
      }
      exit(result.status ?? 1);
    }
  }
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  runChecks();
}
