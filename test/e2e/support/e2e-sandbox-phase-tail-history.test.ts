// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  evaluateSandboxPhaseTailRecurrence,
  formatSandboxPhaseTailRecurrence,
  readCurrentSandboxPhaseTailSample,
  type SandboxPhaseCohort,
  type SandboxPhaseTailHistorySummary,
  type SandboxPhaseTailSample,
} from "../../../scripts/scorecard/analyze-sandbox-phase-tail.mts";

const COHORT: SandboxPhaseCohort = {
  agent: "openclaw",
  baseBuildMode: "published-base",
  platform: "linux",
  setupMode: "source-install",
  workloadKind: "legacy-dockerfile",
};

function sample(anomaly: boolean, cohort: SandboxPhaseCohort = COHORT): SandboxPhaseTailSample {
  const budgetMs = 208_000;
  const measurementMs = anomaly ? 208_136 : 201_808;
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
  sandboxPhaseTail: SandboxPhaseTailSample | null,
): SandboxPhaseTailHistorySummary {
  return {
    createdAt: new Date(Date.UTC(2026, 7, runId)).toISOString(),
    runId,
    sandboxPhaseTail,
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
      tracePhasesMs: {
        "nemoclaw.onboard.phase.sandbox": current.measurementMs,
      },
    },
    sandboxPhaseCohort: current.cohort,
    budget: {
      sandboxPhaseSingleObservationMaxOverageMs: 5_000,
      phaseBudgetsMs: {
        "nemoclaw.onboard.phase.sandbox": current.budgetMs,
      },
    },
    performance: {
      anomalies: anomaly
        ? [
            {
              budgetMs: current.budgetMs,
              kind: "sandbox-phase-tail",
              measurementMs: current.measurementMs,
              overageMs: current.overageMs,
            },
          ]
        : [],
      appliedAuthoritativeLocalBaseBuildAllowanceMs: 0,
      passed: true,
      usedAuthoritativeLocalBaseBuild: false,
      violations: [],
    },
    workload: {
      kind: "legacy-dockerfile",
      reference: "nemoclaw-sandbox-local:e2e-full-test",
    },
    buildKitFallback: false,
    usedBuildKitPrebuild: true,
    classicBuildSteps: 0,
    maxSilenceSecs: 20,
    maxSilenceBudgetSecs: 60,
  };
}

describe("sandbox-phase latency history", () => {
  it("reads one eligible anomaly and rejects local-base or failed functional evidence (#6660)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-tail-"));
    const artifactDirectory = path.join(directory, "e2e-full-e2e");
    const artifactFile = path.join(artifactDirectory, "onboard-progress-budget.json");
    try {
      fs.mkdirSync(artifactDirectory, { recursive: true });
      fs.writeFileSync(artifactFile, JSON.stringify(artifact(true)));
      expect(readCurrentSandboxPhaseTailSample(directory)).toEqual(sample(true));

      const firstTurnTail = artifact(false);
      firstTurnTail.performance = {
        ...(firstTurnTail.performance as Record<string, unknown>),
        anomalies: [
          {
            budgetMs: 14_000,
            kind: "first-turn-latency-tail",
            measurementMs: 14_500,
            overageMs: 500,
          },
        ],
      };
      fs.writeFileSync(artifactFile, JSON.stringify(firstTurnTail));
      expect(readCurrentSandboxPhaseTailSample(directory)).toEqual(sample(false));

      const localBase = artifact(true);
      localBase.sandboxPhaseCohort = { ...COHORT, baseBuildMode: "authoritative-local-base-build" };
      localBase.performance = {
        ...(localBase.performance as Record<string, unknown>),
        appliedAuthoritativeLocalBaseBuildAllowanceMs: 570_000,
        usedAuthoritativeLocalBaseBuild: true,
      };
      fs.writeFileSync(artifactFile, JSON.stringify(localBase));
      expect(readCurrentSandboxPhaseTailSample(directory)).toBeNull();

      fs.writeFileSync(
        artifactFile,
        JSON.stringify({ ...artifact(true), firstTurnSentinelMatched: false }),
      );
      expect(readCurrentSandboxPhaseTailSample(directory)).toBeNull();

      const excessiveTail = artifact(true);
      const tracePhases = (excessiveTail.phaseMeasurements as Record<string, unknown>)
        .tracePhasesMs as Record<string, unknown>;
      tracePhases["nemoclaw.onboard.phase.sandbox"] = 213_001;
      const anomalies = (excessiveTail.performance as Record<string, unknown>).anomalies as Array<
        Record<string, unknown>
      >;
      anomalies[0] = { ...anomalies[0], measurementMs: 213_001, overageMs: 5_001 };
      fs.writeFileSync(artifactFile, JSON.stringify(excessiveTail));
      expect(readCurrentSandboxPhaseTailSample(directory)).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an artifact that raises the fixed single-observation overage ceiling (#6660)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sandbox-tail-ceiling-"));
    const artifactDirectory = path.join(directory, "e2e-full-e2e");
    const artifactFile = path.join(artifactDirectory, "onboard-progress-budget.json");
    try {
      const oversizedAllowance = artifact(true);
      const budget = oversizedAllowance.budget as Record<string, unknown>;
      budget.sandboxPhaseSingleObservationMaxOverageMs = 6_000;
      const tracePhases = (oversizedAllowance.phaseMeasurements as Record<string, unknown>)
        .tracePhasesMs as Record<string, unknown>;
      tracePhases["nemoclaw.onboard.phase.sandbox"] = 214_000;
      const anomalies = (oversizedAllowance.performance as Record<string, unknown>)
        .anomalies as Array<Record<string, unknown>>;
      anomalies[0] = { ...anomalies[0], measurementMs: 214_000, overageMs: 6_000 };

      fs.mkdirSync(artifactDirectory, { recursive: true });
      fs.writeFileSync(artifactFile, JSON.stringify(oversizedAllowance));

      expect(readCurrentSandboxPhaseTailSample(directory)).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows one anomaly after four valid same-cohort samples (#6660)", () => {
    const prior = Array.from({ length: 4 }, (_, index) => summary(index + 1, sample(false)));

    const result = evaluateSandboxPhaseTailRecurrence(sample(true), prior);

    expect(result).toMatchObject({
      anomalyCount: 1,
      currentAnomaly: true,
      eligibleSamples: 5,
      message: null,
      passed: true,
    });
    expect(formatSandboxPhaseTailRecurrence(result)).toContain(
      "current anomaly passed with 1 anomaly in 5 eligible same-cohort samples",
    );
  });

  it("blocks one anomaly when valid same-cohort history is incomplete (#6660)", () => {
    const prior = Array.from({ length: 3 }, (_, index) => summary(index + 1, sample(false)));

    const result = evaluateSandboxPhaseTailRecurrence(sample(true), prior);

    expect(result).toMatchObject({
      anomalyCount: 1,
      eligibleSamples: 4,
      passed: false,
    });
    expect(result.message).toContain("4 of 5 eligible same-cohort samples are available");
  });

  it("blocks one anomaly when a prior push summary is unavailable (#6660)", () => {
    const prior = Array.from({ length: 4 }, (_, index) => summary(index + 1, sample(false)));

    const result = evaluateSandboxPhaseTailRecurrence(sample(true), prior, false);

    expect(result).toMatchObject({
      anomalyCount: 1,
      eligibleSamples: 5,
      passed: false,
    });
    expect(result.message).toContain("one or more prior push summaries are unavailable");
  });

  it("blocks the second anomaly in the latest five eligible samples (#6660)", () => {
    const prior = Array.from({ length: 4 }, (_, index) => summary(index + 1, sample(index === 0)));

    const result = evaluateSandboxPhaseTailRecurrence(sample(true), prior);

    expect(result).toMatchObject({
      anomalyCount: 2,
      eligibleSamples: 5,
      passed: false,
    });
    expect(result.message).toContain("2 anomalies in 5 eligible same-cohort samples");
  });

  it("does not use a different cohort to satisfy the history requirement (#6660)", () => {
    const otherCohort = { ...COHORT, workloadKind: "managed-image" };
    const prior = [
      ...Array.from({ length: 3 }, (_, index) => summary(index + 1, sample(false))),
      summary(4, sample(false, otherCohort)),
    ];

    expect(evaluateSandboxPhaseTailRecurrence(sample(true), prior)).toMatchObject({
      eligibleSamples: 4,
      passed: false,
    });
    expect(evaluateSandboxPhaseTailRecurrence(sample(false), prior)).toMatchObject({
      eligibleSamples: 4,
      passed: true,
    });
  });
});
