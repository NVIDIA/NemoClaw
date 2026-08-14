// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { type SetupPolicySelectionDeps, setupPoliciesWithSelection } from "./policy-selection";

function createHarness() {
  const syncPresetSelection = vi.fn();
  const deps = {
    policies: {
      setupPolicyPresetSupported: vi.fn(() => true),
      listSetupPolicyPresets: vi.fn(() => [{ name: "local-inference" }, { name: "npm" }]),
      listCustomPresets: vi.fn(() => []),
      getAppliedPresets: vi.fn(() => ["local-inference", "npm"]),
      customPresetOwnsNetworkPolicyKey: vi.fn(() => false),
      removeBuiltinPresetAttribution: vi.fn(),
      clampSetupPolicyPresetNames: vi.fn((names: string[]) => [...names]),
    },
    tiers: {
      resolveTierPresets: vi.fn(() => [{ name: "local-inference" }, { name: "npm" }]),
      getTier: vi.fn(() => ({})),
    },
    localInferenceProviders: ["ollama-local", "vllm-local"],
    step: vi.fn(),
    note: vi.fn(),
    isNonInteractive: vi.fn(() => true),
    waitForSandboxReady: vi.fn(() => true),
    waitForSandboxControlPlaneReady: vi.fn(() => true),
    syncPresetSelection,
    selectPolicyTier: vi.fn(async () => "balanced"),
    setPolicyTier: vi.fn(),
    getRecordedPolicyTier: vi.fn(() => null),
    selectTierPresetsAndAccess: vi.fn(
      async (): Promise<Array<{ name: string; access: string }>> => [],
    ),
    parsePolicyPresetEnv: vi.fn(() => []),
    env: { NEMOCLAW_POLICY_MODE: "suggested" },
  } satisfies SetupPolicySelectionDeps;
  return { deps, syncPresetSelection };
}

describe("host-local route-only policy selection", () => {
  it("removes a stale recorded local-inference preset from the live selection", async () => {
    const { deps, syncPresetSelection } = createHarness();

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: ["local-inference", "npm"],
        provider: null,
        excludedPresets: ["local-inference"],
      }),
    ).resolves.toEqual(["npm"]);

    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", ["local-inference", "npm"], ["npm"]);
  });

  it("excludes local-inference from fresh tier suggestions", async () => {
    const { deps, syncPresetSelection } = createHarness();

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
        hermesToolGateways: ["local-inference"],
        agent: "hermes",
      }),
    ).resolves.toEqual(["npm"]);

    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", ["local-inference", "npm"], ["npm"]);
  });

  it("excludes local-inference from an interactive tier selection", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.isNonInteractive.mockReturnValue(false);
    deps.selectTierPresetsAndAccess.mockResolvedValue([
      { name: "local-inference", access: "read" },
      { name: "npm", access: "read" },
    ]);

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
      }),
    ).resolves.toEqual(["npm"]);

    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", ["local-inference", "npm"], ["npm"], {
      npm: "read",
    });
  });

  it("removes a live stale local-inference preset even when ordinary policy setup is skipped", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.env.NEMOCLAW_POLICY_MODE = "skip";

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
      }),
    ).resolves.toEqual(["npm"]);

    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", ["local-inference", "npm"], ["npm"]);
  });

  it("does not check readiness when skip mode has no excluded preset to remove", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.env.NEMOCLAW_POLICY_MODE = "skip";
    deps.policies.getAppliedPresets.mockReturnValue(["npm"]);

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
      }),
    ).resolves.toEqual([]);

    expect(deps.waitForSandboxReady).not.toHaveBeenCalled();
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });
});
