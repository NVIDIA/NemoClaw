// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
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
      setPolicyTier: vi.fn(),
      getRecordedPolicyTier: vi.fn(() => null),
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
});
