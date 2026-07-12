#!/usr/bin/env -S npx tsx
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type MetricName = "lines" | "functions" | "branches" | "statements";
type FileCoverage = Record<MetricName, { pct: number }>;
type CoverageSummary = Record<string, FileCoverage | unknown>;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const METRICS: readonly MetricName[] = ["statements", "branches", "functions", "lines"];

function normalizeRepoPath(file: string): string {
  const repoRelative = isAbsolute(file) ? relative(REPO_ROOT, file) : file;
  return repoRelative.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isFileCoverage(value: unknown): value is FileCoverage {
  if (!value || typeof value !== "object") return false;
  return METRICS.every((metric) => {
    const entry = (value as Partial<FileCoverage>)[metric];
    return typeof entry?.pct === "number";
  });
}

function formatPercentage(value: number): string {
  return `${value.toFixed(2).replace(/\.00$/u, "")}%`;
}

export function renderChangedCoverageReport(
  summary: CoverageSummary,
  changedFiles: string[],
  label: string,
): string {
  const coverageByPath = new Map<string, FileCoverage>();
  for (const [file, coverage] of Object.entries(summary)) {
    if (file !== "total" && isFileCoverage(coverage)) {
      coverageByPath.set(normalizeRepoPath(file), coverage);
    }
  }

  const coveredChanges = [...new Set(changedFiles.map(normalizeRepoPath))]
    .filter((file) => coverageByPath.has(file))
    .sort();
  if (coveredChanges.length === 0) {
    return `## ${label}\n\nNo changed covered source files were found.`;
  }

  const rows = coveredChanges.map((file) => {
    const coverage = coverageByPath.get(file);
    if (!coverage) throw new Error(`Missing normalized coverage entry for ${file}`);
    return `| \`${file}\` | ${METRICS.map((metric) => formatPercentage(coverage[metric].pct)).join(" | ")} |`;
  });

  return [
    `## ${label}`,
    "",
    "This report is advisory. The aggregate and security-sensitive coverage ratchets remain the merge gates.",
    "",
    "| Changed file | Statements | Branches | Functions | Lines |",
    "|---|---:|---:|---:|---:|",
    ...rows,
  ].join("\n");
}

function main(): void {
  const [summaryPath, baseRef, headRef = "HEAD", label = "Changed-file coverage"] =
    process.argv.slice(2);
  if (!summaryPath || !baseRef) {
    throw new Error(
      "Usage: report-changed-coverage.ts <coverage-summary.json> <base-ref> [head-ref] [label]",
    );
  }

  const summaryFile = resolve(REPO_ROOT, summaryPath);
  const summary = JSON.parse(readFileSync(summaryFile, "utf8")) as CoverageSummary;
  const changedFiles = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", baseRef, headRef],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const report = renderChangedCoverageReport(summary, changedFiles, label);

  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${report}\n`, "utf8");
  }
}

const isDirectExecution = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isDirectExecution) {
  main();
}
