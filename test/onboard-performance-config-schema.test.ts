// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileConfigSchema } from "../scripts/validate-configs.mts";

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
  const adjustment = input.validationAdjustment?.derivedCapsMs;
  return {
    ...baseline,
    rootStartToFirstTurnCompletionBudgetMs: Math.max(
      baseline.rootStartToFirstTurnCompletionBudgetMs,
      adjustment?.rootStartToFirstTurnCompletionBudgetMs ??
        baseline.rootStartToFirstTurnCompletionBudgetMs,
    ),
    phaseBudgetsMs: {
      ...baseline.phaseBudgetsMs,
      "nemoclaw.onboard.phase.sandbox": Math.max(
        baseline.phaseBudgetsMs["nemoclaw.onboard.phase.sandbox"],
        adjustment?.sandboxPhaseBudgetMs ??
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

function changedImageInputs(
  fromSha: string,
  throughSha: string,
  imageInputPaths: string[],
): string[] {
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
      changedPaths: changedImageInputs(
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
    changedImageInputsThroughBoundary: changedImageInputs(
      validation.imageChangeSha,
      validation.imageInputsVerifiedThroughSha,
      validation.imageInputPaths,
    ),
  };
}

describe("full-E2E cold-path calibration", () => {
  // source-shape-contract: compatibility -- SHA provenance is durable evidence for the hosted-run budget calibration
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
  it("keeps baseline budgets derived from the checked-in samples", () => {
    const derived = deriveBudgets(calibration);
    expect(calibration.derivedBudgetsMs).toEqual(derived);
  });

  // source-shape-contract: compatibility -- Post-image-growth validation may adjust only observed stale cold-path caps without pretending to replace the five-run calibration
  it("keeps interim cap adjustments tied to functional post-change evidence", () => {
    const validation = calibration.validationAdjustment!;
    expect(validation.validatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(validation.imageChangeSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(validation.imageInputsVerifiedThroughSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(validation.imageInputPaths.length).toBeGreaterThan(0);
    expect(validation.imageInputPaths).toEqual(
      expect.arrayContaining([
        "scripts/patch-openclaw-tool-catalog.mts",
        "scripts/patch-openclaw-chat-send.mts",
        "scripts/patch-openclaw-mcp-npx.mts",
        "scripts/patch-openclaw-issue-4434-diagnostics.mts",
        "scripts/patch-openclaw-device-self-approval.mts",
      ]),
    );
    expect(validation.imageInputPaths).not.toEqual(
      expect.arrayContaining([
        "scripts/patch-openclaw-tool-catalog.js",
        "scripts/patch-openclaw-chat-send.js",
        "scripts/patch-openclaw-issue-4434-diagnostics.ts",
        "scripts/patch-openclaw-device-self-approval.ts",
      ]),
    );
    expect(validationProvenanceViolations(validation)).toEqual({
      nonDescendantRunHeads: [],
      runHeadsBeyondVerifiedInputs: [],
      runHeadsWithChangedImageInputs: [],
      changedImageInputsThroughBoundary: [],
    });
    expect(
      validationProvenanceViolations({
        ...validation,
        runs: [{ ...validation.runs[0], headSha: calibration.baselineMainSha }],
      }).nonDescendantRunHeads,
    ).toEqual([calibration.baselineMainSha]);
    const currentHeadSha = gitRevision("HEAD");
    expect(
      validationProvenanceViolations({
        ...validation,
        runs: [{ ...validation.runs[0], headSha: currentHeadSha }],
      }).runHeadsBeyondVerifiedInputs,
    ).toEqual([currentHeadSha]);
    const staleImageReference = validationProvenanceViolations({
      ...validation,
      imageChangeSha: calibration.baselineMainSha,
    });
    expect(staleImageReference.runHeadsWithChangedImageInputs.map((run) => run.headSha)).toEqual(
      validation.runs.map((run) => run.headSha),
    );
    expect(
      staleImageReference.runHeadsWithChangedImageInputs.flatMap((run) => run.changedPaths),
    ).toContain("agents/openclaw/wechat-runtime/package.json");
    expect(staleImageReference.changedImageInputsThroughBoundary).toContain(
      "agents/openclaw/wechat-runtime/package.json",
    );
    expect(validation.adjustedMetrics).toEqual([
      "rootStartToFirstTurnCompletion",
      "nemoclaw.onboard.phase.sandbox",
    ]);
    expect(validation.derivation.statistic).toBe("maximum");
    expect(validation.retirement).toEqual({
      trigger: "successful-single-sha-calibration",
      minimumSampleCount: 5,
      allSamplesSameHead: true,
      imageChangeMustBeAncestor: true,
      action: "replace-baseline-and-remove-adjustment",
    });
    expect(validation.runs).toHaveLength(4);
    expect(new Set(validation.runs.map((run) => run.runId)).size).toBe(4);
    expect(validation.runs.map((run) => run.conclusion).sort()).toEqual([
      "failure",
      "failure",
      "success",
      "success",
    ]);
    expect(validation.runs.map((run) => run.performancePassed).sort()).toEqual([
      false,
      false,
      true,
      true,
    ]);

    for (const run of validation.runs) {
      expect(run.runUrl).toBe(`https://github.com/NVIDIA/NemoClaw/actions/runs/${run.runId}`);
      expect(run.headSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(run).toMatchObject({
        installExitCode: 0,
        firstTurnExitCode: 0,
        usedBuildKitPrebuild: true,
        buildKitFallback: false,
      });
      expect(run.maxSilenceSecs).toBeLessThanOrEqual(60);
      expect(run.responseChars).toBeGreaterThan(0);
    }

    expect(validation.derivedCapsMs).toEqual({
      rootStartToFirstTurnCompletionBudgetMs: validationThreshold(
        validation.runs.map((run) => run.measurementsMs.rootStartToFirstTurnCompletion),
        validation.derivation,
      ),
      sandboxPhaseBudgetMs: validationThreshold(
        validation.runs.map((run) => run.measurementsMs.phases["nemoclaw.onboard.phase.sandbox"]),
        validation.derivation,
      ),
    });
    expect(checkedInConfig.fullE2eColdPath).toEqual(effectiveBudgets(calibration));
    expect(effectiveBudgets({ ...calibration, validationAdjustment: undefined })).toEqual(
      calibration.derivedBudgetsMs,
    );
  });
});
