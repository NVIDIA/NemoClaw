// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type {
  RuntimeHistoryPhase,
  RuntimeHistorySample,
  RuntimeOutcome,
} from "../audit-test-runtime.mts";
import {
  evaluateFirstTurnLatencyRecurrence,
  type FirstTurnLatencySample,
  formatFirstTurnLatencyRecurrence,
  normalizeFirstTurnLatencySample,
} from "./analyze-first-turn-latency.mts";
import {
  evaluateSandboxPhaseTailRecurrence,
  formatSandboxPhaseTailRecurrence,
  normalizeSandboxPhaseTailSample,
  type SandboxPhaseTailSample,
} from "./analyze-sandbox-phase-tail.mts";
import { readValidatedArtifactZipEntry } from "./read-artifact-zip.mts";

export const RUNTIME_SUMMARY_ARTIFACT = "e2e-runtime-summary";
export const RUNTIME_SUMMARY_FILE = "e2e-runtime-summary.json";
export const RUNTIME_REGRESSION_MIN_DELTA_MS = 30_000;
export const RUNTIME_REGRESSION_MIN_PERCENT = 20;

const LEGACY_RUNTIME_SUMMARY_SCHEMA = "nemoclaw.e2e_runtime_summary.v1";
const PREVIOUS_RUNTIME_SUMMARY_SCHEMA = "nemoclaw.e2e_runtime_summary.v2";
const RUNTIME_SUMMARY_SCHEMA = "nemoclaw.e2e_runtime_summary.v3";
const WORKFLOW_FILE = "e2e.yaml";
const HISTORY_RUN_LIMIT = 30;
const HISTORY_QUERY_LIMIT = 30;
const RUNTIME_TREND_LIMIT = 10;
const FLAKE_WATCH_LIMIT = 5;
const MAX_SUMMARY_BYTES = 512 * 1024;
const MAX_SUMMARY_ROWS = 200;
const MAX_PHASES_PER_ROW = 32;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

type GitHubDeps = {
  github: any;
  context: { repo: { owner: string; repo: string }; runId: number };
  core?: {
    setFailed?: (message: string) => void;
    warning?: (message: string) => void;
  };
};

export interface RuntimeSummaryArtifact {
  schemaVersion:
    | typeof LEGACY_RUNTIME_SUMMARY_SCHEMA
    | typeof PREVIOUS_RUNTIME_SUMMARY_SCHEMA
    | typeof RUNTIME_SUMMARY_SCHEMA;
  runId: number;
  createdAt: string;
  firstTurnLatency: FirstTurnLatencySample | null;
  sandboxPhaseTail: SandboxPhaseTailSample | null;
  rows: RuntimeHistorySample[];
}

type RuntimeHistoryServices = {
  currentFirstTurnLatency?: FirstTurnLatencySample | null;
  currentSandboxPhaseTail?: SandboxPhaseTailSample | null;
  loadPriorPushHistory: (deps: GitHubDeps) => Promise<PriorPushHistory>;
};

export interface PriorPushHistory {
  summaries: RuntimeSummaryArtifact[];
  unavailableRuns: number;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 500 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isDuration(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS
  );
}

function isOutcome(value: unknown): value is RuntimeOutcome {
  return value === "passed" || value === "failed" || value === "skipped";
}

function normalizePhase(value: unknown): RuntimeHistoryPhase | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const phase = value as Record<string, unknown>;
  if (
    !hasExactKeys(phase, ["label", "durationMs", "outcome"]) ||
    !isBoundedString(phase.label) ||
    !isDuration(phase.durationMs) ||
    !isOutcome(phase.outcome)
  ) {
    return null;
  }
  return {
    label: phase.label,
    durationMs: phase.durationMs,
    outcome: phase.outcome,
  };
}

function normalizeSample(value: unknown): RuntimeHistorySample | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !hasExactKeys(row, ["target", "scenario", "durationMs", "outcome", "phases"]) ||
    !isBoundedString(row.target) ||
    !isBoundedString(row.scenario) ||
    !isDuration(row.durationMs) ||
    !isOutcome(row.outcome) ||
    !Array.isArray(row.phases) ||
    row.phases.length > MAX_PHASES_PER_ROW
  ) {
    return null;
  }
  const phases = row.phases.map(normalizePhase);
  if (phases.some((phase) => phase === null)) return null;
  const normalizedPhases = phases as RuntimeHistoryPhase[];
  if (new Set(normalizedPhases.map((phase) => phase.label)).size !== normalizedPhases.length) {
    return null;
  }
  return {
    target: row.target,
    scenario: row.scenario,
    durationMs: row.durationMs,
    outcome: row.outcome,
    phases: normalizedPhases,
  };
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function normalizeRuntimeSummary(value: unknown): RuntimeSummaryArtifact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  const legacy = summary.schemaVersion === LEGACY_RUNTIME_SUMMARY_SCHEMA;
  const previous = summary.schemaVersion === PREVIOUS_RUNTIME_SUMMARY_SCHEMA;
  const current = summary.schemaVersion === RUNTIME_SUMMARY_SCHEMA;
  if (
    (!legacy && !previous && !current) ||
    !hasExactKeys(
      summary,
      legacy
        ? ["schemaVersion", "runId", "createdAt", "rows"]
        : previous
          ? ["schemaVersion", "runId", "createdAt", "firstTurnLatency", "rows"]
          : ["schemaVersion", "runId", "createdAt", "firstTurnLatency", "sandboxPhaseTail", "rows"],
    ) ||
    !Number.isSafeInteger(summary.runId) ||
    (summary.runId as number) < 1 ||
    !isCanonicalTimestamp(summary.createdAt) ||
    !Array.isArray(summary.rows) ||
    summary.rows.length > MAX_SUMMARY_ROWS
  ) {
    return null;
  }
  const rows = summary.rows.map(normalizeSample);
  if (rows.some((row) => row === null)) return null;
  const normalizedRows = rows as RuntimeHistorySample[];
  const identities = normalizedRows.map((row) => JSON.stringify([row.target, row.scenario]));
  if (new Set(identities).size !== identities.length) return null;
  const firstTurnLatency =
    legacy || summary.firstTurnLatency === null
      ? null
      : normalizeFirstTurnLatencySample(summary.firstTurnLatency);
  if (!legacy && summary.firstTurnLatency !== null && firstTurnLatency === null) return null;
  const sandboxPhaseTail =
    current && summary.sandboxPhaseTail !== null
      ? normalizeSandboxPhaseTailSample(summary.sandboxPhaseTail)
      : null;
  if (current && summary.sandboxPhaseTail !== null && sandboxPhaseTail === null) return null;
  return {
    schemaVersion: legacy
      ? LEGACY_RUNTIME_SUMMARY_SCHEMA
      : previous
        ? PREVIOUS_RUNTIME_SUMMARY_SCHEMA
        : RUNTIME_SUMMARY_SCHEMA,
    runId: summary.runId as number,
    createdAt: summary.createdAt,
    firstTurnLatency,
    sandboxPhaseTail,
    rows: normalizedRows,
  };
}

export function createRuntimeSummary(
  runId: number,
  createdAt: string,
  rows: readonly RuntimeHistorySample[],
  firstTurnLatency: FirstTurnLatencySample | null = null,
  sandboxPhaseTail: SandboxPhaseTailSample | null = null,
): RuntimeSummaryArtifact {
  const summary = normalizeRuntimeSummary({
    schemaVersion: RUNTIME_SUMMARY_SCHEMA,
    runId,
    createdAt,
    firstTurnLatency,
    sandboxPhaseTail,
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
  const candidates = artifacts.filter(
    (artifact) => artifact.name === RUNTIME_SUMMARY_ARTIFACT && artifact.expired !== true,
  );
  if (candidates.length !== 1) return null;
  const download = await github.rest.actions.downloadArtifact({
    owner: context.repo.owner,
    repo: context.repo.repo,
    artifact_id: candidates[0]!.id,
    archive_format: "zip",
  });
  const summary = parseRuntimeSummaryArchive(Buffer.from(download.data));
  return summary?.runId === runId ? summary : null;
}

export async function loadPriorPushHistory(deps: GitHubDeps): Promise<PriorPushHistory> {
  const { github, context, core } = deps;
  const response = await github.rest.actions.listWorkflowRuns({
    owner: context.repo.owner,
    repo: context.repo.repo,
    workflow_id: WORKFLOW_FILE,
    event: "push",
    status: "completed",
    per_page: HISTORY_QUERY_LIMIT,
  });
  const runs = response.data.workflow_runs as Array<{ id: number }>;
  const summaries: RuntimeSummaryArtifact[] = [];
  let unavailableRuns = 0;
  for (const run of runs) {
    if (run.id === context.runId) continue;
    try {
      const summary = await readRuntimeSummaryFromRun(deps, run.id);
      if (summary === null) unavailableRuns += 1;
      else summaries.push(summary);
    } catch {
      unavailableRuns += 1;
      core?.warning?.(
        "One prior push runtime summary was unavailable; continuing with less history.",
      );
    }
    if (summaries.length === HISTORY_RUN_LIMIT) break;
  }
  return { summaries, unavailableRuns };
}

export async function loadPriorPushSummaries(deps: GitHubDeps): Promise<RuntimeSummaryArtifact[]> {
  return (await loadPriorPushHistory(deps)).summaries;
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
  const percent = priorMs > 0 ? (deltaMs / priorMs) * 100 : 0;
  return `${sign}${seconds(Math.abs(deltaMs))} (${sign}${Math.abs(percent).toFixed(1)}%)`;
}

function isSignificantRegression(currentMs: number, priorMs: number): boolean {
  const deltaMs = currentMs - priorMs;
  const percent = priorMs > 0 ? (deltaMs / priorMs) * 100 : 0;
  return deltaMs >= RUNTIME_REGRESSION_MIN_DELTA_MS && percent >= RUNTIME_REGRESSION_MIN_PERCENT;
}

function sampleFor(
  summary: RuntimeSummaryArtifact,
  current: RuntimeHistorySample,
): RuntimeHistorySample | undefined {
  return summary.rows.find(
    (row) => row.target === current.target && row.scenario === current.scenario,
  );
}

function outcomeRates(rows: readonly RuntimeHistorySample[]): string {
  const counts = countOutcomes(rows);
  const total = rows.length;
  if (total === 0) return "n/a";
  const rate = (count: number) => `${Math.round((count / total) * 100)}%`;
  return `${rate(counts.passed)}/${rate(counts.failed)}/${rate(counts.skipped)} (${counts.passed}/${counts.failed}/${counts.skipped})`;
}

function countOutcomes(rows: readonly RuntimeHistorySample[]) {
  return {
    passed: rows.filter((row) => row.outcome === "passed").length,
    failed: rows.filter((row) => row.outcome === "failed").length,
    skipped: rows.filter((row) => row.outcome === "skipped").length,
  };
}

function failureStreak(
  current: RuntimeHistorySample,
  priorSummaries: readonly RuntimeSummaryArtifact[],
): number {
  if (current.outcome !== "failed") return 0;
  let streak = 1;
  for (const summary of priorSummaries) {
    const prior = sampleFor(summary, current);
    if (!prior || prior.outcome !== "failed") break;
    streak += 1;
  }
  return streak;
}

function commonFailedPhase(rows: readonly RuntimeHistorySample[]): string {
  const counts = new Map<string, number>();
  for (const phase of rows.flatMap((row) => row.phases)) {
    if (phase.outcome !== "failed") continue;
    counts.set(phase.label, (counts.get(phase.label) ?? 0) + 1);
  }
  const mostCommon = [...counts.entries()].sort(
    ([leftLabel, leftCount], [rightLabel, rightCount]) =>
      rightCount - leftCount || leftLabel.localeCompare(rightLabel),
  )[0];
  return mostCommon ? `${mostCommon[0]} (${mostCommon[1]})` : "n/a";
}

function outcomeFlips(rows: readonly RuntimeHistorySample[]): number {
  const outcomes = rows
    .map((row) => row.outcome)
    .filter((outcome): outcome is "passed" | "failed" => outcome !== "skipped");
  return outcomes.slice(1).filter((outcome, index) => outcome !== outcomes[index]).length;
}

function formatFlakeWatch(
  currentRows: readonly RuntimeHistorySample[],
  priorSummaries: readonly RuntimeSummaryArtifact[],
): string[] {
  const rows = currentRows
    .flatMap((current) => {
      const observed = [
        current,
        ...priorSummaries.flatMap((summary) => {
          const prior = sampleFor(summary, current);
          return prior ? [prior] : [];
        }),
      ];
      const counts = countOutcomes(observed);
      if (counts.passed === 0 || counts.failed === 0) return [];
      const executed = counts.passed + counts.failed;
      return [
        {
          current,
          observed,
          counts,
          failureRate: Math.round((counts.failed / executed) * 100),
          flips: outcomeFlips(observed),
          streak: failureStreak(current, priorSummaries),
        },
      ];
    })
    .sort(
      (left, right) =>
        right.flips - left.flips ||
        right.counts.failed - left.counts.failed ||
        right.failureRate - left.failureRate ||
        right.observed.length - left.observed.length ||
        left.current.target.localeCompare(right.current.target) ||
        left.current.scenario.localeCompare(right.current.scenario),
    )
    .slice(0, FLAKE_WATCH_LIMIT);

  const lines = [
    "",
    "### Push flake watch",
    "",
    "Tests that both passed and failed across the current run and available push history. Ranked by pass/fail flips, then failures; skips do not affect the failure rate or flip count.",
    "",
  ];
  if (rows.length === 0) {
    lines.push("No tests both passed and failed in the available push window.");
    return lines;
  }
  lines.push(
    "| Target | Scenario | Runs | P/F/S | Failure rate | Pass/fail flips | Failure streak | Common failed phase |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const row of rows) {
    lines.push(
      `| ${escapeCell(row.current.target)} | ${escapeCell(row.current.scenario)} | ${row.observed.length} | ${row.counts.passed}/${row.counts.failed}/${row.counts.skipped} | ${row.failureRate}% | ${row.flips} | ${row.streak} | ${escapeCell(commonFailedPhase(row.observed))} |`,
    );
  }
  return lines;
}

function significantRegressions(
  current: RuntimeHistorySample,
  priorRows: readonly RuntimeHistorySample[],
): string {
  const findings: Array<{ deltaMs: number; text: string }> = [];
  const priorDurations = priorRows.map((row) => row.durationMs).sort((a, b) => a - b);
  const priorMedian = median(priorDurations);
  if (isSignificantRegression(current.durationMs, priorMedian)) {
    findings.push({
      deltaMs: current.durationMs - priorMedian,
      text: `total ${formatDelta(current.durationMs, priorMedian)}`,
    });
  }
  for (const phase of current.phases) {
    const priorPhaseDurations = priorRows
      .flatMap((row) => row.phases.filter((candidate) => candidate.label === phase.label))
      .map((candidate) => candidate.durationMs)
      .sort((a, b) => a - b);
    if (priorPhaseDurations.length === 0) continue;
    const priorPhaseMedian = median(priorPhaseDurations);
    if (!isSignificantRegression(phase.durationMs, priorPhaseMedian)) continue;
    findings.push({
      deltaMs: phase.durationMs - priorPhaseMedian,
      text: `${phase.label} ${formatDelta(phase.durationMs, priorPhaseMedian)}`,
    });
  }
  return findings.length === 0
    ? "—"
    : `⚠ ${findings
        .sort((left, right) => right.deltaMs - left.deltaMs || left.text.localeCompare(right.text))
        .slice(0, 3)
        .map((finding) => finding.text)
        .join("; ")}`;
}

export function formatRuntimeHistory(
  currentRows: readonly RuntimeHistorySample[],
  priorSummaries: readonly RuntimeSummaryArtifact[],
): string {
  const sortedPrior = [...priorSummaries]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, RUNTIME_TREND_LIMIT);
  const lines = [
    "## E2E Push Runtime Trend",
    "",
    `Current timing compared with up to ${RUNTIME_TREND_LIMIT} prior completed push runs; manual runs are excluded from history.`,
    `Regression warnings require both +${seconds(RUNTIME_REGRESSION_MIN_DELTA_MS)} and +${RUNTIME_REGRESSION_MIN_PERCENT}%.`,
    "",
  ];
  if (currentRows.length === 0) {
    lines.push("No current runtime rows were available for comparison.");
    return `${lines.join("\n")}\n`;
  }
  if (sortedPrior.length === 0) {
    lines.push("No prior push runtime summaries are available yet; this run starts the history.");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    "| Target | Scenario | Prior pushes | Current | Prior median | Prior p95 | Delta | Current outcome | Prior P/F/S | Failure streak | Common failed phase | Significant regressions |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- |",
  );
  for (const current of [...currentRows]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 10)) {
    const priorRows = sortedPrior.flatMap((summary) => {
      const row = sampleFor(summary, current);
      return row ? [row] : [];
    });
    if (priorRows.length === 0) {
      lines.push(
        `| ${escapeCell(current.target)} | ${escapeCell(current.scenario)} | 0 | ${seconds(current.durationMs)} | n/a | n/a | n/a | ${current.outcome} | n/a | ${failureStreak(current, sortedPrior)} | ${escapeCell(commonFailedPhase([current]))} | — |`,
      );
      continue;
    }
    const durations = priorRows.map((row) => row.durationMs).sort((a, b) => a - b);
    const priorMedian = median(durations);
    lines.push(
      `| ${escapeCell(current.target)} | ${escapeCell(current.scenario)} | ${priorRows.length} | ${seconds(current.durationMs)} | ${seconds(priorMedian)} | ${seconds(percentile(durations, 0.95))} | ${formatDelta(current.durationMs, priorMedian)} | ${current.outcome} | ${outcomeRates(priorRows)} | ${failureStreak(current, sortedPrior)} | ${escapeCell(commonFailedPhase([current, ...priorRows]))} | ${escapeCell(significantRegressions(current, priorRows))} |`,
    );
  }
  lines.push(...formatFlakeWatch(currentRows, sortedPrior));
  return `${lines.join("\n")}\n`;
}

export async function buildRuntimeHistory(
  deps: GitHubDeps,
  currentRows: readonly RuntimeHistorySample[],
  outputPath: string,
  services: RuntimeHistoryServices = { loadPriorPushHistory },
  now = new Date(),
): Promise<string> {
  const hasFirstTurnLatency = Object.hasOwn(services, "currentFirstTurnLatency");
  const hasSandboxPhaseTail = Object.hasOwn(services, "currentSandboxPhaseTail");
  const currentFirstTurnLatency = services.currentFirstTurnLatency ?? null;
  const fullE2EPassed = currentRows.some(
    (row) => row.target === "full-e2e" && row.outcome === "passed",
  );
  const currentSandboxPhaseTail = fullE2EPassed ? (services.currentSandboxPhaseTail ?? null) : null;
  let current: RuntimeSummaryArtifact;
  try {
    current = createRuntimeSummary(
      deps.context.runId,
      now.toISOString(),
      currentRows,
      currentFirstTurnLatency,
      currentSandboxPhaseTail,
    );
    const serialized = `${JSON.stringify(current, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_SUMMARY_BYTES) {
      throw new Error("current E2E runtime summary exceeds its size bound");
    }
    fs.writeFileSync(outputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    deps.core?.warning?.(
      "Current E2E runtime summary was invalid or could not be saved; push history is unavailable.",
    );
    if (currentSandboxPhaseTail?.anomaly) {
      deps.core?.setFailed?.(
        "Current sandbox phase anomaly could not be saved for recurrence enforcement.",
      );
    }
    return formatRuntimeHistory([], []);
  }
  try {
    const priorHistory = await services.loadPriorPushHistory(deps);
    const prior = priorHistory.summaries;
    const runtimeHistory = formatRuntimeHistory(current.rows, prior);
    const sections = [runtimeHistory];
    if (hasFirstTurnLatency) {
      const recurrence = evaluateFirstTurnLatencyRecurrence(current.firstTurnLatency, prior);
      if (!recurrence.passed && recurrence.message) deps.core?.setFailed?.(recurrence.message);
      sections.push(formatFirstTurnLatencyRecurrence(recurrence));
    }
    if (hasSandboxPhaseTail) {
      const recurrence = evaluateSandboxPhaseTailRecurrence(
        current.sandboxPhaseTail,
        prior,
        priorHistory.unavailableRuns === 0,
      );
      if (!recurrence.passed && recurrence.message) deps.core?.setFailed?.(recurrence.message);
      sections.push(formatSandboxPhaseTailRecurrence(recurrence));
    }
    return sections.join("\n");
  } catch {
    deps.core?.warning?.("Push E2E runtime history unavailable; current summary was still saved.");
    const runtimeHistory = formatRuntimeHistory(current.rows, []);
    const sections = [runtimeHistory];
    if (hasFirstTurnLatency) {
      sections.push(
        formatFirstTurnLatencyRecurrence(
          evaluateFirstTurnLatencyRecurrence(current.firstTurnLatency, []),
        ),
      );
    }
    if (hasSandboxPhaseTail) {
      const recurrence = evaluateSandboxPhaseTailRecurrence(current.sandboxPhaseTail, [], false);
      if (!recurrence.passed && recurrence.message) deps.core?.setFailed?.(recurrence.message);
      sections.push(formatSandboxPhaseTailRecurrence(recurrence));
    }
    return sections.join("\n");
  }
}
