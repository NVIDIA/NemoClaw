#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

const DEFAULT_REPORT_DIR = "coverage/cli-dist-signal";

export function buildCliDistCoverageArgs(extraArgs: string[] = []): string[] {
  return [
    "vitest",
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

function main(): void {
  const args = buildCliDistCoverageArgs(process.argv.slice(2));
  const result = spawnSync("npx", args, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
