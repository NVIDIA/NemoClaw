// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readCurrentColdOnboardArtifact } from "./analyze-first-turn-latency.mts";

export const SANDBOX_PHASE_TAIL_MIN_SAMPLES = 5;
export const SANDBOX_PHASE_TAIL_MAX_ANOMALIES = 1;

const COLD_ONBOARD_ARTIFACT_SCHEMA = "nemoclaw.full_e2e_cold_performance.v4";
const SANDBOX_PHASE = "nemoclaw.onboard.phase.sandbox";
const SANDBOX_PHASE_ANOMALY_KIND = "sandbox-phase-tail";
const FIRST_TURN_ANOMALY_KIND = "first-turn-latency-tail";
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const SANDBOX_PHASE_SINGLE_OBSERVATION_MAX_OVERAGE_MS = 5_000;

export interface SandboxPhaseCohort {
  agent: string;
  baseBuildMode: string;
  platform: string;
  setupMode: string;
  workloadKind: string;
}

export interface SandboxPhaseTailSample {
  anomaly: boolean;
  budgetMs: number;
  cohort: SandboxPhaseCohort;
  measurementMs: number;
  overageMs: number;
}

export interface SandboxPhaseTailHistorySummary {
  createdAt: string;
  runId: number;
  sandboxPhaseTail: SandboxPhaseTailSample | null;
}

export interface SandboxPhaseTailRecurrence {
  anomalyCount: number;
  cohort: SandboxPhaseCohort | null;
  currentAnomaly: boolean;
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

function normalizeCohort(value: unknown): SandboxPhaseCohort | null {
  const cohort = asRecord(value);
  if (
    !cohort ||
    !hasExactKeys(cohort, ["agent", "baseBuildMode", "platform", "setupMode", "workloadKind"]) ||
    !isBoundedString(cohort.agent) ||
    !isBoundedString(cohort.baseBuildMode) ||
    !isBoundedString(cohort.platform) ||
    !isBoundedString(cohort.setupMode) ||
    !isBoundedString(cohort.workloadKind)
  ) {
    return null;
  }
  return {
    agent: cohort.agent,
    baseBuildMode: cohort.baseBuildMode,
    platform: cohort.platform,
    setupMode: cohort.setupMode,
    workloadKind: cohort.workloadKind,
  };
}

export function normalizeSandboxPhaseTailSample(value: unknown): SandboxPhaseTailSample | null {
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

function validWorkloadEvidence(
  artifact: Record<string, unknown>,
  cohort: SandboxPhaseCohort,
): boolean {
  const workload = asRecord(artifact.workload);
  if (!workload || workload.kind !== cohort.workloadKind) return false;
  if (cohort.workloadKind === "legacy-dockerfile") return artifact.usedBuildKitPrebuild === true;
  if (cohort.workloadKind === "managed-image") return artifact.usedBuildKitPrebuild === false;
  return false;
}

function normalizeAnomalyFinding(value: unknown): Record<string, unknown> | null {
  const finding = asRecord(value);
  if (
    !finding ||
    !hasExactKeys(finding, ["budgetMs", "kind", "measurementMs", "overageMs"]) ||
    (finding.kind !== SANDBOX_PHASE_ANOMALY_KIND && finding.kind !== FIRST_TURN_ANOMALY_KIND) ||
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

export function readCurrentSandboxPhaseTailSample(root: string): SandboxPhaseTailSample | null {
  const artifact = asRecord(readCurrentColdOnboardArtifact(root));
  if (!artifact) return null;
  const performance = asRecord(artifact.performance);
  const phaseMeasurements = asRecord(artifact.phaseMeasurements);
  const tracePhases = asRecord(phaseMeasurements?.tracePhasesMs);
  const budget = asRecord(artifact.budget);
  const phaseBudgets = asRecord(budget?.phaseBudgetsMs);
  const cohort = normalizeCohort(artifact.sandboxPhaseCohort);
  const anomalyValues = performance?.anomalies;
  if (
    artifact.schemaVersion !== COLD_ONBOARD_ARTIFACT_SCHEMA ||
    artifact.installExitCode !== 0 ||
    artifact.firstTurnExitCode !== 0 ||
    artifact.firstTurnSentinelMatched !== true ||
    artifact.buildKitFallback !== false ||
    artifact.classicBuildSteps !== 0 ||
    !isDuration(artifact.maxSilenceSecs) ||
    !isDuration(artifact.maxSilenceBudgetSecs) ||
    artifact.maxSilenceSecs > artifact.maxSilenceBudgetSecs ||
    !performance ||
    performance.passed !== true ||
    performance.usedAuthoritativeLocalBaseBuild !== false ||
    performance.appliedAuthoritativeLocalBaseBuildAllowanceMs !== 0 ||
    !Array.isArray(performance.violations) ||
    performance.violations.length !== 0 ||
    !Array.isArray(anomalyValues) ||
    anomalyValues.length > 1 ||
    !tracePhases ||
    !budget ||
    !phaseBudgets ||
    !cohort ||
    cohort.agent !== "openclaw" ||
    cohort.baseBuildMode !== "published-base" ||
    cohort.setupMode !== "source-install" ||
    !validWorkloadEvidence(artifact, cohort) ||
    !isDuration(tracePhases[SANDBOX_PHASE]) ||
    !isDuration(phaseBudgets[SANDBOX_PHASE]) ||
    !isDuration(budget.sandboxPhaseSingleObservationMaxOverageMs) ||
    budget.sandboxPhaseSingleObservationMaxOverageMs >
      SANDBOX_PHASE_SINGLE_OBSERVATION_MAX_OVERAGE_MS
  ) {
    return null;
  }

  const findings = anomalyValues.map(normalizeAnomalyFinding);
  if (findings.some((finding) => finding === null)) return null;
  const sandboxFinding = findings.find((finding) => finding?.kind === SANDBOX_PHASE_ANOMALY_KIND);
  const measurementMs = tracePhases[SANDBOX_PHASE];
  const budgetMs = phaseBudgets[SANDBOX_PHASE];
  const overageMs = Math.max(0, measurementMs - budgetMs);
  const anomaly = sandboxFinding !== undefined;
  if (anomaly !== overageMs > 0) return null;
  if (
    sandboxFinding &&
    (sandboxFinding.measurementMs !== measurementMs ||
      sandboxFinding.budgetMs !== budgetMs ||
      sandboxFinding.overageMs !== overageMs ||
      overageMs > budget.sandboxPhaseSingleObservationMaxOverageMs)
  ) {
    return null;
  }

  return { anomaly, budgetMs, cohort, measurementMs, overageMs };
}

function cohortIdentity(cohort: SandboxPhaseCohort): string {
  return JSON.stringify([
    cohort.agent,
    cohort.setupMode,
    cohort.platform,
    cohort.baseBuildMode,
    cohort.workloadKind,
  ]);
}

export function evaluateSandboxPhaseTailRecurrence(
  current: SandboxPhaseTailSample | null,
  priorSummaries: readonly SandboxPhaseTailHistorySummary[],
  historyComplete = true,
): SandboxPhaseTailRecurrence {
  if (current === null) {
    return {
      anomalyCount: 0,
      cohort: null,
      currentAnomaly: false,
      eligibleSamples: 0,
      message: null,
      passed: true,
    };
  }

  const identity = cohortIdentity(current.cohort);
  const priorSamples = [...priorSummaries]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .flatMap((summary) => {
      const sample = summary.sandboxPhaseTail;
      return sample && cohortIdentity(sample.cohort) === identity ? [sample] : [];
    });
  const window = [current, ...priorSamples].slice(0, SANDBOX_PHASE_TAIL_MIN_SAMPLES);
  const anomalyCount = window.filter((sample) => sample.anomaly).length;
  const enoughHistory = historyComplete && window.length === SANDBOX_PHASE_TAIL_MIN_SAMPLES;
  const passed =
    !current.anomaly || (enoughHistory && anomalyCount <= SANDBOX_PHASE_TAIL_MAX_ANOMALIES);
  const cohortLabel = `${current.cohort.agent}/${current.cohort.setupMode}/${current.cohort.platform}/${current.cohort.baseBuildMode}/${current.cohort.workloadKind}`;
  const message = passed
    ? null
    : !historyComplete
      ? `sandbox phase anomaly history is incomplete for ${cohortLabel}: one or more prior push summaries are unavailable`
      : !enoughHistory
        ? `sandbox phase anomaly history is incomplete for ${cohortLabel}: ${window.length} of ${SANDBOX_PHASE_TAIL_MIN_SAMPLES} eligible same-cohort samples are available`
        : `sandbox phase latency recurred for ${cohortLabel}: ${anomalyCount} anomalies in ${window.length} eligible same-cohort samples`;
  return {
    anomalyCount,
    cohort: current.cohort,
    currentAnomaly: current.anomaly,
    eligibleSamples: window.length,
    message,
    passed,
  };
}

export function formatSandboxPhaseTailRecurrence(result: SandboxPhaseTailRecurrence): string {
  const lines = ["## Sandbox Phase Latency", ""];
  if (result.cohort === null) {
    lines.push("No eligible current sandbox-phase sample was available.");
  } else if (!result.passed) {
    lines.push(`❌ ${result.message}.`);
  } else if (result.currentAnomaly) {
    lines.push(
      `The current anomaly passed with ${result.anomalyCount} anomaly in ${SANDBOX_PHASE_TAIL_MIN_SAMPLES} eligible same-cohort samples.`,
    );
  } else {
    lines.push(
      `The current sample passed with ${result.anomalyCount} anomalies in ${result.eligibleSamples} eligible same-cohort samples.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
