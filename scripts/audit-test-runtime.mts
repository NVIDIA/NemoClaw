// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ProgressSummary } from "../test/e2e/fixtures/progress.ts";

export interface RuntimeAuditRow {
  target: string;
  scenario: string;
  runs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  variabilityMs: number;
  slowestPhase: string;
  slowestPhaseMs: number;
}

function isProgressSummary(value: unknown): value is ProgressSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<ProgressSummary>;
  return (
    summary.version === 1 &&
    typeof summary.scenario === "string" &&
    summary.scenario.length > 0 &&
    (summary.targetId === undefined || typeof summary.targetId === "string") &&
    (summary.shardId === undefined || typeof summary.shardId === "string") &&
    typeof summary.durationMs === "number" &&
    Number.isFinite(summary.durationMs) &&
    summary.durationMs >= 0 &&
    Array.isArray(summary.phases) &&
    summary.phases.every(
      (phase) =>
        phase &&
        typeof phase.label === "string" &&
        typeof phase.durationMs === "number" &&
        Number.isFinite(phase.durationMs) &&
        phase.durationMs >= 0,
    )
  );
}

function progressFiles(root: string): string[] {
  const result: string[] = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      if (path.basename(current) === "test-progress.json") result.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) pending.push(path.join(current, entry.name));
    }
  }
  return result.sort();
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[middle] ?? 0;
}

export function auditTestRuntime(roots: readonly string[]): RuntimeAuditRow[] {
  const summaries = roots.flatMap(progressFiles).map((file) => {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isProgressSummary(parsed)) throw new Error(`${file}: invalid test progress summary`);
    return parsed;
  });
  const grouped = new Map<string, ProgressSummary[]>();
  for (const summary of summaries) {
    const key = JSON.stringify([
      summary.targetId ?? "unlabeled",
      summary.shardId,
      summary.scenario,
    ]);
    const group = grouped.get(key) ?? [];
    group.push(summary);
    grouped.set(key, group);
  }

  return [...grouped.entries()]
    .map(([, runs]): RuntimeAuditRow => {
      const first = runs[0];
      if (!first) throw new Error("runtime audit group is unexpectedly empty");
      const durations = runs.map((run) => run.durationMs as number).sort((a, b) => a - b);
      const phases = runs.flatMap((run) => run.phases);
      const slowestPhase = phases.reduce(
        (slowest, phase) => (phase.durationMs > slowest.durationMs ? phase : slowest),
        { label: "n/a", durationMs: 0 },
      );
      const medianMs = median(durations);
      const p95Ms = percentile(durations, 0.95);
      return {
        target: [first.targetId ?? "unlabeled", first.shardId].filter(Boolean).join("/"),
        scenario: first.scenario,
        runs: runs.length,
        medianMs,
        p95Ms,
        maxMs: durations.at(-1) ?? 0,
        variabilityMs: Math.max(0, p95Ms - medianMs),
        slowestPhase: slowestPhase.label,
        slowestPhaseMs: slowestPhase.durationMs,
      };
    })
    .sort((a, b) => b.p95Ms - a.p95Ms || b.variabilityMs - a.variabilityMs);
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(1);
}

export function formatRuntimeAudit(rows: readonly RuntimeAuditRow[]): string {
  const lines = [
    "| Target | Scenario | Runs | Median | p95 | Max | p95 - median | Slowest observed phase |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.target.replaceAll("|", "\\|")} | ${row.scenario.replaceAll("|", "\\|")} | ${row.runs} | ${seconds(row.medianMs)}s | ${seconds(row.p95Ms)}s | ${seconds(row.maxMs)}s | ${seconds(row.variabilityMs)}s | ${row.slowestPhase.replaceAll("|", "\\|")} (${seconds(row.slowestPhaseMs)}s) |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function main(argv: readonly string[]): void {
  const roots = argv.length > 0 ? argv : [".e2e/live"];
  const rows = auditTestRuntime(roots);
  if (rows.length === 0) {
    throw new Error(`no test-progress.json files found under: ${roots.join(", ")}`);
  }
  process.stdout.write(formatRuntimeAudit(rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
