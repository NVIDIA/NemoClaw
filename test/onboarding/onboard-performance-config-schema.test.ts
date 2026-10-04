// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { compileConfigSchema } from "../../scripts/validate-configs.mts";

const PHASE_NAMES = [
  "nemoclaw.onboard.phase.preflight",
  "nemoclaw.onboard.phase.gateway",
  "nemoclaw.onboard.phase.provider_selection",
  "nemoclaw.onboard.phase.inference",
  "nemoclaw.onboard.phase.sandbox",
] as const;

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
