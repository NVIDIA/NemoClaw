// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as policies from "../policy";
import {
  basePolicyHandlerOptions,
  createPolicyHandlerDeps,
} from "./machine/handlers/policies-test-fixture";
import { handlePoliciesState } from "./machine/handlers/policies";
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
  arePresetsCoveredByPersonalPolicy: vi.fn(),
  clampSetupPolicyPresetNames: vi.fn((names: string[]) => names),
  customPresetOwnsNetworkPolicyKey: vi.fn(() => false),
  filterSetupPolicyPresets: vi.fn(),
  getAppliedPresets: vi.fn(() => []),
  hasNativeCustomProvider: vi.fn(() => false),
  getPersonalSubsumedCustomPresetNames: vi.fn(async () => []),
  listCustomPresets: vi.fn(() => []),
  listSetupPolicyPresets: vi.fn(() => [
    { name: "npm" },
    { name: "tavily" },
    { name: "weather" },
    { name: "personal-open-internet" },
  ]),
  persistAppliedPolicySelection: vi.fn(),
  resolveSandboxBaselinePolicy: vi.fn(),
  setupPolicyPresetSupported: vi.fn(() => true),
}));
vi.mock("./policy-context-seed", () => ({ seedInitialPolicyContext }));
vi.mock("./policy-preset-sync", () => ({ syncPresetSelection }));

function applicationWithPendingSelection(
  pendingSelection: OnboardPolicyApplicationDeps["pendingSelection"],
) {
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
    waitForSandboxReady: vi.fn(async () => ({
      ready: true as const,
      reason: "ready" as const,
      error: null,
    })),
    waitForSandboxControlPlaneReady: vi.fn(async () => true),
    parsePolicyPresetEnv: vi.fn(() => []),
    env: {},
    pendingSelection,
  });
}

describe("onboarding policy application", () => {
  it("does not seed OpenClaw policy context during fresh Hermes policy selection", async () => {
    seedInitialPolicyContext.mockClear();
    const application = applicationWithPendingSelection(undefined);

    await expect(
      application.setupPoliciesWithSelection("alpha", {
        selectedPresets: ["npm"],
        agent: "hermes",
      }),
    ).resolves.toEqual(["npm"]);

    expect(syncPresetSelection).toHaveBeenCalledWith("alpha", [], ["npm"]);
    expect(seedInitialPolicyContext).not.toHaveBeenCalled();
  });

  it("shares a pending tier until policy setup completes", async () => {
    const loadTier = vi.fn(() => "balanced");
    const application = applicationWithPendingSelection({
      record: vi.fn(),
      loadTier,
      hasPending: vi.fn(() => false),
      clear: vi.fn(),
    });

    await expect(application.selectPolicyTier()).resolves.toBe("balanced");
    await expect(application.selectPolicyTier()).resolves.toBe("balanced");
    expect(loadTier).toHaveBeenCalledOnce();

    await expect(
      application.setupPoliciesWithSelection("alpha", {
        selectedPresets: ["npm"],
        tierName: "balanced",
      }),
    ).resolves.toEqual(["npm"]);
    await expect(application.selectPolicyTier()).resolves.toBe("balanced");
    expect(loadTier).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh tier selection after an onboarding attempt ends before policy setup", async () => {
    const loadTier = vi.fn().mockReturnValueOnce("balanced").mockReturnValueOnce("personal");
    const application = applicationWithPendingSelection({
      record: vi.fn(),
      loadTier,
      hasPending: vi.fn(() => false),
      clear: vi.fn(),
    });

    await expect(application.selectPolicyTier()).resolves.toBe("balanced");
    application.resetPolicyTierSelection();
    await expect(application.selectPolicyTier()).resolves.toBe("personal");
    expect(loadTier).toHaveBeenCalledTimes(2);
  });

  it.each(["npm", "tavily"])(
    "resumes a refused %s write and clears the saved selection after live readback",
    async (presetName) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pending-policy-"));
      vi.stubEnv("HOME", home);
      vi.resetModules();
      try {
        const sessionStore = await import("../state/onboard-session");
        const sandbox = { lifecycleLiveIdentityFingerprint: "live-sandbox-identity" };
        sessionStore.saveSession(sessionStore.createSession({ sandboxName: "alpha" }));
        const pendingSelection = sessionStore.createPendingPolicySelectionStore(() => sandbox);
        vi.mocked(policies.getAppliedPresets).mockResolvedValue([]);
        const application = applicationWithPendingSelection(pendingSelection);

        syncPresetSelection
          .mockRejectedValueOnce(new Error("policy refused"))
          .mockResolvedValue(undefined);
        await expect(
          application.setupPoliciesWithSelection("alpha", {
            selectedPresets: [presetName],
            tierName: "balanced",
            preserveExplicitWebSearch: true,
          }),
        ).rejects.toThrow("policy refused");
        expect(sessionStore.loadSession()?.pendingPolicySelection).toEqual({
          sandboxName: "alpha",
          sandboxIdentity: "live-sandbox-identity",
          tierName: "balanced",
          presetNames: [presetName],
        });

        const { deps, calls } = createPolicyHandlerDeps({
          loadSession: sessionStore.loadSession,
          getActiveSandbox: vi.fn(() => sandbox),
          preparePolicyPresetResumeSelection: application.preparePolicyPresetResumeSelection,
          arePolicyPresetsApplied: application.arePolicyPresetsApplied,
          setupPoliciesWithSelection: application.setupPoliciesWithSelection,
        });
        const resume = { ...basePolicyHandlerOptions(deps), sandboxName: "alpha", resume: true };
        await expect(handlePoliciesState(resume)).rejects.toThrow(
          "live OpenShell policy does not confirm",
        );
        expect(sessionStore.loadSession()?.pendingPolicySelection?.presetNames).toEqual([
          presetName,
        ]);

        vi.mocked(policies.getAppliedPresets).mockResolvedValue([presetName]);
        await expect(handlePoliciesState(resume)).resolves.toMatchObject({
          appliedPolicyPresets: [presetName],
        });
        expect(sessionStore.loadSession()?.pendingPolicySelection).toBeNull();
        expect(syncPresetSelection).toHaveBeenCalledTimes(3);
        expect(syncPresetSelection).toHaveBeenNthCalledWith(2, "alpha", [], [presetName]);
        expect(calls.skipped).not.toHaveBeenCalled();
      } finally {
        vi.mocked(policies.getAppliedPresets).mockResolvedValue([]);
        vi.unstubAllEnvs();
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("clears a Personal selection after confirming its superseded presets", async () => {
    const pendingSelection = { record: vi.fn(), hasPending: () => true, clear: vi.fn() };
    const application = applicationWithPendingSelection(pendingSelection);
    vi.mocked(policies.getAppliedPresets).mockResolvedValue(["personal-open-internet"]);
    vi.mocked(policies.arePresetsCoveredByPersonalPolicy).mockResolvedValue(true);
    syncPresetSelection.mockResolvedValue(undefined);
    try {
      await expect(
        application.setupPoliciesWithSelection("alpha", {
          selectedPresets: ["personal-open-internet", "weather"],
          tierName: "personal",
        }),
      ).resolves.toEqual(["personal-open-internet", "weather"]);
      expect(pendingSelection.clear).toHaveBeenCalledWith("alpha");
      expect(policies.arePresetsCoveredByPersonalPolicy).toHaveBeenCalledWith("alpha", ["weather"]);
    } finally {
      vi.mocked(policies.getAppliedPresets).mockResolvedValue([]);
    }
  });

  it("retains a Personal selection when its superseded presets cannot be confirmed", async () => {
    const pendingSelection = { record: vi.fn(), hasPending: () => true, clear: vi.fn() };
    const application = applicationWithPendingSelection(pendingSelection);
    vi.mocked(policies.getAppliedPresets).mockResolvedValue(["personal-open-internet"]);
    vi.mocked(policies.arePresetsCoveredByPersonalPolicy).mockResolvedValue(false);
    syncPresetSelection.mockResolvedValue(undefined);
    try {
      await expect(
        application.setupPoliciesWithSelection("alpha", {
          selectedPresets: ["personal-open-internet", "weather"],
          tierName: "personal",
        }),
      ).rejects.toThrow("live OpenShell policy does not confirm");
      expect(pendingSelection.clear).not.toHaveBeenCalled();
    } finally {
      vi.mocked(policies.getAppliedPresets).mockResolvedValue([]);
    }
  });

  it("records a Personal-normalized custom preset only in the first policy write", async () => {
    const pendingSelection = { record: vi.fn(), hasPending: () => true, clear: vi.fn() };
    const application = applicationWithPendingSelection(pendingSelection);
    vi.mocked(policies.listCustomPresets).mockResolvedValue([
      { name: "fixture-weather", file: "fixture-weather.yaml", description: "Custom weather" },
    ]);
    vi.mocked(policies.listSetupPolicyPresets).mockResolvedValue([
      { name: "personal-open-internet", file: "personal.yaml", description: "Personal" },
      { name: "fixture-weather", file: "fixture-weather.yaml", description: "Custom weather" },
    ]);
    vi.mocked(policies.getPersonalSubsumedCustomPresetNames).mockResolvedValue(["fixture-weather"]);
    vi.mocked(policies.getAppliedPresets).mockResolvedValue(["personal-open-internet"]);
    syncPresetSelection.mockResolvedValue(undefined);
    try {
      await expect(
        application.setupPoliciesWithSelection("alpha", {
          selectedPresets: ["personal-open-internet", "fixture-weather"],
          tierName: "personal",
        }),
      ).resolves.toEqual(["personal-open-internet"]);
      expect(pendingSelection.record).toHaveBeenCalledWith("alpha", "personal", [
        "personal-open-internet",
      ]);
      expect(syncPresetSelection).toHaveBeenCalledWith(
        "alpha",
        ["personal-open-internet"],
        ["personal-open-internet", "fixture-weather"],
      );
      expect(pendingSelection.clear).toHaveBeenCalledWith("alpha");
    } finally {
      vi.mocked(policies.listCustomPresets).mockResolvedValue([]);
      vi.mocked(policies.listSetupPolicyPresets).mockResolvedValue([
        { name: "npm", file: "npm.yaml", description: "npm" },
        { name: "tavily", file: "tavily.yaml", description: "Tavily" },
        { name: "weather", file: "weather.yaml", description: "Weather" },
        { name: "personal-open-internet", file: "personal.yaml", description: "Personal" },
      ]);
      vi.mocked(policies.getPersonalSubsumedCustomPresetNames).mockResolvedValue([]);
      vi.mocked(policies.getAppliedPresets).mockResolvedValue([]);
    }
  });

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
    let finishSync!: () => void;
    syncPresetSelection.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishSync = resolve;
      });
      events.push("policies synchronized");
    });
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
      waitForSandboxReady: vi.fn(async () => ({
        ready: true as const,
        reason: "ready" as const,
        error: null,
      })),
      waitForSandboxControlPlaneReady: vi.fn(async () => true),
      parsePolicyPresetEnv: vi.fn(() => []),
      env: {},
    });

    const pending = application.setupPoliciesWithSelection("alpha", { selectedPresets: ["npm"] });
    await vi.waitFor(() => expect(syncPresetSelection).toHaveBeenCalled());
    expect(events).toEqual(["lock entered"]);
    finishSync();
    await expect(pending).resolves.toEqual(["npm"]);
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
      vi.mocked(policies.listSetupPolicyPresets).mockResolvedValue([
        { name: "npm" },
        { name: "pypi" },
        { name: "discord" },
      ] as Awaited<ReturnType<typeof policies.listSetupPolicyPresets>>);
      vi.mocked(policies.getAppliedPresets).mockResolvedValue(["npm", "pypi", "discord"]);
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
        waitForSandboxReady: vi.fn(async () => ({
          ready: true as const,
          reason: "ready" as const,
          error: null,
        })),
        waitForSandboxControlPlaneReady: vi.fn(async () => true),
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
      vi.mocked(policies.getAppliedPresets).mockResolvedValue([]);

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
