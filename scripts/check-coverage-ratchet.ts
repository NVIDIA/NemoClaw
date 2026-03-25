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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLD_PATH = join(REPO_ROOT, "ci", "coverage-threshold.json");
const SUMMARY_PATH = join(REPO_ROOT, "coverage", "coverage-summary.json");

interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface CoverageSummary {
  total: Record<string, CoverageMetric>;
}

interface CoverageThresholds {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

const TOLERANCE = 1;
const METRICS = ["lines", "functions", "branches", "statements"] as const;

function readJSON<T>(path: string, label: string): T {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    console.error(`ERROR: ${label} not found: ${path}`);
    if (label === "Coverage summary") {
      console.error("Run 'npx vitest run --coverage' first.");
    }
    process.exit(1);
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    console.error(`ERROR: Failed to parse ${label}: ${path}`);
    process.exit(1);
  }
}

const summary = readJSON<CoverageSummary>(SUMMARY_PATH, "Coverage summary");
const thresholds = readJSON<CoverageThresholds>(THRESHOLD_PATH, "Threshold file");

let failed = false;
let improved = false;

console.log("=== Coverage Ratchet Check ===");
console.log();

for (const metric of METRICS) {
  const actual = summary.total[metric].pct;
  const threshold = thresholds[metric];

  if (actual < threshold - TOLERANCE) {
    console.log(
      `FAIL: ${metric} coverage is ${actual}%, threshold is ${threshold}% (tolerance ${TOLERANCE}%)`,
    );
    failed = true;
  } else if (actual > threshold + TOLERANCE) {
    console.log(
      `IMPROVED: ${metric} coverage is ${actual}%, above threshold ${threshold}%`,
    );
    improved = true;
  } else {
    console.log(`OK: ${metric} coverage is ${actual}% (threshold ${threshold}%)`);
  }
}

console.log();

if (failed) {
  console.log(
    "Coverage regression detected. Add tests to bring coverage back above the threshold.",
  );
  process.exit(1);
}

if (improved) {
  const updated: Record<string, number> = {};
  for (const metric of METRICS) {
    updated[metric] = Math.max(Math.floor(summary.total[metric].pct), thresholds[metric]);
  }
  const json = JSON.stringify(updated, null, 2);
  console.log("Coverage improved! Update ci/coverage-threshold.json to ratchet the floor:");
  console.log();
  console.log(json);
  console.log();
  console.log(`Run:  echo '${json}' > ci/coverage-threshold.json`);
}

console.log("Coverage ratchet passed.");
