#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPORT_DIR = "coverage/cli-dist-signal";
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

type SpawnResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
};

type SpawnSyncLike = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
) => SpawnResult;

type RunCliDistCoverageDeps = {
  spawn?: SpawnSyncLike;
  kill?: typeof process.kill;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
};

export function buildCliDistCoverageArgs(extraArgs: string[] = []): string[] {
  return [
    "run",
    "--project",
    "cli",
    "--coverage",
    "--coverage.provider=v8",
    "--coverage.reporter=text-summary",
    "--coverage.reporter=json-summary",
    "--coverage.reporter=json",
    `--coverage.reportsDirectory=${DEFAULT_REPORT_DIR}`,
    "--coverage.reportOnFailure",
    "--coverage.include=src/**/*.ts",
    "--coverage.include=dist/**/*.js",
    "--coverage.include=bin/**/*.js",
    "--coverage.exclude=**/*.test.ts",
    "--coverage.exclude=**/*.test.js",
    "--coverage.exclude=node_modules/**",
    "--coverage.exclude=nemoclaw/**",
    ...extraArgs,
  ];
}

export function resolveLocalVitestBin(repoRoot = REPO_ROOT): string {
  const suffix = process.platform === "win32" ? "vitest.cmd" : "vitest";
  return path.join(repoRoot, "node_modules", ".bin", suffix);
}

export function runCliDistCoverage(
  extraArgs: string[] = [],
  deps: RunCliDistCoverageDeps = {},
): number | null {
  const args = buildCliDistCoverageArgs(extraArgs);
  const result = (deps.spawn ?? spawnSync)(resolveLocalVitestBin(deps.repoRoot), args, {
    stdio: "inherit",
    env: deps.env ?? process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    (deps.kill ?? process.kill)(process.pid, result.signal);
    return null;
  }
  return result.status ?? 1;
}

export function isDirectExecution(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  return path.resolve(fileURLToPath(metaUrl)) === path.resolve(argv1);
}

function main(): void {
  const exitCode = runCliDistCoverage(process.argv.slice(2));
  if (exitCode !== null) {
    process.exitCode = exitCode;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main();
}
