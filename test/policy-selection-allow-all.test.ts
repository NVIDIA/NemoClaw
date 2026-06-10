// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Covers the allow-all branch in setupPoliciesWithSelection: when the
// "allow-all" tier is chosen, the catch-all policy is applied directly to the
// running sandbox and preset selection/sync is skipped entirely.

import { describe, expect, it, vi } from "vitest";

// hermes-managed-tools pulls in hermes-provider-auth, which does a runtime
// require("./onboard/providers") that only resolves against the compiled dist
// tree. We don't exercise Hermes tool gateways here, so stub it to keep the
// source-level import graph self-contained.
vi.mock("../src/lib/onboard/hermes-managed-tools", () => ({
  HERMES_TOOL_GATEWAY_PRESET_NAMES: new Set<string>(),
  mergeRequiredHermesToolGatewayPolicyPresets: (presets: string[]) => presets,
}));

import { setupPoliciesWithSelection } from "../src/lib/onboard/policy-selection";

function baseDeps(tierName: string, overrides: Record<string, unknown> = {}) {
  return {
    policies: {
      setupPolicyPresetSupported: () => true,
      listSetupPolicyPresets: () => [{ name: "npm" }, { name: "pypi" }],
      listCustomPresets: () => [],
      getAppliedPresets: () => [],
      clampSetupPolicyPresetNames: (names: string[]) => names,
    },
    tiers: {
      resolveTierPresets: () => [],
      getTier: (name: string) => (name === tierName ? { name } : null),
    },
    localInferenceProviders: [],
    step: () => {},
    note: () => {},
    isNonInteractive: () => false,
    waitForSandboxReady: () => true,
    syncPresetSelection: vi.fn(),
    selectPolicyTier: async () => tierName,
    setPolicyTier: vi.fn(),
    applyAllowAllPolicy: vi.fn(),
    selectTierPresetsAndAccess: async () => [],
    parsePolicyPresetEnv: () => [],
    env: {},
    ...overrides,
  };
}

describe("setupPoliciesWithSelection — allow-all tier", () => {
  it("applies the allow-all policy and skips preset sync", async () => {
    const deps = baseDeps("allow-all");
    const result = await setupPoliciesWithSelection(deps as never, "sbx");

    expect(result).toEqual([]);
    expect(deps.applyAllowAllPolicy).toHaveBeenCalledWith("sbx");
    expect(deps.setPolicyTier).toHaveBeenCalledWith("sbx", "allow-all");
    expect(deps.syncPresetSelection).not.toHaveBeenCalled();
  });

  it("records the chosen tier via setPolicyTier", async () => {
    const deps = baseDeps("allow-all");
    await setupPoliciesWithSelection(deps as never, "sbx");
    expect(deps.setPolicyTier).toHaveBeenCalledWith("sbx", "allow-all");
  });

  it("does NOT take the allow-all branch for a normal tier", async () => {
    const deps = baseDeps("balanced", {
      selectTierPresetsAndAccess: async () => [{ name: "npm", access: "read-write" }],
    });
    await setupPoliciesWithSelection(deps as never, "sbx");
    expect(deps.applyAllowAllPolicy).not.toHaveBeenCalled();
    expect(deps.syncPresetSelection).toHaveBeenCalled();
  });
});
