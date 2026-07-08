// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildLiveTargetRunPlan } from "../live/run-plan.ts";
import { listTargets } from "../registry/registry.ts";
import { liveTargetSupport } from "../registry/runtime-support.ts";

describe("live target registry discovery support", () => {
  it("classifies every typed registry target", () => {
    const targets = listTargets();

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const support = liveTargetSupport(target);
      expect(support.supported || support.reasons.length > 0).toBe(true);
    }
  });

  it("wires the canonical Ubuntu cloud OpenClaw path through phase fixtures", () => {
    const target = listTargets().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");

    expect(target).toBeTruthy();
    expect(liveTargetSupport(target!).supported).toBe(true);
    expect(liveTargetSupport(target!).pendingRuntimeSuites).toEqual([
      "smoke",
      "inference",
      "credentials",
    ]);
  });

  it("builds the live run-plan artifact shape from registry metadata", () => {
    const target = listTargets().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");

    expect(target).toBeTruthy();
    expect(buildLiveTargetRunPlan(target!)).toEqual({
      targetId: "ubuntu-repo-cloud-openclaw",
      manifestPath: "test/e2e/manifests/openclaw-nvidia.yaml",
      expectedStateId: "cloud-openclaw-ready",
      suiteIds: ["smoke", "inference", "credentials"],
      phases: ["environment", "onboarding", "state-validation"],
    });
  });

  it("includes the lifecycle phase in live run-plan artifacts when a target mutates state", () => {
    const target = listTargets().find(
      (entry) => entry.id === "ubuntu-repo-docker-post-reboot-recovery",
    );

    expect(target).toBeTruthy();
    expect(buildLiveTargetRunPlan(target!).phases).toEqual([
      "environment",
      "onboarding",
      "lifecycle",
      "state-validation",
    ]);
  });

  it("keeps unsupported onboarding profiles skipped with a concrete reason", () => {
    const target = listTargets().find((entry) => entry.id === "ubuntu-repo-cloud-hermes");

    expect(target).toBeTruthy();
    expect(liveTargetSupport(target!)).toMatchObject({
      supported: false,
      reasons: ["onboarding 'cloud-hermes' is not wired for live fixtures"],
    });
  });

  it("keeps no-Docker negatives skipped until runtime prep is matrix-owned", () => {
    const target = listTargets().find(
      (entry) => entry.id === "ubuntu-no-docker-preflight-negative",
    );

    expect(target).toBeTruthy();
    expect(liveTargetSupport(target!)).toMatchObject({
      supported: false,
      reasons: ["runtime 'docker-missing' is not wired for live fixtures"],
    });
  });

  it("keeps unwhitelisted lifecycle profiles skipped with the lifecycle reason", () => {
    const target = listTargets().find((entry) => entry.id === "ubuntu-rebuild-openclaw");

    expect(target).toBeTruthy();
    expect(liveTargetSupport(target!)).toMatchObject({
      supported: false,
      reasons: ["lifecycle 'rebuild-current-version' is not wired for live fixtures"],
    });
  });

  it("accepts the whitelisted post-reboot-recovery lifecycle target", () => {
    const target = listTargets().find(
      (entry) => entry.id === "ubuntu-repo-docker-post-reboot-recovery",
    );

    expect(target).toBeTruthy();
    expect(target!.environment?.lifecycle).toBe("post-reboot-recovery");
    expect(liveTargetSupport(target!)).toMatchObject({
      supported: true,
      reasons: [],
    });
  });

  it("wires the canonical DCode target through invalid-credential rebuild lifecycle", () => {
    const target = listTargets().find(
      (entry) => entry.id === "ubuntu-repo-cloud-langchain-deepagents-code",
    );

    expect(target).toBeTruthy();
    expect(target!.environment?.lifecycle).toBe("dcode-rebuild-invalid-credential");
    expect(liveTargetSupport(target!)).toMatchObject({ supported: true, reasons: [] });
    expect(buildLiveTargetRunPlan(target!).phases).toEqual([
      "environment",
      "onboarding",
      "lifecycle",
      "state-validation",
    ]);
    expect(target!.requiredSecrets).toContain("NVIDIA_INFERENCE_API_KEY");
  });
});
