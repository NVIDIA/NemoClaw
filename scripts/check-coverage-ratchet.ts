#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Compares Vitest coverage output against ci/coverage-threshold.json.
// Exits non-zero if any metric drops more than 1% below its threshold.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const METRICS = ["lines", "functions", "branches", "statements"] as const;

type MetricName = (typeof METRICS)[number];

type Thresholds = Record<MetricName, number>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE = 1;

/** Read and JSON-parse a repo-relative file. */
function loadJSON<T>(repoRelative: string): T {
  const abs = join(REPO_ROOT, repoRelative);
  try {
    return JSON.parse(readFileSync(abs, "utf-8")) as T;
  } catch (cause) {
    throw new Error(`Failed to load ${abs}`, { cause });
  }
}

function main(): void {
  const summary = loadJSON<{ total: Record<string, { pct: number }> }>(
    "coverage/coverage-summary.json",
  );
  const thresholds = loadJSON<Thresholds>("ci/coverage-threshold.json");

  const failures = METRICS.map((metric) => ({
    metric,
    actual: summary.total[metric].pct,
    threshold: thresholds[metric],
  })).filter((r) => r.actual < r.threshold - TOLERANCE);

  if (failures.length === 0) return;

  console.error("Coverage ratchet failed:\n");
  for (const { metric, actual, threshold } of failures) {
    console.error(`  ${metric}: ${actual}% < ${threshold}% (tolerance ±${TOLERANCE}%)`);
  }
  console.error("\nAdd tests to bring coverage back above the threshold.");
  process.exitCode = 1;
}

main();
