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
      getTier: vi.fn((tierName: string) => ({
        name: tierName,
        label: tierName,
        description: "test tier",
        presets: [
          { name: "local-inference", access: "read" as const },
          { name: "npm", access: "read" as const },
        ],
      })),
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

  it("refuses tier attribution when authority changes during the prompt (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.isNonInteractive.mockReturnValue(false);
    const refuseTierAttribution = () => {
      throw new Error("policy authority changed");
    };
    const policyChecks = new Map([
      ["record the policy tier for sandbox 'alpha'", refuseTierAttribution],
    ]);
    const revalidatePolicyRequirements = vi.fn((operation: string) =>
      policyChecks.get(operation)?.(),
    );

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
        revalidatePolicyRequirements,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(deps.selectPolicyTier).toHaveBeenCalledOnce();
    expect(deps.setPolicyTier).not.toHaveBeenCalled();
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });

  it("refuses interactive preset mutation when authority changes during the prompt (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.isNonInteractive.mockReturnValue(false);
    deps.selectTierPresetsAndAccess.mockResolvedValue([{ name: "npm", access: "read" }]);
    const refusePresetMutation = () => {
      throw new Error("policy authority changed");
    };
    const policyChecks = new Map([
      ["apply policy presets to sandbox 'alpha'", refusePresetMutation],
    ]);
    const revalidatePolicyRequirements = vi.fn((operation: string) =>
      policyChecks.get(operation)?.(),
    );

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
        revalidatePolicyRequirements,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(deps.selectTierPresetsAndAccess).toHaveBeenCalledOnce();
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });

  it("does not attribute presets when the policy mutation is refused (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    const onSelection = vi.fn();
    syncPresetSelection.mockImplementation(() => {
      throw new Error("policy authority changed");
    });

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: ["npm"],
        onSelection,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(onSelection).not.toHaveBeenCalled();
  });

  it("refuses resumed preset synchronization when authority changes (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    const revalidatePolicyRequirements = vi.fn(() => {
      throw new Error("policy authority changed");
    });

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: ["npm"],
        revalidatePolicyRequirements,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(revalidatePolicyRequirements).toHaveBeenCalledWith(
      "reapply recorded policy presets to sandbox 'alpha'",
    );
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });

  it("refuses retained-preset synchronization when authority changes (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.env.NEMOCLAW_POLICY_MODE = "skip";
    const revalidatePolicyRequirements = vi
      .fn<() => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("policy authority changed");
      });

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
        revalidatePolicyRequirements,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(revalidatePolicyRequirements).toHaveBeenLastCalledWith(
      "apply retained policy presets to sandbox 'alpha'",
    );
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });

  it("refuses non-interactive preset synchronization when authority changes (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    const revalidatePolicyRequirements = vi
      .fn<() => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("policy authority changed");
      });

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
        revalidatePolicyRequirements,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(revalidatePolicyRequirements).toHaveBeenLastCalledWith(
      "apply non-interactive policy presets to sandbox 'alpha'",
    );
    expect(syncPresetSelection).not.toHaveBeenCalled();
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
