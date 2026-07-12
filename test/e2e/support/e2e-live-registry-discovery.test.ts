// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildLiveTargetRunPlan } from "../live/run-plan.ts";
import { target } from "../registry/builder.ts";
import { listTargets } from "../registry/registry.ts";
import { liveTargetSupport } from "../registry/runtime-support.ts";
import type { TargetDefinition, TargetEnvironment } from "../registry/types.ts";

const SUPPORTED_ENVIRONMENT: TargetEnvironment = {
  platform: "ubuntu-local",
  install: "repo-current",
  runtime: "docker-running",
  onboarding: "cloud-openclaw",
};

function syntheticTarget(environment: TargetEnvironment = SUPPORTED_ENVIRONMENT): TargetDefinition {
  return target("synthetic-target")
    .manifest("synthetic/manifest.yaml")
    .environment(environment)
    .expectedState("synthetic-ready")
    .suites(["synthetic-smoke", "synthetic-security"])
    .build();
}

describe("live target registry discovery support", () => {
  it("classifies every shipped target as supported or with a concrete reason", () => {
    const targets = listTargets();

    expect(targets.length).toBeGreaterThan(0);
    for (const registered of targets) {
      const support = liveTargetSupport(registered);
      expect(support.supported || support.reasons.length > 0, registered.id).toBe(true);
    }
  });

  it("accepts a fully wired synthetic target and forwards its pending suites", () => {
    const registered = syntheticTarget();

    expect(liveTargetSupport(registered)).toEqual({
      supported: true,
      reasons: [],
      pendingRuntimeSuites: registered.suiteIds,
    });
  });

  it.each([
    ["platform", { ...SUPPORTED_ENVIRONMENT, platform: "synthetic-platform" }],
    ["install", { ...SUPPORTED_ENVIRONMENT, install: "synthetic-install" }],
    ["runtime", { ...SUPPORTED_ENVIRONMENT, runtime: "synthetic-runtime" }],
    ["onboarding", { ...SUPPORTED_ENVIRONMENT, onboarding: "synthetic-onboarding" }],
    ["lifecycle", { ...SUPPORTED_ENVIRONMENT, lifecycle: "synthetic-lifecycle" }],
  ] as const)("rejects an unwired %s with a diagnostic", (dimension, environment) => {
    const support = liveTargetSupport(syntheticTarget(environment));

    expect(support.supported).toBe(false);
    expect(support.reasons).toEqual([
      `${dimension} 'synthetic-${dimension}' is not wired for live fixtures`,
    ]);
  });

  it("rejects missing environment and expected-state inputs independently", () => {
    const missingEnvironment = target("synthetic-no-environment")
      .expectedState("synthetic-ready")
      .build();
    const missingExpectedState = target("synthetic-no-state")
      .environment(SUPPORTED_ENVIRONMENT)
      .build();

    expect(liveTargetSupport(missingEnvironment)).toMatchObject({
      supported: false,
      reasons: ["missing environment"],
    });
    expect(liveTargetSupport(missingExpectedState)).toMatchObject({
      supported: false,
      reasons: ["missing expectedStateId"],
    });
  });

  it("compiles a run plan from synthetic target behavior", () => {
    const registered = syntheticTarget();

    expect(buildLiveTargetRunPlan(registered)).toEqual({
      targetId: registered.id,
      manifestPath: registered.manifestPath,
      expectedStateId: registered.expectedStateId,
      suiteIds: registered.suiteIds,
      phases: ["environment", "onboarding", "state-validation"],
    });
  });

  it("inserts lifecycle execution only when the synthetic target requests it", () => {
    const registered = syntheticTarget({
      ...SUPPORTED_ENVIRONMENT,
      lifecycle: "post-reboot-recovery",
    });

    expect(liveTargetSupport(registered).supported).toBe(true);
    expect(buildLiveTargetRunPlan(registered).phases).toEqual([
      "environment",
      "onboarding",
      "lifecycle",
      "state-validation",
    ]);
  });
});
