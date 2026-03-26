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

const METRICS = ["lines", "functions", "branches", "statements"] as const;

type MetricName = (typeof METRICS)[number];

type Thresholds = Record<MetricName, number>;

type Status = "ok" | "fail" | "improved";

interface Result {
  metric: MetricName;
  actual: number;
  threshold: number;
  status: Status;
}

// ── Helpers ────────────────────────────────────────────────────────

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

/** Classify a single actual-vs-threshold comparison. */
function classify(actual: number, threshold: number): Status {
  if (actual < threshold - TOLERANCE) return "fail";
  if (actual > threshold + TOLERANCE) return "improved";
  return "ok";
}

/** Compare each metric's actual coverage against its threshold. */
function check(
  summary: { total: Record<string, { pct: number }> },
  thresholds: Thresholds,
): Result[] {
  return METRICS.map((metric) => {
    const actual = summary.total[metric].pct;
    const threshold = thresholds[metric];
    return { metric, actual, threshold, status: classify(actual, threshold) };
  });
}

// ── Formatting ─────────────────────────────────────────────────────

function formatResult({ metric, actual, threshold, status }: Result): string {
  const pct = `${metric} coverage is ${actual}%`;
  switch (status) {
    case "fail":
      return `FAIL: ${pct}, threshold is ${threshold}% (tolerance ${TOLERANCE}%)`;
    case "improved":
      return `IMPROVED: ${pct}, above threshold ${threshold}%`;
    case "ok":
      return `OK: ${pct} (threshold ${threshold}%)`;
  }
}

function formatReport(results: Result[]): string {
  const sections: string[] = [
    "=== Coverage Ratchet Check ===",
    results.map(formatResult).join("\n"),
  ];

  if (results.some((r) => r.status === "fail")) {
    sections.push(
      "Coverage regression detected. Add tests to bring coverage back above the threshold.",
    );
  } else if (results.some((r) => r.status === "improved")) {
    const updated = JSON.stringify(
      Object.fromEntries(
        results.map((r) => [r.metric, Math.max(Math.floor(r.actual), r.threshold)]),
      ),
      null,
      2,
    );
    sections.push(
      [
        "Coverage improved! Update ci/coverage-threshold.json to ratchet the floor:",
        updated,
        `Run:  echo '${updated}' > ci/coverage-threshold.json`,
      ].join("\n\n"),
    );
  }

  sections.push("Coverage ratchet passed.");
  return sections.join("\n\n");
}

// ── Main ───────────────────────────────────────────────────────────

function main(): void {
  const summary = loadJSON<{ total: Record<string, { pct: number }> }>(
    "coverage/coverage-summary.json",
  );
  const thresholds = loadJSON<Thresholds>("ci/coverage-threshold.json");

  const results = check(summary, thresholds);
  console.log(formatReport(results));

  if (results.some((r) => r.status === "fail")) {
    process.exitCode = 1;
  }
}

main();
