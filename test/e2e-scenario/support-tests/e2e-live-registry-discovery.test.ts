// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildLiveScenarioRunPlan } from "../live/run-plan.ts";
import { listScenarios } from "../scenarios/registry.ts";
import { liveScenarioSupport } from "../scenarios/runtime-support.ts";

describe("live Vitest registry discovery support", () => {
  it("classifies every typed registry scenario", () => {
    const scenarios = listScenarios();

    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      const support = liveScenarioSupport(scenario);
      expect(support.supported || support.reasons.length > 0).toBe(true);
    }
  });

  it("wires the canonical Ubuntu cloud OpenClaw path through phase fixtures", () => {
    const scenario = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");

    expect(scenario).toBeTruthy();
    expect(liveScenarioSupport(scenario!).supported).toBe(true);
    expect(liveScenarioSupport(scenario!).pendingRuntimeSuites).toEqual([
      "smoke",
      "inference",
      "credentials",
    ]);
  });

  it("builds the live run-plan artifact shape from registry metadata", () => {
    const scenario = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");

    expect(scenario).toBeTruthy();
    expect(buildLiveScenarioRunPlan(scenario!)).toEqual({
      scenarioId: "ubuntu-repo-cloud-openclaw",
      manifestPath: "test/e2e-scenario/manifests/openclaw-nvidia.yaml",
      expectedStateId: "cloud-openclaw-ready",
      suiteIds: ["smoke", "inference", "credentials"],
      phases: ["environment", "onboarding", "state-validation"],
    });
  });

  it("includes the lifecycle phase in live run-plan artifacts when a scenario mutates state", () => {
    const scenario = listScenarios().find(
      (entry) => entry.id === "ubuntu-repo-docker-post-reboot-recovery",
    );

    expect(scenario).toBeTruthy();
    expect(buildLiveScenarioRunPlan(scenario!).phases).toEqual([
      "environment",
      "onboarding",
      "lifecycle",
      "state-validation",
    ]);
  });

  it("keeps unsupported onboarding profiles skipped with a concrete reason", () => {
    const scenario = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-hermes");

    expect(scenario).toBeTruthy();
    expect(liveScenarioSupport(scenario!)).toMatchObject({
      supported: false,
      reasons: ["onboarding 'cloud-hermes' is not wired for live Vitest fixtures"],
    });
  });

  it("keeps no-Docker negatives skipped until runtime prep is matrix-owned", () => {
    const scenario = listScenarios().find(
      (entry) => entry.id === "ubuntu-no-docker-preflight-negative",
    );

    expect(scenario).toBeTruthy();
    expect(liveScenarioSupport(scenario!)).toMatchObject({
      supported: false,
      reasons: ["runtime 'docker-missing' is not wired for live Vitest fixtures"],
    });
  });

  it("keeps unwhitelisted lifecycle profiles skipped with the lifecycle reason", () => {
    const scenario = listScenarios().find((entry) => entry.id === "ubuntu-rebuild-openclaw");

    expect(scenario).toBeTruthy();
    expect(liveScenarioSupport(scenario!)).toMatchObject({
      supported: false,
      reasons: ["lifecycle 'rebuild-current-version' is not wired for live Vitest fixtures"],
    });
  });

  it("accepts the whitelisted post-reboot-recovery lifecycle scenario", () => {
    const scenario = listScenarios().find(
      (entry) => entry.id === "ubuntu-repo-docker-post-reboot-recovery",
    );

    expect(scenario).toBeTruthy();
    expect(scenario!.environment?.lifecycle).toBe("post-reboot-recovery");
    expect(liveScenarioSupport(scenario!)).toMatchObject({
      supported: true,
      reasons: [],
    });
  });
});
