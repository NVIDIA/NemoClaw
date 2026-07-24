// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { type SetupPolicySelectionDeps, setupPoliciesWithSelection } from "./policy-selection";

function createPolicySelectionHarness(controlPlaneReady = true) {
  const selectPolicyTier = vi.fn(async () => "balanced");
  const setPolicyTier = vi.fn();
  const syncPresetSelection = vi.fn();
  const waitForSandboxReady = vi.fn(() => true);
  const waitForSandboxControlPlaneReady = vi.fn(() => controlPlaneReady);
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
    waitForSandboxReady,
    waitForSandboxControlPlaneReady,
    syncPresetSelection,
    selectPolicyTier,
    setPolicyTier,
    getRecordedPolicyTier: vi.fn(() => null),
    selectTierPresetsAndAccess: vi.fn(async () => []),
    parsePolicyPresetEnv: vi.fn(() => []),
    env: { NEMOCLAW_POLICY_MODE: "suggested" },
  } satisfies SetupPolicySelectionDeps;
  return {
    deps,
    onSelection,
    selectPolicyTier,
    setPolicyTier,
    syncPresetSelection,
    waitForSandboxControlPlaneReady,
    waitForSandboxReady,
  };
}

const setupOptions = {
  selectedPresets: null,
  tierName: "restricted",
  agent: "langchain-deepagents-code",
  observabilityEnabled: true,
};

describe("policy selection after interrupted onboarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the recorded tier and waits for sandbox re-registration after applying it (#7228)", async () => {
    const {
      deps,
      onSelection,
      selectPolicyTier,
      setPolicyTier,
      syncPresetSelection,
      waitForSandboxControlPlaneReady,
      waitForSandboxReady,
    } = createPolicySelectionHarness();
    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        ...setupOptions,
        onSelection,
      }),
    ).resolves.toEqual([]);

    expect(selectPolicyTier).not.toHaveBeenCalled();
    expect(setPolicyTier).toHaveBeenCalledWith("alpha", "restricted");
    expect(onSelection).toHaveBeenCalledWith([]);
    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", [], []);
    expect(waitForSandboxReady).toHaveBeenCalledTimes(2);
    expect(waitForSandboxReady.mock.invocationCallOrder[0]).toBeLessThan(
      syncPresetSelection.mock.invocationCallOrder[0],
    );
    expect(waitForSandboxReady.mock.invocationCallOrder[1]).toBeGreaterThan(
      syncPresetSelection.mock.invocationCallOrder[0],
    );
    expect(waitForSandboxControlPlaneReady).toHaveBeenCalledOnce();
    expect(waitForSandboxControlPlaneReady.mock.invocationCallOrder[0]).toBeGreaterThan(
      waitForSandboxReady.mock.invocationCallOrder[1],
    );
  });

  it("fails closed when sandbox command execution does not recover after policy application (#7228)", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const { deps, syncPresetSelection, waitForSandboxControlPlaneReady } =
      createPolicySelectionHarness(false);

    await expect(setupPoliciesWithSelection(deps, "alpha", setupOptions)).rejects.toThrow(
      "process.exit(1)",
    );

    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", [], []);
    expect(waitForSandboxControlPlaneReady).toHaveBeenCalledWith("alpha");
    expect(waitForSandboxControlPlaneReady.mock.invocationCallOrder[0]).toBeGreaterThan(
      syncPresetSelection.mock.invocationCallOrder[0],
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
