// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Runs repository checks that Oxlint does not provide. */

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
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
      "scripts/checks/direct-credential-env.mts",
      "src/lib/onboard.ts",
      "src/lib/onboard/provider-key-bridge.ts",
      "src/lib/onboard/providers.ts",
    ],
  },
  {
    name: "local-credential-helper-pin",
    command: TSX,
    args: ["scripts/checks/local-credential-helper-pin.mts"],
  },
  {
    name: "hermes-light-skin-boundary",
    command: TSX,
    args: ["scripts/checks/hermes-light-skin-boundary.mts"],
  },
  {
    name: "dependency-pins",
    command: TSX,
    args: ["scripts/checks/dependency-pins.mts"],
  },
  {
    name: "no-defaulted-dependent-flags",
    command: TSX,
    args: ["scripts/checks/no-defaulted-dependent-flags.mts"],
  },
  {
    name: "no-coverage-ignore",
    command: TSX,
    args: ["scripts/checks/no-coverage-ignore.mts"],
  },
  {
    name: "layer-import-boundaries",
    command: TSX,
    args: ["scripts/checks/layer-import-boundaries.mts"],
  },
  {
    name: "source-architecture",
    command: TSX,
    args: ["scripts/checks/source-architecture.mts"],
  },
  {
    name: "onboard-entry-composition",
    command: TSX,
    args: ["scripts/checks/onboard-entry-composition.mts"],
  },
  {
    name: "no-test-dist-imports",
    command: TSX,
    args: ["scripts/checks/no-test-dist-imports.mts"],
  },
  {
    name: "test-create-require-budget",
    command: TSX,
    args: ["scripts/checks/test-create-require-budget.mts"],
  },
  {
    name: "vitest-project-overlap",
    command: TSX,
    args: ["scripts/checks/vitest-project-overlap.mts"],
  },
  {
    name: "test-title-style",
    command: TSX,
    args: ["scripts/checks/test-title-style.mts"],
  },
  {
    name: "no-unit-blocks-in-live-e2e",
    command: TSX,
    args: ["scripts/checks/no-unit-blocks-in-live-e2e.mts"],
  },
  {
    name: "e2e-assertion-census",
    command: TSX,
    args: ["scripts/checks/e2e-assertion-census.mts", "--check"],
  },
  {
    name: "optimized-build-context-copy-sources",
    command: TSX,
    args: ["scripts/checks/optimized-build-context-copy-sources.mts"],
  },
  {
    name: "pi-qualification-receipt-refresh",
    command: TSX,
    args: ["scripts/checks/pi-qualification-receipt-refresh.mts"],
  },
  {
    name: "test-registration-boundary",
    command: TSX,
    args: ["scripts/checks/test-registration-boundary.mts"],
  },
  {
    name: "growth-guardrails-workflow-boundary",
    command: TSX,
    args: ["scripts/checks/growth-guardrails-workflow-boundary.mts"],
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
