#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Compares a Vitest coverage summary against a threshold file.
// Exits non-zero if any metric drops more than 0.1 percentage point below its threshold.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type MetricName = "lines" | "functions" | "branches" | "statements";

const METRICS: readonly MetricName[] = ["lines", "functions", "branches", "statements"];

type Thresholds = Record<MetricName, number>;
type CoverageSummary = { total: Record<MetricName, { pct: number }> };
type CoverageFailure = { metric: MetricName; actual: number; threshold: number };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE = 0.1;

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

export function findCoverageFailures(
  summary: CoverageSummary,
  thresholds: Thresholds,
): CoverageFailure[] {
  return METRICS.map((metric) => ({
    metric,
    actual: summary.total[metric].pct,
    threshold: thresholds[metric],
  })).filter(({ actual, threshold }) => {
    const roundingTolerance = Number.EPSILON * Math.max(Math.abs(actual), Math.abs(threshold), 1);
    return threshold - actual - TOLERANCE > roundingTolerance;
  });
}

function main(): void {
  const [summaryPath, thresholdPath, label = "coverage"] = process.argv.slice(2);
  if (!summaryPath || !thresholdPath) {
    throw new Error(
      "Usage: check-coverage-ratchet.mts <coverage-summary.json> <coverage-threshold.json> [label]",
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

  const failures = findCoverageFailures(summaryValue, thresholdValue);

  if (failures.length === 0) return;

  console.error(`${label} ratchet failed:\n`);
  for (const { metric, actual, threshold } of failures) {
    console.error(
      `  ${metric}: ${actual}% < ${threshold}% (allowed drop: ${TOLERANCE} percentage point)`,
    );
  }
  console.error("\nAdd tests to bring coverage back above the threshold.");
  process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  main();
}
