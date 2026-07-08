// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { type SetupPolicySelectionDeps, setupPoliciesWithSelection } from "./policy-selection";

describe("policy selection after interrupted onboarding", () => {
  it("reuses the recorded restricted tier before policy presets exist", async () => {
    const selectPolicyTier = vi.fn(async () => "balanced");
    const setPolicyTier = vi.fn();
    const syncPresetSelection = vi.fn();
    const onSelection = vi.fn();
    const deps = {
      policies: {
        setupPolicyPresetSupported: vi.fn(() => true),
        listSetupPolicyPresets: vi.fn(() => [{ name: "observability-otlp-local" }]),
        listCustomPresets: vi.fn(() => []),
        getAppliedPresets: vi.fn(() => []),
        customPresetOwnsNetworkPolicyKey: vi.fn(() => false),
        removeBuiltinPresetAttribution: vi.fn(),
        clampSetupPolicyPresetNames: vi.fn((names: string[]) => [...names]),
      },
      tiers: {
        resolveTierPresets: vi.fn((tierName: string) =>
          tierName === "balanced" ? [{ name: "observability-otlp-local" }] : [],
        ),
        getTier: vi.fn(() => ({})),
      },
      localInferenceProviders: [],
      step: vi.fn(),
      note: vi.fn(),
      isNonInteractive: vi.fn(() => true),
      waitForSandboxReady: vi.fn(() => true),
      syncPresetSelection,
      selectPolicyTier,
      setPolicyTier,
      getRecordedPolicyTier: vi.fn(() => null),
      selectTierPresetsAndAccess: vi.fn(async () => []),
      parsePolicyPresetEnv: vi.fn(() => []),
      env: { NEMOCLAW_POLICY_MODE: "suggested" },
    } satisfies SetupPolicySelectionDeps;

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        tierName: "restricted",
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        onSelection,
      }),
    ).resolves.toEqual([]);

    expect(selectPolicyTier).not.toHaveBeenCalled();
    expect(setPolicyTier).toHaveBeenCalledWith("alpha", "restricted");
    expect(onSelection).toHaveBeenCalledWith([]);
    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", [], []);
  });
});
