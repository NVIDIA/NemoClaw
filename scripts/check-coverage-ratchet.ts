#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Compares Vitest coverage output against ci/coverage-threshold.json.
// Fails if any metric drops below the threshold (with 1% tolerance).
// Prints updated thresholds when coverage improves, so contributors
// can update the file and ratchet the floor upward.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────────────────

/** A single metric entry from istanbul's coverage-summary.json. */
interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

/** The `total` key of istanbul's coverage-summary.json. */
interface CoverageSummary {
  total: Record<string, CoverageMetric>;
}

/** Our ratchet file: ci/coverage-threshold.json. */
type CoverageThresholds = Record<MetricName, number>;

type MetricName = (typeof METRICS)[number];

type CheckStatus = "ok" | "fail" | "improved";

interface MetricResult {
  metric: MetricName;
  actual: number;
  threshold: number;
  status: CheckStatus;
}

// ── Constants ──────────────────────────────────────────────────────

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLD_PATH = join(REPO_ROOT, "ci", "coverage-threshold.json");
const SUMMARY_PATH = join(REPO_ROOT, "coverage", "coverage-summary.json");

const TOLERANCE = 1;
const METRICS = ["lines", "functions", "branches", "statements"] as const;

// ── Pure helpers ───────────────────────────────────────────────────

/** Read and JSON-parse a file, throwing a descriptive error on failure. */
function loadJSON<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (cause) {
    throw new Error(`Failed to load ${label}: ${path}`, { cause });
  }
}

/** Compare each metric against its threshold and return structured results. */
function checkMetrics(
  summary: CoverageSummary,
  thresholds: CoverageThresholds,
): MetricResult[] {
  return METRICS.map((metric) => {
    const actual = summary.total[metric].pct;
    const threshold = thresholds[metric];
    const status: CheckStatus =
      actual < threshold - TOLERANCE
        ? "fail"
        : actual > threshold + TOLERANCE
          ? "improved"
          : "ok";
    return { metric, actual, threshold, status };
  });
}

/** Build updated thresholds from results (floor of actual, never lowering). */
function ratchetedThresholds(results: MetricResult[]): CoverageThresholds {
  return Object.fromEntries(
    results.map((r) => [r.metric, Math.max(Math.floor(r.actual), r.threshold)]),
  ) as CoverageThresholds;
}

// ── Formatting ─────────────────────────────────────────────────────

function formatResult({ metric, actual, threshold, status }: MetricResult): string {
  const preamble = `${metric} coverage is ${actual}%`;
  switch (status) {
    case "fail":
      return `FAIL: ${preamble}, threshold is ${threshold}% (tolerance ${TOLERANCE}%)`;
    case "improved":
      return `IMPROVED: ${preamble}, above threshold ${threshold}%`;
    case "ok":
      return `OK: ${preamble} (threshold ${threshold}%)`;
  }
}

function formatReport(results: MetricResult[], failed: boolean): string {
  const lines: string[] = ["=== Coverage Ratchet Check ===", ""];

  lines.push(...results.map(formatResult), "");

  if (failed) {
    lines.push(
      "Coverage regression detected. Add tests to bring coverage back above the threshold.",
    );
  } else if (results.some((r) => r.status === "improved")) {
    const updated = JSON.stringify(ratchetedThresholds(results), null, 2);
    lines.push(
      "Coverage improved! Update ci/coverage-threshold.json to ratchet the floor:",
      "",
      updated,
      "",
      `Run:  echo '${updated}' > ci/coverage-threshold.json`,
    );
  }

  lines.push("", "Coverage ratchet passed.");
  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────

function main(): void {
  const summary = loadJSON<CoverageSummary>(SUMMARY_PATH, "Coverage summary");
  const thresholds = loadJSON<CoverageThresholds>(THRESHOLD_PATH, "Threshold file");

  const results = checkMetrics(summary, thresholds);
  const failed = results.some((r) => r.status === "fail");

  console.log(formatReport(results, failed));

  if (failed) {
    process.exitCode = 1;
  }
}

main();
