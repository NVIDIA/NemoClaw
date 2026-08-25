// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileConfigSchema } from "../../scripts/validate-configs.mts";

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
  authoritativeLocalBaseBuildAllowanceMs: number;
  sandboxPhaseSingleObservationMaxOverageMs: number;
  rootStartToFirstTurnCompletionBudgetMs: number;
  rootEndToFirstTurnCompletionBudgetMs: number;
  phaseBudgetsMs: PhaseBudgets;
}
type CalibratedColdPathBudget = Omit<
  ColdPathBudget,
  "authoritativeLocalBaseBuildAllowanceMs" | "sandboxPhaseSingleObservationMaxOverageMs"
>;
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
  validationAdjustment?: {
    validatedAt: string;
    imageChangeSha: string;
    imageInputsVerifiedThroughSha: string;
    imageInputPaths: string[];
    adjustedMetrics: string[];
    derivation: {
      statistic: string;
      minimumHeadroomMs: number;
      relativeHeadroomPercent: number;
      roundUpMs: number;
    };
    retirement: {
      trigger: string;
      minimumSampleCount: number;
      allSamplesSameHead: boolean;
      imageChangeMustBeAncestor: boolean;
      action: string;
    };
    runs: CalibrationSample[];
    derivedCapsMs: {
      rootStartToFirstTurnCompletionBudgetMs: number;
      sandboxPhaseBudgetMs: number;
    };
  };
  restartSafeStartupAdjustment?: {
    validatedAt: string;
    changeSha: string;
    runtimeInputsVerifiedThroughSha: string;
    runtimeInputPaths: string[];
    triggerOutput: string;
    adjustedMetrics: string[];
    derivation: {
      statistic: string;
      minimumHeadroomMs: number;
      relativeHeadroomPercent: number;
      roundUpMs: number;
    };
    runs: Array<{
      runId: number;
      runUrl: string;
      jobId: number;
      workflowHeadSha: string;
      testedSha: string;
      conclusion: string;
      installExitCode: number;
      firstTurnExitCode: number;
      firstTurnSentinelMatched: boolean;
      performancePassed: boolean;
      usedBuildKitPrebuild: boolean;
      buildKitFallback: boolean;
      maxSilenceSecs: number;
      responseChars: number;
      triggerEvidence: {
        artifact: string;
        path: string;
        output: string;
      };
      rootStartToFirstTurnCompletionMs: number;
      sandboxPhaseMs: number;
    }>;
    retirement: {
      trigger: string;
      minimumSampleCount: number;
      allSamplesSameHead: boolean;
      runtimeChangeMustBeAncestor: boolean;
      action: string;
    };
    derivedCapsMs: {
      rootStartToFirstTurnCompletionBudgetMs: number;
      sandboxPhaseBudgetMs: number;
    };
  };
  authoritativeLocalBaseBuildAdjustment: {
    validatedAt: string;
    triggerOutput: string;
    adjustedMetrics: string[];
    derivation: {
      statistic: string;
      minimumHeadroomMs: number;
      relativeHeadroomPercent: number;
      roundUpMs: number;
    };
    runs: Array<{
      runId: number;
      runUrl: string;
      headSha: string;
      triggerEvidence: {
        artifact: string;
        path: string;
        output: string;
      };
      nativeSecurityInputPaths: string[];
      rootStartToFirstTurnCompletionMs: number;
      sandboxPhaseMs: number;
    }>;
    retirement: {
      trigger: string;
      minimumSampleCount: number;
      allSamplesSameHead: boolean;
      nativeSecurityInputsMustBeUnchanged: boolean;
      action: string;
    };
    derivedAllowanceMs: number;
  };
  derivedBudgetsMs: CalibratedColdPathBudget;
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
    authoritativeLocalBaseBuildAllowanceMs: 500,
    sandboxPhaseSingleObservationMaxOverageMs: 5_000,
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

  it("requires the authoritative local-build allowance", () => {
    const { authoritativeLocalBaseBuildAllowanceMs: _, ...withoutLocalBuildAllowance } =
      validConfig.fullE2eColdPath;
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: withoutLocalBuildAllowance,
      }),
    ).toBe(false);
  });

  it("requires the sandbox-phase single-observation overage limit", () => {
    const { sandboxPhaseSingleObservationMaxOverageMs: _, ...withoutSandboxTailLimit } =
      validConfig.fullE2eColdPath;
    expect(
      validate({
        ...validConfig,
        fullE2eColdPath: withoutSandboxTailLimit,
      }),
    ).toBe(false);
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

function deriveBudgets(input: Calibration): CalibratedColdPathBudget {
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

function validationThreshold(
  values: number[],
  derivation: NonNullable<Calibration["validationAdjustment"]>["derivation"],
): number {
  const maximum = Math.max(...values);
  const headroom = Math.max(
    derivation.minimumHeadroomMs,
    maximum * (derivation.relativeHeadroomPercent / 100),
  );
  return Math.ceil((maximum + headroom) / derivation.roundUpMs) * derivation.roundUpMs;
}

function effectiveBudgets(input: Calibration): ColdPathBudget {
  const baseline = input.derivedBudgetsMs;
  const imageAdjustment = input.validationAdjustment?.derivedCapsMs;
  const startupAdjustment = input.restartSafeStartupAdjustment?.derivedCapsMs;
  return {
    authoritativeLocalBaseBuildAllowanceMs:
      input.authoritativeLocalBaseBuildAdjustment.derivedAllowanceMs,
    sandboxPhaseSingleObservationMaxOverageMs:
      checkedInConfig.fullE2eColdPath.sandboxPhaseSingleObservationMaxOverageMs,
    ...baseline,
    rootStartToFirstTurnCompletionBudgetMs: Math.max(
      baseline.rootStartToFirstTurnCompletionBudgetMs,
      imageAdjustment?.rootStartToFirstTurnCompletionBudgetMs ??
        baseline.rootStartToFirstTurnCompletionBudgetMs,
      startupAdjustment?.rootStartToFirstTurnCompletionBudgetMs ??
        baseline.rootStartToFirstTurnCompletionBudgetMs,
    ),
    phaseBudgetsMs: {
      ...baseline.phaseBudgetsMs,
      "nemoclaw.onboard.phase.sandbox": Math.max(
        baseline.phaseBudgetsMs["nemoclaw.onboard.phase.sandbox"],
        imageAdjustment?.sandboxPhaseBudgetMs ??
          baseline.phaseBudgetsMs["nemoclaw.onboard.phase.sandbox"],
        startupAdjustment?.sandboxPhaseBudgetMs ??
          baseline.phaseBudgetsMs["nemoclaw.onboard.phase.sandbox"],
      ),
    },
  };
}

function gitIsAncestor(ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  switch (result.status) {
    case 0:
      return true;
    case 1:
      return false;
    default:
      throw new Error(
        `git merge-base could not verify calibration ancestry; ensure the checkout has full history (status ${String(result.status)}): ${result.error?.message ?? result.stderr.trim()}`,
      );
  }
}

function gitRevision(revision: string): string {
  return execFileSync("git", ["rev-parse", "--verify", revision], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
}

function changedInputs(fromSha: string, throughSha: string, imageInputPaths: string[]): string[] {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", fromSha, throughSha, "--", ...imageInputPaths],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim();
  return output === "" ? [] : output.split(/\r?\n/u);
}

function validationProvenanceViolations(
  validation: NonNullable<Calibration["validationAdjustment"]>,
) {
  const runHeadsWithChangedImageInputs = validation.runs
    .map((run) => ({
      headSha: run.headSha,
      changedPaths: changedInputs(
        validation.imageChangeSha,
        run.headSha,
        validation.imageInputPaths,
      ),
    }))
    .filter((run) => run.changedPaths.length > 0);
  return {
    nonDescendantRunHeads: validation.runs
      .map((run) => run.headSha)
      .filter((headSha) => !gitIsAncestor(validation.imageChangeSha, headSha)),
    runHeadsBeyondVerifiedInputs: validation.runs
      .map((run) => run.headSha)
      .filter((headSha) => !gitIsAncestor(headSha, validation.imageInputsVerifiedThroughSha)),
    runHeadsWithChangedImageInputs,
    changedImageInputsThroughBoundary: changedInputs(
      validation.imageChangeSha,
      validation.imageInputsVerifiedThroughSha,
      validation.imageInputPaths,
    ),
  };
}
