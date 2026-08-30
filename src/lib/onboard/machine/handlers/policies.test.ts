// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createPolicyHandlerDeps, basePolicyHandlerOptions } from "./policies-test-fixture";
import { handlePoliciesState } from "./policies";

describe("policy state handler", () => {
  it("resumes from the live OpenShell preset selection", async () => {
    const prepare = vi.fn(() => ({
      policyPresets: ["npm"],
      livePolicyPresetsNeedUpdate: false,
      disabledMessagingPolicyPresetApplied: false,
      suppressedAgentRequiredPresetsLive: false,
    }));
    const { deps, calls } = createPolicyHandlerDeps({
      arePolicyPresetsApplied: vi.fn(() => true),
      preparePolicyPresetResumeSelection: prepare,
    });
    const result = await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      resume: true,
    });
    expect(prepare).toHaveBeenCalledWith(
      "my-assistant",
      expect.not.objectContaining({ recordedPolicyPresets: expect.anything() }),
    );
    expect(calls.skipped).toHaveBeenCalledWith("policies", "npm");
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(result.appliedPolicyPresets).toEqual(["npm"]);
    expect(result.session).not.toHaveProperty("policyPresets");
  });

  it("passes the observed selection to reconciliation on resume", async () => {
    const { deps, calls } = createPolicyHandlerDeps({
      preparePolicyPresetResumeSelection: vi.fn(() => ({
        policyPresets: ["npm", "github"],
        livePolicyPresetsNeedUpdate: true,
        disabledMessagingPolicyPresetApplied: false,
        suppressedAgentRequiredPresetsLive: false,
      })),
    });
    await handlePoliciesState({ ...basePolicyHandlerOptions(deps), resume: true });
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: ["npm", "github"] }),
    );
  });

  it("starts a fresh selection without a shadow preset list", async () => {
    const { deps, calls } = createPolicyHandlerDeps();
    await handlePoliciesState(basePolicyHandlerOptions(deps));
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: null }),
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "policies",
      expect.not.objectContaining({ policyPresets: expect.anything() }),
    );
  });

  it("does not reconcile presets after a rebuild consumed OpenShell's live policy", async () => {
    const { deps, calls } = createPolicyHandlerDeps();

    const result = await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      preserveRebuildLivePolicy: true,
    });

    expect(calls.smoke).toHaveBeenCalledOnce();
    expect(calls.prepareResume).not.toHaveBeenCalled();
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith("policies", "live OpenShell rebuild policy");
    expect(result.appliedPolicyPresets).toEqual([]);
  });

  it("merges live messaging channels into policy requirements", async () => {
    const { deps, calls } = createPolicyHandlerDeps();
    await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      selectedMessagingChannels: [],
    });
    expect(calls.mergeChannels).toHaveBeenCalled();
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: ["telegram"] }),
    );
  });
});
