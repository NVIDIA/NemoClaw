// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ProgressPhase, ProgressSummary } from "../test/e2e/fixtures/progress.ts";

export type RuntimeOutcome = "passed" | "failed" | "skipped";
type ValidatedProgressSummary = Omit<ProgressSummary, "durationMs"> & { durationMs: number };

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
  slowestPhaseOutcome: RuntimeOutcome;
}

export interface RuntimeHistoryPhase {
  label: string;
  durationMs: number;
  outcome: RuntimeOutcome;
}

export interface RuntimeHistorySample {
  target: string;
  scenario: string;
  durationMs: number;
  outcome: RuntimeOutcome;
  phases: RuntimeHistoryPhase[];
}

function isProgressSummary(value: unknown): value is ValidatedProgressSummary {
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
        (phase.outcome === "passed" || phase.outcome === "failed" || phase.outcome === "skipped") &&
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

function readProgressSummaries(roots: readonly string[]): ValidatedProgressSummary[] {
  return roots.flatMap(progressFiles).map((file) => {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isProgressSummary(parsed)) throw new Error(`${file}: invalid test progress summary`);
    return parsed;
  });
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

function runtimeOutcome(phases: readonly Pick<ProgressPhase, "outcome">[]): RuntimeOutcome {
  if (phases.some((phase) => phase.outcome === "failed")) return "failed";
  if (phases.some((phase) => phase.outcome === "skipped")) return "skipped";
  return "passed";
}

function targetIdentity(summary: ValidatedProgressSummary): string {
  return [summary.targetId ?? "unlabeled", summary.shardId].filter(Boolean).join("/");
}

export function collectRuntimeHistorySamples(
  roots: readonly string[],
): RuntimeHistorySample[] {
  const grouped = new Map<string, ValidatedProgressSummary[]>();
  for (const summary of readProgressSummaries(roots)) {
    const key = JSON.stringify([targetIdentity(summary), summary.scenario]);
    const group = grouped.get(key) ?? [];
    group.push(summary);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((runs): RuntimeHistorySample => {
      const first = runs[0];
      if (!first) throw new Error("runtime history group is unexpectedly empty");
      const phasesByLabel = new Map<string, ProgressPhase[]>();
      for (const phase of runs.flatMap((run) => run.phases)) {
        const phases = phasesByLabel.get(phase.label) ?? [];
        phases.push(phase);
        phasesByLabel.set(phase.label, phases);
      }
      return {
        target: targetIdentity(first),
        scenario: first.scenario,
        durationMs: median(runs.map((run) => run.durationMs).sort((a, b) => a - b)),
        outcome: runtimeOutcome(runs.flatMap((run) => run.phases)),
        phases: [...phasesByLabel.entries()]
          .map(([label, phases]) => ({
            label,
            durationMs: median(phases.map((phase) => phase.durationMs).sort((a, b) => a - b)),
            outcome: runtimeOutcome(phases),
          }))
          .sort((left, right) => left.label.localeCompare(right.label)),
      };
    })
    .sort((left, right) => right.durationMs - left.durationMs);
}

export function auditTestRuntime(roots: readonly string[]): RuntimeAuditRow[] {
  const summaries = readProgressSummaries(roots);
  const grouped = new Map<string, ValidatedProgressSummary[]>();
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
      const slowestPhase = phases.reduce<Pick<ProgressPhase, "label" | "durationMs" | "outcome">>(
        (slowest, phase) => (phase.durationMs > slowest.durationMs ? phase : slowest),
        { label: "n/a", durationMs: 0, outcome: "skipped" as const },
      );
      const medianMs = median(durations);
      const p95Ms = percentile(durations, 0.95);
      return {
        target: targetIdentity(first),
        scenario: first.scenario,
        runs: runs.length,
        medianMs,
        p95Ms,
        maxMs: durations.at(-1) ?? 0,
        variabilityMs: Math.max(0, p95Ms - medianMs),
        slowestPhase: slowestPhase.label,
        slowestPhaseMs: slowestPhase.durationMs,
        slowestPhaseOutcome: slowestPhase.outcome,
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
      `| ${row.target.replaceAll("|", "\\|")} | ${row.scenario.replaceAll("|", "\\|")} | ${row.runs} | ${seconds(row.medianMs)}s | ${seconds(row.p95Ms)}s | ${seconds(row.maxMs)}s | ${seconds(row.variabilityMs)}s | ${row.slowestPhase.replaceAll("|", "\\|")} (${seconds(row.slowestPhaseMs)}s, ${row.slowestPhaseOutcome}) |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatRuntimeAuditSummary(rows: readonly RuntimeAuditRow[]): string {
  const lines = ["## E2E Test Phase Runtime", "", "This run's semantic phase timing summary.", ""];
  if (rows.length === 0) {
    lines.push("No `test-progress.json` artifacts were available for this run.");
  } else {
    lines.push(formatRuntimeAudit(rows).trimEnd());
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
