// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export const FIRST_TURN_LATENCY_MIN_SAMPLES = 12;
export const FIRST_TURN_LATENCY_MAX_ANOMALIES = 1;

const FIRST_TURN_ARTIFACT_FILE = "onboard-progress-budget.json";
const FIRST_TURN_ARTIFACT_SCHEMA = "nemoclaw.full_e2e_cold_performance.v4";
const FIRST_TURN_ANOMALY_KIND = "first-turn-latency-tail";
const SANDBOX_PHASE_ANOMALY_KIND = "sandbox-phase-tail";
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_DIRECTORY_DEPTH = 4;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export interface FirstTurnCohort {
  agent: string;
  inferenceMode: string;
  model: string;
  promptContract: string;
  provider: string;
}

export interface FirstTurnLatencySample {
  anomaly: boolean;
  budgetMs: number;
  cohort: FirstTurnCohort;
  measurementMs: number;
  overageMs: number;
}

export interface FirstTurnLatencyHistorySummary {
  createdAt: string;
  firstTurnLatency: FirstTurnLatencySample | null;
  runId: number;
}

export interface FirstTurnLatencyRecurrence {
  anomalyCount: number;
  cohort: FirstTurnCohort | null;
  eligibleSamples: number;
  message: string | null;
  passed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function normalizeCohort(value: unknown): FirstTurnCohort | null {
  const cohort = asRecord(value);
  if (
    !cohort ||
    !hasExactKeys(cohort, ["agent", "inferenceMode", "model", "promptContract", "provider"]) ||
    !isBoundedString(cohort.agent) ||
    !isBoundedString(cohort.inferenceMode) ||
    !isBoundedString(cohort.model) ||
    !isBoundedString(cohort.promptContract) ||
    !isBoundedString(cohort.provider)
  ) {
    return null;
  }
  return {
    agent: cohort.agent,
    inferenceMode: cohort.inferenceMode,
    model: cohort.model,
    promptContract: cohort.promptContract,
    provider: cohort.provider,
  };
}

export function normalizeFirstTurnLatencySample(value: unknown): FirstTurnLatencySample | null {
  const sample = asRecord(value);
  if (
    !sample ||
    !hasExactKeys(sample, ["anomaly", "budgetMs", "cohort", "measurementMs", "overageMs"]) ||
    typeof sample.anomaly !== "boolean" ||
    !isDuration(sample.budgetMs) ||
    !isDuration(sample.measurementMs) ||
    !isDuration(sample.overageMs)
  ) {
    return null;
  }
  const cohort = normalizeCohort(sample.cohort);
  if (
    !cohort ||
    sample.overageMs !== Math.max(0, sample.measurementMs - sample.budgetMs) ||
    sample.anomaly !== sample.overageMs > 0
  ) {
    return null;
  }
  return {
    anomaly: sample.anomaly,
    budgetMs: sample.budgetMs,
    cohort,
    measurementMs: sample.measurementMs,
    overageMs: sample.overageMs,
  };
}

function normalizePerformanceAnomaly(value: unknown): Record<string, unknown> | null {
  const finding = asRecord(value);
  if (
    !finding ||
    !hasExactKeys(finding, ["budgetMs", "kind", "measurementMs", "overageMs"]) ||
    (finding.kind !== FIRST_TURN_ANOMALY_KIND && finding.kind !== SANDBOX_PHASE_ANOMALY_KIND) ||
    !isDuration(finding.budgetMs) ||
    !isDuration(finding.measurementMs) ||
    !isDuration(finding.overageMs) ||
    finding.overageMs !== (finding.measurementMs as number) - (finding.budgetMs as number) ||
    finding.overageMs <= 0
  ) {
    return null;
  }
  return finding;
}

function findArtifactFiles(root: string): string[] {
  const matches: string[] = [];
  let visited = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_DIRECTORY_DEPTH || visited > MAX_DIRECTORY_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_DIRECTORY_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, depth + 1);
      } else if (entry.isFile() && entry.name === FIRST_TURN_ARTIFACT_FILE) {
        matches.push(candidate);
      }
    }
  };
  visit(root, 0);
  return matches;
}

export function readCurrentColdOnboardArtifact(root: string): unknown {
  const matches = findArtifactFiles(root);
  if (matches.length !== 1) return null;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(matches[0]!, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) return null;
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function readCurrentFirstTurnLatencySample(root: string): FirstTurnLatencySample | null {
  const artifact = asRecord(readCurrentColdOnboardArtifact(root));
  if (!artifact) return null;
  const performance = asRecord(artifact.performance);
  const phaseMeasurements = asRecord(artifact.phaseMeasurements);
  const budget = asRecord(artifact.budget);
  const cohort = normalizeCohort(artifact.firstTurnCohort);
  if (
    artifact.schemaVersion !== FIRST_TURN_ARTIFACT_SCHEMA ||
    artifact.installExitCode !== 0 ||
    artifact.firstTurnExitCode !== 0 ||
    artifact.firstTurnSentinelMatched !== true ||
    artifact.buildKitFallback !== false ||
    artifact.usedBuildKitPrebuild !== true ||
    artifact.classicBuildSteps !== 0 ||
    !isDuration(artifact.maxSilenceSecs) ||
    !isDuration(artifact.maxSilenceBudgetSecs) ||
    artifact.maxSilenceSecs > artifact.maxSilenceBudgetSecs ||
    !performance ||
    performance.passed !== true ||
    !Array.isArray(performance.violations) ||
    performance.violations.length !== 0 ||
    !Array.isArray(performance.anomalies) ||
    performance.anomalies.length > 1 ||
    !phaseMeasurements ||
    !budget ||
    !cohort ||
    !isDuration(phaseMeasurements.rootEndToFirstTurnCompletionMs) ||
    !isDuration(budget.rootEndToFirstTurnCompletionBudgetMs)
  ) {
    return null;
  }

  const measurementMs = phaseMeasurements.rootEndToFirstTurnCompletionMs;
  const budgetMs = budget.rootEndToFirstTurnCompletionBudgetMs;
  const overageMs = Math.max(0, measurementMs - budgetMs);
  const findings = performance.anomalies.map(normalizePerformanceAnomaly);
  if (findings.some((finding) => finding === null)) return null;
  const finding = findings.find((candidate) => candidate?.kind === FIRST_TURN_ANOMALY_KIND);
  const anomaly = finding !== undefined;
  if (anomaly !== overageMs > 0) return null;
  if (
    finding &&
    (finding.measurementMs !== measurementMs ||
      finding.budgetMs !== budgetMs ||
      finding.overageMs !== overageMs)
  ) {
    return null;
  }

  return { anomaly, budgetMs, cohort, measurementMs, overageMs };
}

function cohortIdentity(cohort: FirstTurnCohort): string {
  return JSON.stringify([
    cohort.agent,
    cohort.inferenceMode,
    cohort.model,
    cohort.provider,
    cohort.promptContract,
  ]);
}

export function evaluateFirstTurnLatencyRecurrence(
  current: FirstTurnLatencySample | null,
  priorSummaries: readonly FirstTurnLatencyHistorySummary[],
): FirstTurnLatencyRecurrence {
  if (current === null) {
    return {
      anomalyCount: 0,
      cohort: null,
      eligibleSamples: 0,
      message: null,
      passed: true,
    };
  }

  const identity = cohortIdentity(current.cohort);
  const priorSamples = [...priorSummaries]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .flatMap((summary) => {
      const sample = summary.firstTurnLatency;
      return sample && cohortIdentity(sample.cohort) === identity ? [sample] : [];
    });
  const window = [current, ...priorSamples].slice(0, FIRST_TURN_LATENCY_MIN_SAMPLES);
  const anomalyCount = window.filter((sample) => sample.anomaly).length;
  const passed =
    window.length < FIRST_TURN_LATENCY_MIN_SAMPLES ||
    !current.anomaly ||
    anomalyCount <= FIRST_TURN_LATENCY_MAX_ANOMALIES;
  const cohortLabel = `${current.cohort.provider}/${current.cohort.model}/${current.cohort.inferenceMode}/${current.cohort.promptContract}`;
  return {
    anomalyCount,
    cohort: current.cohort,
    eligibleSamples: window.length,
    message: passed
      ? null
      : `hosted first-turn latency recurred for ${cohortLabel}: ${anomalyCount} anomalies in ${window.length} eligible same-cohort samples`,
    passed,
  };
}

export function formatFirstTurnLatencyRecurrence(result: FirstTurnLatencyRecurrence): string {
  const lines = ["## Hosted First-Turn Latency", ""];
  if (result.cohort === null) {
    lines.push("No eligible current first-turn sample was available.");
  } else if (result.eligibleSamples < FIRST_TURN_LATENCY_MIN_SAMPLES) {
    lines.push(
      `${result.eligibleSamples} of ${FIRST_TURN_LATENCY_MIN_SAMPLES} eligible same-cohort samples are available. Recurrence enforcement starts after the window is full.`,
    );
  } else if (result.passed) {
    lines.push(
      `The current sample passed the recurrence rule with ${result.anomalyCount} anomalous samples in the ${FIRST_TURN_LATENCY_MIN_SAMPLES}-sample same-cohort window.`,
    );
  } else {
    lines.push(`❌ ${result.message}.`);
  }
  return `${lines.join("\n")}\n`;
}
