// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { type SetupPolicySelectionDeps, setupPoliciesWithSelection } from "./policy-selection";
import { hasNativeCustomProviderWebConflict } from "./policy-selection";
import { customNativeProvider } from "../inference/native-provider/custom";
import * as registry from "../state/registry";

function customAttachment(endpointUrl: string) {
  const definition = customNativeProvider({
    provider: "compatible-endpoint",
    endpointUrl,
    api: "openai-completions",
    credentialEnv: "CUSTOM_API_KEY",
    allowedIps: ["10.1.0.219"],
  });
  return {
    schemaVersion: 1 as const,
    providerId: "provider-id",
    profileId: definition.profileId,
    providerName: definition.providerName,
    endpointUrl: definition.endpointUrl,
    allowedIps: definition.allowedIps,
    custom: definition.custom,
  };
}

describe("Personal custom provider ports", () => {
  it.each([
    ["http://10.1.0.219/v1", true],
    ["https://10.1.0.219/v1", true],
    ["http://10.1.0.219:443/v1", true],
    ["https://10.1.0.219:80/v1", true],
    ["http://10.1.0.219:33573/v1", false],
    ["https://10.1.0.219:8443/v1", false],
  ] as const)("checks the attached endpoint %s for web overlap", (endpointUrl, conflict) => {
    const attachment = customAttachment(endpointUrl);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      nativeHostedProviderAttachment: attachment,
    } as never);
    expect(hasNativeCustomProviderWebConflict("alpha")).toBe(conflict);
  });

  it("refuses unverified endpoints and leaves the attachment unchanged", () => {
    const attachment = customAttachment("http://10.1.0.219:33573/v1");
    const original = structuredClone(attachment);
    attachment.endpointUrl = "https://10.1.0.219/v1";
    const getSandbox = vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      nativeHostedProviderAttachment: attachment,
    } as never);
    expect(hasNativeCustomProviderWebConflict("alpha")).toBe(true);
    attachment.custom = { ...attachment.custom, endpointUrl: "invalid-url" };
    expect(hasNativeCustomProviderWebConflict("alpha")).toBe(true);
    getSandbox.mockReturnValue({
      name: "alpha",
      nativeHostedProviderAttachment: original,
    } as never);
    expect(hasNativeCustomProviderWebConflict("alpha")).toBe(false);
    expect(original).toEqual(customAttachment("http://10.1.0.219:33573/v1"));
  });
});

function createHarness() {
  const syncPresetSelection = vi.fn();
  const deps = {
    policies: {
      setupPolicyPresetSupported: vi.fn(() => true),
      listSetupPolicyPresets: vi.fn(() => [
        { name: "local-inference" },
        { name: "npm" },
        { name: "personal-open-internet" },
      ]),
      listCustomPresets: vi.fn(() => []),
      getAppliedPresets: vi.fn(() => ["local-inference", "npm"]),
      customPresetOwnsNetworkPolicyKey: vi.fn(() => false),
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
    waitForSandboxReady: vi.fn(async () => ({
      ready: true as const,
      reason: "ready" as const,
      error: null,
    })),
    waitForSandboxControlPlaneReady: vi.fn(async () => true),
    syncPresetSelection,
    recordPendingSelection: vi.fn(),
    clearPendingSelection: vi.fn(),
    selectPolicyTier: vi.fn(async () => "balanced"),
    selectTierPresetsAndAccess: vi.fn(
      async (): Promise<Array<{ name: string; access: string }>> => [],
    ),
    parsePolicyPresetEnv: vi.fn((_value: string): string[] => []),
    env: { NEMOCLAW_POLICY_MODE: "suggested", NEMOCLAW_POLICY_PRESETS: "" },
  } satisfies SetupPolicySelectionDeps;
  return { deps, syncPresetSelection };
}

describe("Personal selection with a native custom provider", () => {
  it("refuses an interactive Personal selection before changing policy", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.isNonInteractive.mockReturnValue(false);
    deps.selectPolicyTier.mockResolvedValue("personal");
    const hasNativeCustomProviderWebConflict = vi.fn(() => true);
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(
        setupPoliciesWithSelection({ ...deps, hasNativeCustomProviderWebConflict }, "alpha", {
          selectedPresets: null,
        }),
      ).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(hasNativeCustomProviderWebConflict).toHaveBeenCalledWith("alpha");
    expect(errors.join("\n")).toContain("Choose another tier.");
    expect(deps.selectTierPresetsAndAccess).not.toHaveBeenCalled();
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });

  it("refuses a resumed Personal selection before readiness or policy mutation", async () => {
    const { deps, syncPresetSelection } = createHarness();
    const hasNativeCustomProviderWebConflict = vi.fn(() => true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(
        setupPoliciesWithSelection({ ...deps, hasNativeCustomProviderWebConflict }, "alpha", {
          selectedPresets: ["personal-open-internet"],
        }),
      ).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(hasNativeCustomProviderWebConflict).toHaveBeenCalledWith("alpha");
    expect(deps.waitForSandboxReady).not.toHaveBeenCalled();
    expect(deps.recordPendingSelection).not.toHaveBeenCalled();
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });

  it("refuses a custom Personal preset selected under another tier", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.env = {
      NEMOCLAW_POLICY_MODE: "custom",
      NEMOCLAW_POLICY_PRESETS: "personal-open-internet",
    };
    deps.parsePolicyPresetEnv.mockReturnValue(["personal-open-internet"]);
    const hasNativeCustomProviderWebConflict = vi.fn(() => true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await expect(
        setupPoliciesWithSelection({ ...deps, hasNativeCustomProviderWebConflict }, "alpha", {
          selectedPresets: null,
        }),
      ).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(hasNativeCustomProviderWebConflict).toHaveBeenCalledWith("alpha");
    expect(deps.recordPendingSelection).not.toHaveBeenCalled();
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });
});

describe("host-local route-only policy selection", () => {
  it.each([false, true])(
    "keeps %s selection pending when policy write fails",
    async (interactive) => {
      const { deps, syncPresetSelection } = createHarness();
      deps.isNonInteractive.mockReturnValue(!interactive);
      deps.selectTierPresetsAndAccess.mockResolvedValue(
        interactive ? [{ name: "npm", access: "read" }] : [],
      );
      syncPresetSelection.mockImplementation(() => {
        throw new Error("policy refused");
      });

      await expect(
        setupPoliciesWithSelection(deps, "alpha", {
          selectedPresets: null,
          excludedPresets: ["local-inference"],
        }),
      ).rejects.toThrow("policy refused");
      expect(deps.recordPendingSelection).toHaveBeenCalledWith(
        "alpha",
        "balanced",
        expect.arrayContaining(["npm"]),
      );
      expect(deps.clearPendingSelection).not.toHaveBeenCalled();
    },
  );

  it("clears pending selection only after the policy write succeeds", async () => {
    const { deps, syncPresetSelection } = createHarness();
    await setupPoliciesWithSelection(deps, "alpha", { selectedPresets: ["npm"] });
    expect(deps.recordPendingSelection.mock.invocationCallOrder[0]).toBeLessThan(
      syncPresetSelection.mock.invocationCallOrder[0],
    );
    expect(syncPresetSelection.mock.invocationCallOrder[0]).toBeLessThan(
      deps.clearPendingSelection.mock.invocationCallOrder[0],
    );
  });

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

  it("refuses interactive preset mutation when authority changes during the prompt (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    deps.isNonInteractive.mockReturnValue(false);
    deps.selectTierPresetsAndAccess.mockResolvedValue([{ name: "npm", access: "read" }]);
    const refusePresetMutation = () => {
      throw new Error("sandbox identity changed");
    };
    const policyChecks = new Map([
      ["apply policy presets to sandbox 'alpha'", refusePresetMutation],
    ]);
    const revalidateSandboxIdentity = vi.fn((operation: string) => policyChecks.get(operation)?.());

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
        revalidateSandboxIdentity,
      }),
    ).rejects.toThrow("sandbox identity changed");

    expect(deps.selectTierPresetsAndAccess).toHaveBeenCalledOnce();
    expect(syncPresetSelection).not.toHaveBeenCalled();
  });

  it("does not attribute presets when the policy mutation is refused (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    const onSelection = vi.fn();
    syncPresetSelection.mockImplementation(() => {
      throw new Error("sandbox identity changed");
    });

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: ["npm"],
        onSelection,
      }),
    ).rejects.toThrow("sandbox identity changed");

    expect(onSelection).not.toHaveBeenCalled();
  });

  it("refuses resumed preset synchronization when authority changes (#9833)", async () => {
    const { deps, syncPresetSelection } = createHarness();
    const revalidateSandboxIdentity = vi.fn(() => {
      throw new Error("sandbox identity changed");
    });

    await expect(
      setupPoliciesWithSelection(deps, "alpha", {
        selectedPresets: ["npm"],
        revalidateSandboxIdentity,
      }),
    ).rejects.toThrow("sandbox identity changed");

    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "reapply selected policy presets to sandbox 'alpha'",
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
