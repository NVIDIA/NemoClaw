// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateFirstTurnLatencyRecurrence,
  FIRST_TURN_LATENCY_MIN_SAMPLES,
  type FirstTurnCohort,
  type FirstTurnLatencyHistorySummary,
  type FirstTurnLatencySample,
  formatFirstTurnLatencyRecurrence,
  readCurrentFirstTurnLatencySample,
} from "../../../scripts/scorecard/analyze-first-turn-latency.mts";

const COHORT: FirstTurnCohort = {
  agent: "openclaw",
  inferenceMode: "agent-thinking-off",
  model: "nvidia/nemotron-3-super-120b-a12b",
  promptContract: "sentinel-v1",
  provider: "NVIDIA",
};

function sample(anomaly: boolean, cohort: FirstTurnCohort = COHORT): FirstTurnLatencySample {
  const budgetMs = 14_000;
  const measurementMs = anomaly ? 14_500 : 8_000;
  return {
    anomaly,
    budgetMs,
    cohort,
    measurementMs,
    overageMs: Math.max(0, measurementMs - budgetMs),
  };
}

function summary(
  runId: number,
  firstTurnLatency: FirstTurnLatencySample | null,
): FirstTurnLatencyHistorySummary {
  return {
    createdAt: new Date(Date.UTC(2026, 6, runId)).toISOString(),
    firstTurnLatency,
    runId,
  };
}

function artifact(anomaly: boolean): Record<string, unknown> {
  const current = sample(anomaly);
  return {
    schemaVersion: "nemoclaw.full_e2e_cold_performance.v4",
    installExitCode: 0,
    firstTurnExitCode: 0,
    firstTurnSentinelMatched: true,
    phaseMeasurements: {
      rootEndToFirstTurnCompletionMs: current.measurementMs,
    },
    firstTurnCohort: current.cohort,
    budget: {
      rootEndToFirstTurnCompletionBudgetMs: current.budgetMs,
    },
    performance: {
      anomalies: anomaly
        ? [
            {
              budgetMs: current.budgetMs,
              kind: "first-turn-latency-tail",
              measurementMs: current.measurementMs,
              overageMs: current.overageMs,
            },
          ]
        : [],
      passed: true,
      violations: [],
    },
    buildKitFallback: false,
    usedBuildKitPrebuild: true,
    classicBuildSteps: 0,
    maxSilenceSecs: 20,
    maxSilenceBudgetSecs: 60,
  };
}

describe("hosted first-turn latency history", () => {
  it("reads an eligible current full-E2E sample and rejects failed functional evidence", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-first-turn-"));
    const artifactDirectory = path.join(directory, "e2e-full-e2e");
    const artifactFile = path.join(artifactDirectory, "onboard-progress-budget.json");
    try {
      expect(readCurrentFirstTurnLatencySample(directory)).toBeNull();

      fs.mkdirSync(artifactDirectory, { recursive: true });
      fs.writeFileSync(artifactFile, JSON.stringify(artifact(true)));

      expect(readCurrentFirstTurnLatencySample(directory)).toEqual(sample(true));

      const sandboxTail = artifact(false);
      sandboxTail.performance = {
        ...(sandboxTail.performance as Record<string, unknown>),
        anomalies: [
          {
            budgetMs: 208_000,
            kind: "sandbox-phase-tail",
            measurementMs: 208_136,
            overageMs: 136,
          },
        ],
      };
      fs.writeFileSync(artifactFile, JSON.stringify(sandboxTail));
      expect(readCurrentFirstTurnLatencySample(directory)).toEqual(sample(false));

      fs.writeFileSync(
        artifactFile,
        JSON.stringify({ ...artifact(true), firstTurnSentinelMatched: false }),
      );
      expect(readCurrentFirstTurnLatencySample(directory)).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an anomaly non-blocking until 12 eligible same-cohort samples exist (#6660)", () => {
    const prior = Array.from({ length: FIRST_TURN_LATENCY_MIN_SAMPLES - 2 }, (_, index) =>
      summary(index + 1, sample(index === 0)),
    );

    const result = evaluateFirstTurnLatencyRecurrence(sample(true), prior);

    expect(result).toMatchObject({
      anomalyCount: 2,
      eligibleSamples: FIRST_TURN_LATENCY_MIN_SAMPLES - 1,
      message: null,
      passed: true,
    });
    expect(formatFirstTurnLatencyRecurrence(result)).toContain(
      "Recurrence enforcement starts after the window is full.",
    );
  });

  it("blocks a current anomaly that a prior anomaly corroborates in a full window (#6660)", () => {
    const prior = Array.from({ length: FIRST_TURN_LATENCY_MIN_SAMPLES - 1 }, (_, index) =>
      summary(index + 1, sample(index === 0)),
    );

    const result = evaluateFirstTurnLatencyRecurrence(sample(true), prior);

    expect(result).toMatchObject({
      anomalyCount: 2,
      eligibleSamples: FIRST_TURN_LATENCY_MIN_SAMPLES,
      passed: false,
    });
    expect(result.message).toContain("2 anomalies in 12 eligible same-cohort samples");
  });

  it("does not mix cohorts or fail a current sample without an anomaly (#6660)", () => {
    const otherCohort = { ...COHORT, model: "other-model" };
    const prior = [
      summary(1, sample(true, otherCohort)),
      ...Array.from({ length: FIRST_TURN_LATENCY_MIN_SAMPLES - 1 }, (_, index) =>
        summary(index + 2, sample(index < 2)),
      ),
    ];

    expect(evaluateFirstTurnLatencyRecurrence(sample(true), prior)).toMatchObject({
      anomalyCount: 3,
      eligibleSamples: FIRST_TURN_LATENCY_MIN_SAMPLES,
      passed: false,
    });
    expect(evaluateFirstTurnLatencyRecurrence(sample(false), prior)).toMatchObject({
      anomalyCount: 2,
      eligibleSamples: FIRST_TURN_LATENCY_MIN_SAMPLES,
      passed: true,
    });
  });
});
