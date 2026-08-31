// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as policies from "../policy";
import {
  createOnboardPolicyApplication,
  type OnboardPolicyApplicationDeps,
} from "./policy-selection";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";

const { seedInitialPolicyContext, syncPresetSelection } = vi.hoisted(() => ({
  seedInitialPolicyContext: vi.fn(),
  syncPresetSelection: vi.fn(),
}));

vi.mock("../policy", () => ({
  clampSetupPolicyPresetNames: vi.fn((names: string[]) => names),
  customPresetOwnsNetworkPolicyKey: vi.fn(() => false),
  filterSetupPolicyPresets: vi.fn(),
  getAppliedPresets: vi.fn(() => []),
  listCustomPresets: vi.fn(() => []),
  listSetupPolicyPresets: vi.fn(() => [{ name: "npm" }]),
  resolveSandboxBaselinePolicy: vi.fn(),
  setupPolicyPresetSupported: vi.fn(() => true),
}));
vi.mock("./policy-context-seed", () => ({ seedInitialPolicyContext }));
vi.mock("./policy-preset-sync", () => ({ syncPresetSelection }));

describe("onboarding policy application", () => {
  it("runs policy application while holding the sandbox mutation lock", async () => {
    const events: string[] = [];
    const withSandboxMutationLock: OnboardPolicyApplicationDeps["withSandboxMutationLock"] = vi.fn(
      async (_sandboxName, action) => {
        events.push("lock entered");
        try {
          return await action();
        } finally {
          events.push("lock released");
        }
      },
    );
    syncPresetSelection.mockImplementation(() => events.push("policies synchronized"));
    seedInitialPolicyContext.mockImplementation(() => events.push("policy context seeded"));
    const application = createOnboardPolicyApplication({
      localInferenceProviders: [],
      step: vi.fn(),
      note: vi.fn(),
      isNonInteractive: vi.fn(() => true),
      prompt: vi.fn(async () => ""),
      selectFromNumberedMenuOrExit,
      makeOnboardCancelExit: (rollback, cleanup) => () => {
        cleanup();
        rollback.markCancelled();
      },
      sandboxCancelRollback: { markCancelled: vi.fn() },
      useColor: false,
      withSandboxMutationLock,
      waitForSandboxReady: vi.fn(() => true),
      waitForSandboxControlPlaneReady: vi.fn(() => true),
      parsePolicyPresetEnv: vi.fn(() => []),
      env: {},
    });

    await expect(
      application.setupPoliciesWithSelection("alpha", { selectedPresets: ["npm"] }),
    ).resolves.toEqual(["npm"]);
    expect(withSandboxMutationLock).toHaveBeenCalledOnce();
    expect(withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", [], ["npm"]);
    expect(events).toEqual([
      "lock entered",
      "policies synchronized",
      "policy context seeded",
      "lock released",
    ]);
  });

  describe("non-interactive selection with a previously-applied channel preset", () => {
    function createApplication(env: Record<string, string>) {
      vi.mocked(policies.listSetupPolicyPresets).mockReturnValue([
        { name: "npm" },
        { name: "pypi" },
        { name: "discord" },
      ] as ReturnType<typeof policies.listSetupPolicyPresets>);
      vi.mocked(policies.getAppliedPresets).mockReturnValue(["npm", "pypi", "discord"]);
      syncPresetSelection.mockImplementation(() => undefined);
      seedInitialPolicyContext.mockImplementation(() => undefined);
      return createOnboardPolicyApplication({
        localInferenceProviders: [],
        step: vi.fn(),
        note: vi.fn(),
        isNonInteractive: vi.fn(() => true),
        prompt: vi.fn(async () => ""),
        selectFromNumberedMenuOrExit,
        makeOnboardCancelExit: (rollback, cleanup) => () => {
          cleanup();
          rollback.markCancelled();
        },
        sandboxCancelRollback: { markCancelled: vi.fn() },
        useColor: false,
        withSandboxMutationLock: async (_sandboxName, action) => await action(),
        waitForSandboxReady: vi.fn(() => true),
        waitForSandboxControlPlaneReady: vi.fn(() => true),
        parsePolicyPresetEnv: vi.fn((value: string) =>
          value
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        ),
        env,
      });
    }

    it("drops the preset when the channel is no longer configured", async () => {
      const application = createApplication({ NEMOCLAW_POLICY_PRESETS: "npm,pypi" });

      await application.setupPoliciesWithSelection("alpha", {
        selectedPresets: null,
        enabledChannels: [],
        disabledChannels: ["discord"],
        webSearchSupported: false,
        hermesToolGateways: [],
      });

      expect(syncPresetSelection).toHaveBeenCalledWith(
        "alpha",
        ["npm", "pypi", "discord"],
        ["npm", "pypi"],
      );
    });

    it("keeps the preset while the channel is still configured", async () => {
      const application = createApplication({ NEMOCLAW_POLICY_PRESETS: "npm,pypi" });

      await application.setupPoliciesWithSelection("alpha", {
        selectedPresets: null,
        enabledChannels: ["discord"],
        disabledChannels: [],
        webSearchSupported: false,
        hermesToolGateways: [],
      });

      expect(syncPresetSelection).toHaveBeenCalledWith(
        "alpha",
        ["npm", "pypi", "discord"],
        ["npm", "pypi", "discord"],
      );
    });

    // NEMOCLAW_POLICY_PRESETS alone runs in suggested mode, which is not
    // authoritative, so the applied set is preserved on top of it. Nothing
    // downstream can retire the channel's egress; only a caller that names the
    // channel in disabledChannels can. This is why handlePoliciesState derives
    // that list from the applied presets as well as the messaging plans.
    it("preserves an applied channel preset when no caller disables the channel (#9283)", async () => {
      const application = createApplication({ NEMOCLAW_POLICY_PRESETS: "npm,pypi" });

      await expect(
        application.setupPoliciesWithSelection("alpha", {
          selectedPresets: null,
          enabledChannels: [],
          disabledChannels: [],
          webSearchSupported: false,
          hermesToolGateways: [],
        }),
      ).resolves.toEqual(["npm", "pypi", "discord"]);
    });

    it("drops the disabled channel preset when policy selection is skipped (#9109)", async () => {
      const application = createApplication({ NEMOCLAW_POLICY_MODE: "skip" });

      await expect(
        application.setupPoliciesWithSelection("alpha", {
          selectedPresets: null,
          enabledChannels: [],
          disabledChannels: ["discord"],
          webSearchSupported: false,
          hermesToolGateways: [],
        }),
      ).resolves.toEqual(["npm", "pypi"]);

      expect(syncPresetSelection).toHaveBeenCalledWith(
        "alpha",
        ["npm", "pypi", "discord"],
        ["npm", "pypi"],
      );
    });

    it("adds an enabled channel preset when policy selection is skipped (#10153)", async () => {
      const application = createApplication({ NEMOCLAW_POLICY_MODE: "skip" });
      vi.mocked(policies.getAppliedPresets).mockReturnValue([]);

      await expect(
        application.setupPoliciesWithSelection("alpha", {
          selectedPresets: null,
          enabledChannels: ["discord"],
          disabledChannels: [],
          agent: "hermes",
          webSearchSupported: false,
          hermesToolGateways: [],
        }),
      ).resolves.toEqual(["discord"]);

      expect(syncPresetSelection).toHaveBeenCalledWith("alpha", [], ["discord"]);
    });
  });
});
