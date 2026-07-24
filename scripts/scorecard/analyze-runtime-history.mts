// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { RuntimeAuditRow } from "../audit-test-runtime.mts";
import { readValidatedArtifactZipEntry } from "./read-artifact-zip.mts";

export const RUNTIME_SUMMARY_ARTIFACT = "e2e-runtime-summary";
export const RUNTIME_SUMMARY_FILE = "e2e-runtime-summary.json";
const RUNTIME_SUMMARY_SCHEMA = "nemoclaw.e2e_runtime_summary.v1";
const WORKFLOW_FILE = "e2e.yaml";
const HISTORY_RUN_LIMIT = 10;
const MAX_SUMMARY_BYTES = 256 * 1024;
const MAX_SUMMARY_ROWS = 200;

type GitHubDeps = {
  github: any;
  context: { repo: { owner: string; repo: string }; runId: number };
  core?: { warning?: (message: string) => void };
};

export interface RuntimeSummaryArtifact {
  schemaVersion: typeof RUNTIME_SUMMARY_SCHEMA;
  runId: number;
  createdAt: string;
  rows: RuntimeAuditRow[];
}

type RuntimeHistoryServices = {
  loadPriorNightlySummaries: (deps: GitHubDeps) => Promise<RuntimeSummaryArtifact[]>;
};

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isNonNegativeNumber(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function normalizeRuntimeRow(value: unknown): RuntimeAuditRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !hasExactKeys(row, [
      "target",
      "scenario",
      "runs",
      "medianMs",
      "p95Ms",
      "maxMs",
      "variabilityMs",
      "passedRuns",
      "failedRuns",
      "skippedRuns",
      "slowestPhase",
      "slowestPhaseMs",
      "slowestPhaseOutcome",
    ]) ||
    !isBoundedString(row.target) ||
    !isBoundedString(row.scenario) ||
    !isNonNegativeInteger(row.runs) ||
    row.runs < 1 ||
    !isNonNegativeNumber(row.medianMs) ||
    !isNonNegativeNumber(row.p95Ms) ||
    !isNonNegativeNumber(row.maxMs) ||
    !isNonNegativeNumber(row.variabilityMs) ||
    row.medianMs > row.p95Ms ||
    row.p95Ms > row.maxMs ||
    row.variabilityMs !== row.p95Ms - row.medianMs ||
    !isNonNegativeInteger(row.passedRuns) ||
    !isNonNegativeInteger(row.failedRuns) ||
    !isNonNegativeInteger(row.skippedRuns) ||
    row.passedRuns + row.failedRuns + row.skippedRuns !== row.runs ||
    !isBoundedString(row.slowestPhase) ||
    !isNonNegativeNumber(row.slowestPhaseMs) ||
    (row.slowestPhaseOutcome !== "passed" &&
      row.slowestPhaseOutcome !== "failed" &&
      row.slowestPhaseOutcome !== "skipped")
  ) {
    return null;
  }
  return {
    target: row.target,
    scenario: row.scenario,
    runs: row.runs,
    medianMs: row.medianMs,
    p95Ms: row.p95Ms,
    maxMs: row.maxMs,
    variabilityMs: row.variabilityMs,
    passedRuns: row.passedRuns,
    failedRuns: row.failedRuns,
    skippedRuns: row.skippedRuns,
    slowestPhase: row.slowestPhase,
    slowestPhaseMs: row.slowestPhaseMs,
    slowestPhaseOutcome: row.slowestPhaseOutcome,
  };
}

export function normalizeRuntimeSummary(value: unknown): RuntimeSummaryArtifact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  if (
    !hasExactKeys(summary, ["schemaVersion", "runId", "createdAt", "rows"]) ||
    summary.schemaVersion !== RUNTIME_SUMMARY_SCHEMA ||
    !isNonNegativeInteger(summary.runId) ||
    summary.runId < 1 ||
    typeof summary.createdAt !== "string" ||
    !Number.isFinite(Date.parse(summary.createdAt)) ||
    !Array.isArray(summary.rows) ||
    summary.rows.length > MAX_SUMMARY_ROWS
  ) {
    return null;
  }
  const rows = summary.rows.map(normalizeRuntimeRow);
  if (rows.some((row) => row === null)) return null;
  const identities = new Set(
    (rows as RuntimeAuditRow[]).map((row) => JSON.stringify([row.target, row.scenario])),
  );
  if (identities.size !== rows.length) return null;
  return {
    schemaVersion: RUNTIME_SUMMARY_SCHEMA,
    runId: summary.runId,
    createdAt: summary.createdAt,
    rows: rows as RuntimeAuditRow[],
  };
}

export function createRuntimeSummary(
  runId: number,
  createdAt: string,
  rows: readonly RuntimeAuditRow[],
): RuntimeSummaryArtifact {
  const summary = normalizeRuntimeSummary({
    schemaVersion: RUNTIME_SUMMARY_SCHEMA,
    runId,
    createdAt,
    rows,
  });
  if (summary === null) throw new Error("invalid current E2E runtime summary");
  return summary;
}

function parseRuntimeSummaryArchive(archive: Buffer): RuntimeSummaryArtifact | null {
  try {
    const contents = readValidatedArtifactZipEntry(archive, RUNTIME_SUMMARY_FILE, {
      maxBytes: MAX_SUMMARY_BYTES,
    });
    return contents === null ? null : normalizeRuntimeSummary(JSON.parse(contents));
  } catch {
    return null;
  }
}

async function readRuntimeSummaryFromRun(
  { github, context }: GitHubDeps,
  runId: number,
): Promise<RuntimeSummaryArtifact | null> {
  const artifacts = (await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    run_id: runId,
    per_page: 100,
  })) as Array<{ expired?: boolean; id: number; name: string }>;
  const artifact = artifacts.find(
    (candidate) => candidate.name === RUNTIME_SUMMARY_ARTIFACT && candidate.expired !== true,
  );
  if (!artifact) return null;
  const download = await github.rest.actions.downloadArtifact({
    owner: context.repo.owner,
    repo: context.repo.repo,
    artifact_id: artifact.id,
    archive_format: "zip",
  });
  const summary = parseRuntimeSummaryArchive(Buffer.from(download.data));
  return summary?.runId === runId ? summary : null;
}

export async function loadPriorNightlySummaries(
  deps: GitHubDeps,
): Promise<RuntimeSummaryArtifact[]> {
  const { github, context, core } = deps;
  const response = await github.rest.actions.listWorkflowRuns({
    owner: context.repo.owner,
    repo: context.repo.repo,
    workflow_id: WORKFLOW_FILE,
    event: "schedule",
    status: "completed",
    per_page: HISTORY_RUN_LIMIT + 5,
  });
  const runs = (response.data.workflow_runs as Array<{ id: number }>)
    .filter((run) => run.id !== context.runId)
    .slice(0, HISTORY_RUN_LIMIT);
  const summaries: RuntimeSummaryArtifact[] = [];
  for (const run of runs) {
    try {
      const summary = await readRuntimeSummaryFromRun(deps, run.id);
      if (summary !== null) summaries.push(summary);
    } catch {
      core?.warning?.(
        "One prior nightly runtime summary was unavailable; continuing with less history.",
      );
    }
  }
  return summaries;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatDelta(currentMs: number, priorMs: number): string {
  const deltaMs = currentMs - priorMs;
  const sign = deltaMs >= 0 ? "+" : "-";
  const percent = priorMs > 0 ? ` (${sign}${Math.abs((deltaMs / priorMs) * 100).toFixed(1)}%)` : "";
  return `${sign}${seconds(Math.abs(deltaMs))}${percent}`;
}

function formatOutcome(row: RuntimeAuditRow): string {
  if (row.failedRuns > 0) return "failed";
  if (row.skippedRuns > 0) return "skipped";
  return "passed";
}

function formatPassRate(rows: readonly RuntimeAuditRow[]): string {
  const passed = rows.reduce((total, row) => total + row.passedRuns, 0);
  const runs = rows.reduce((total, row) => total + row.runs, 0);
  return runs > 0 ? `${((passed / runs) * 100).toFixed(0)}% (${passed}/${runs})` : "n/a";
}

function passRate(rows: readonly RuntimeAuditRow[]): number {
  const passed = rows.reduce((total, row) => total + row.passedRuns, 0);
  const runs = rows.reduce((total, row) => total + row.runs, 0);
  return runs > 0 ? passed / runs : 1;
}

export function formatRuntimeHistory(
  currentRows: readonly RuntimeAuditRow[],
  priorSummaries: readonly RuntimeSummaryArtifact[],
): string {
  const lines = [
    "## E2E Nightly Runtime Trend",
    "",
    "Current run compared with up to 10 prior completed scheduled runs; manual runs are excluded.",
    "Rows prioritize current failures, lower historical pass rates, and larger runtime regressions.",
    "",
  ];
  if (currentRows.length === 0) {
    lines.push("No current runtime rows were available for comparison.");
    return `${lines.join("\n")}\n`;
  }
  if (priorSummaries.length === 0) {
    lines.push(
      "No prior nightly runtime summaries are available yet; this run starts the history.",
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "| Target | Scenario | Prior nights | Current median | Prior median | Prior p95 | Delta | Prior pass rate | Current |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  const comparisons = currentRows
    .map((current) => {
      const priorRows = priorSummaries.flatMap((summary) =>
        summary.rows.filter(
          (row) => row.target === current.target && row.scenario === current.scenario,
        ),
      );
      const priorMedian =
        priorRows.length > 0
          ? median(priorRows.map((row) => row.medianMs).sort((a, b) => a - b))
          : null;
      return { current, priorRows, priorMedian };
    })
    .sort(
      (a, b) =>
        Number(b.current.failedRuns > 0) - Number(a.current.failedRuns > 0) ||
        passRate(a.priorRows) - passRate(b.priorRows) ||
        Math.max(0, b.priorMedian === null ? 0 : b.current.medianMs - b.priorMedian) -
          Math.max(0, a.priorMedian === null ? 0 : a.current.medianMs - a.priorMedian) ||
        b.current.p95Ms - a.current.p95Ms,
    );
  for (const { current, priorRows, priorMedian } of comparisons.slice(0, 10)) {
    if (priorRows.length === 0) {
      lines.push(
        `| ${escapeCell(current.target)} | ${escapeCell(current.scenario)} | 0 | ${seconds(current.medianMs)} | n/a | n/a | n/a | n/a | ${formatOutcome(current)} |`,
      );
      continue;
    }
    const medians = priorRows.map((row) => row.medianMs).sort((a, b) => a - b);
    lines.push(
      `| ${escapeCell(current.target)} | ${escapeCell(current.scenario)} | ${priorRows.length} | ${seconds(current.medianMs)} | ${seconds(priorMedian ?? 0)} | ${seconds(percentile(medians, 0.95))} | ${formatDelta(current.medianMs, priorMedian ?? 0)} | ${formatPassRate(priorRows)} | ${formatOutcome(current)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function buildRuntimeHistory(
  deps: GitHubDeps,
  currentRows: readonly RuntimeAuditRow[],
  outputPath: string,
  services: RuntimeHistoryServices = { loadPriorNightlySummaries },
  now = new Date(),
): Promise<string> {
  const current = createRuntimeSummary(deps.context.runId, now.toISOString(), currentRows);
  fs.writeFileSync(outputPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try {
    const prior = await services.loadPriorNightlySummaries(deps);
    return formatRuntimeHistory(currentRows, prior);
  } catch {
    deps.core?.warning?.(
      "Nightly E2E runtime history unavailable; current summary was still saved.",
    );
    return formatRuntimeHistory(currentRows, []);
  }
}
