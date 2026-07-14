// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileConfigSchema } from "../scripts/validate-configs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHASE_NAMES = [
  "nemoclaw.onboard.phase.preflight",
  "nemoclaw.onboard.phase.gateway",
  "nemoclaw.onboard.phase.provider_selection",
  "nemoclaw.onboard.phase.inference",
  "nemoclaw.onboard.phase.sandbox",
] as const;
type PhaseName = (typeof PHASE_NAMES)[number];
type PhaseBudgets = Record<PhaseName, number>;
interface ColdPathBudget {
  rootStartToFirstTurnCompletionBudgetMs: number;
  rootEndToFirstTurnCompletionBudgetMs: number;
  phaseBudgetsMs: PhaseBudgets;
}
interface CalibrationSample {
  runId: number;
  runUrl: string;
  headSha: string;
  conclusion: string;
  installExitCode: number;
  firstTurnExitCode: number;
  performancePassed: boolean;
  usedBuildKitPrebuild: boolean;
  buildKitFallback: boolean;
  maxSilenceSecs: number;
  responseChars: number;
  measurementsMs: {
    onboardRoot: number;
    rootStartToFirstTurnCompletion: number;
    rootEndToInstallCompletion: number;
    firstTurnCommand: number;
    rootEndToFirstTurnCompletion: number;
    phases: PhaseBudgets;
  };
}
interface Calibration {
  schemaVersion: number;
  baselineMainSha: string;
  measurementHeadSha: string;
  derivation: {
    percentile: number;
    percentileMethod: string;
    minimumHeadroomMs: number;
    relativeHeadroomPercent: number;
    roundUpMs: number;
  };
  samples: CalibrationSample[];
  derivedBudgetsMs: ColdPathBudget;
}

const checkedInConfig = JSON.parse(
  readFileSync(join(REPO_ROOT, "ci", "onboard-performance-budget.json"), "utf8"),
) as { fullE2eColdPath: ColdPathBudget };
const calibration = JSON.parse(
  readFileSync(join(REPO_ROOT, "ci", "full-e2e-cold-path-calibration.json"), "utf8"),
) as Calibration;

const validate = compileConfigSchema("schemas/onboard-config.schema.json");
const phaseBudgetsMs = Object.fromEntries(PHASE_NAMES.map((name) => [name, 1_000]));
const validConfig = {
  $comment: "Schema fixture",
  schemaVersion: 1,
  mode: "advisory",
  scope: "fixture",
  totalBudgetMs: 1_000,
  regressionWarning: { minDeltaMs: 0, minPercent: 0 },
  phaseRegressionWarning: { minDeltaMs: 0, minPercent: 0 },
  fullE2eColdPath: {
    rootStartToFirstTurnCompletionBudgetMs: 5_000,
    rootEndToFirstTurnCompletionBudgetMs: 1_000,
    phaseBudgetsMs,
  },
};

describe("onboard performance config schema", () => {
  it("accepts a complete synthetic config", () => {
    expect(validate(validConfig), JSON.stringify(validate.errors)).toBe(true);
  });

  it("requires the cold-path config at the root", () => {
    const { fullE2eColdPath: _, ...withoutColdPath } = validConfig;
    expect(validate(withoutColdPath)).toBe(false);
  });

  it("enforces the root-end budget against the root-start budget", () => {
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: {
          ...validConfig.fullE2eColdPath,
          rootEndToFirstTurnCompletionBudgetMs: 5_001,
        },
      }),
    ).toBe(false);
  });

  it.each(PHASE_NAMES)("requires the %s budget", (phaseName) => {
    const incompletePhases = { ...phaseBudgetsMs };
    delete incompletePhases[phaseName];
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: { ...validConfig.fullE2eColdPath, phaseBudgetsMs: incompletePhases },
      }),
    ).toBe(false);
  });

  it("rejects unknown, negative, and non-schema threshold values", () => {
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: {
          ...validConfig.fullE2eColdPath,
          phaseBudgetsMs: { ...phaseBudgetsMs, "nemoclaw.onboard.phase.typo": 1 },
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: {
          ...validConfig.fullE2eColdPath,
          rootStartToFirstTurnCompletionBudgetMs: -1,
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...validConfig,
        regressionWarning: { minDeltaMs: -1, minPercent: 20 },
      }),
    ).toBe(false);
  });
});

function derivedThreshold(values: number[], derivation: Calibration["derivation"]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((derivation.percentile / 100) * sorted.length));
  const percentileValue = sorted[rank - 1];
  const headroom = Math.max(
    derivation.minimumHeadroomMs,
    percentileValue * (derivation.relativeHeadroomPercent / 100),
  );
  return Math.ceil((percentileValue + headroom) / derivation.roundUpMs) * derivation.roundUpMs;
}

function deriveBudgets(input: Calibration): ColdPathBudget {
  const threshold = (values: number[]) => derivedThreshold(values, input.derivation);
  const phaseBudgets = {} as PhaseBudgets;
  for (const phaseName of PHASE_NAMES) {
    phaseBudgets[phaseName] = threshold(
      input.samples.map((sample) => sample.measurementsMs.phases[phaseName]),
    );
  }
  return {
    rootStartToFirstTurnCompletionBudgetMs: threshold(
      input.samples.map((sample) => sample.measurementsMs.rootStartToFirstTurnCompletion),
    ),
    rootEndToFirstTurnCompletionBudgetMs: threshold(
      input.samples.map((sample) => sample.measurementsMs.rootEndToFirstTurnCompletion),
    ),
    phaseBudgetsMs: phaseBudgets,
  };
}

describe("full-E2E cold-path calibration", () => {
  // source-shape-contract: compatibility -- Exact-head provenance is durable evidence for the hosted-run budget calibration
  it("records five independent successful samples for current main", () => {
    expect(calibration.schemaVersion).toBe(1);
    expect(calibration.baselineMainSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(calibration.measurementHeadSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(calibration.derivation.percentileMethod).toBe("nearest-rank");
    expect(calibration.samples).toHaveLength(5);
    expect(new Set(calibration.samples.map((sample) => sample.runId)).size).toBe(5);

    for (const sample of calibration.samples) {
      expect(sample.runUrl).toBe(`https://github.com/NVIDIA/NemoClaw/actions/runs/${sample.runId}`);
      expect(sample.headSha).toBe(calibration.measurementHeadSha);
      expect(sample).toMatchObject({
        conclusion: "success",
        installExitCode: 0,
        firstTurnExitCode: 0,
        performancePassed: true,
        usedBuildKitPrebuild: true,
        buildKitFallback: false,
      });
      expect(sample.maxSilenceSecs).toBeLessThanOrEqual(60);
      expect(sample.responseChars).toBeGreaterThan(0);
      expect(Object.keys(sample.measurementsMs.phases).sort()).toEqual([...PHASE_NAMES].sort());
      for (const value of [
        sample.measurementsMs.onboardRoot,
        sample.measurementsMs.rootStartToFirstTurnCompletion,
        sample.measurementsMs.rootEndToInstallCompletion,
        sample.measurementsMs.firstTurnCommand,
        sample.measurementsMs.rootEndToFirstTurnCompletion,
        ...Object.values(sample.measurementsMs.phases),
      ]) {
        expect(Number.isFinite(value) && value >= 0).toBe(true);
      }
    }
  });

  // source-shape-contract: compatibility -- Recomputed thresholds keep enforced budgets tied to the reviewed calibration evidence
  it("keeps configured budgets derived from the checked-in samples", () => {
    const derived = deriveBudgets(calibration);
    expect(calibration.derivedBudgetsMs).toEqual(derived);
    expect(checkedInConfig.fullE2eColdPath).toEqual(derived);
  });
});
