#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Compares a Vitest coverage summary against a threshold file.
// Exits non-zero if any metric drops more than 1% below its threshold.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type MetricName = "lines" | "functions" | "branches" | "statements";

const METRICS: readonly MetricName[] = ["lines", "functions", "branches", "statements"];

type Thresholds = Record<MetricName, number>;
type CoverageSummary = { total: Record<MetricName, { pct: number }> };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE = 1;

/** Read and JSON-parse a repo-relative file. */
function loadJSON<T>(repoRelative: string): T {
  const abs = join(REPO_ROOT, repoRelative);
  try {
    return JSON.parse(readFileSync(abs, "utf-8"));
  } catch (cause) {
    throw new Error(`Failed to load ${abs}`, { cause });
  }
}

function isMetricSummary(value: { pct?: number } | null | undefined): value is { pct: number } {
  return typeof value?.pct === "number";
}

function isCoverageSummary(
  value: { total?: Record<MetricName, { pct: number }> } | null | undefined,
): value is CoverageSummary {
  const total = value?.total;
  if (!total) {
    return false;
  }
  return METRICS.every((metric) => isMetricSummary(total[metric]));
}

function isThresholds(value: Partial<Thresholds> | null | undefined): value is Thresholds {
  if (!value) {
    return false;
  }
  return METRICS.every((metric) => typeof value[metric] === "number");
}

function main(): void {
  const [summaryPath, thresholdPath, label = "coverage"] = process.argv.slice(2);
  if (!summaryPath || !thresholdPath) {
    throw new Error(
      "Usage: check-coverage-ratchet.ts <coverage-summary.json> <coverage-threshold.json> [label]",
    );
  }

  const summaryValue = loadJSON<{ total?: Record<MetricName, { pct: number }> }>(summaryPath);
  if (!isCoverageSummary(summaryValue)) {
    throw new Error(`Invalid coverage summary: ${summaryPath}`);
  }

  const thresholdValue = loadJSON<Partial<Thresholds>>(thresholdPath);
  if (!isThresholds(thresholdValue)) {
    throw new Error(`Invalid coverage threshold: ${thresholdPath}`);
  }

  const failures = METRICS.map((metric) => ({
    metric,
    actual: summaryValue.total[metric].pct,
    threshold: thresholdValue[metric],
  })).filter((r) => r.actual < r.threshold - TOLERANCE);

  if (failures.length === 0) return;

  console.error(`${label} ratchet failed:\n`);
  for (const { metric, actual, threshold } of failures) {
    console.error(`  ${metric}: ${actual}% < ${threshold}% (tolerance ±${TOLERANCE}%)`);
  }
  console.error("\nAdd tests to bring coverage back above the threshold.");
  process.exitCode = 1;
}

main();
