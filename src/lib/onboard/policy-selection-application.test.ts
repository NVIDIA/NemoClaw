// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";
import {
  createOnboardPolicyApplication,
  type OnboardPolicyApplicationDeps,
} from "./policy-selection";

describe("onboarding policy application", () => {
  it("runs policy setup through the sandbox mutation lock", async () => {
    const lockResult = ["npm"];
    const withSandboxMutationLock = vi.fn(async () => lockResult);
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
      withSandboxMutationLock:
        withSandboxMutationLock as unknown as OnboardPolicyApplicationDeps["withSandboxMutationLock"],
      waitForSandboxReady: vi.fn(() => true),
      waitForSandboxControlPlaneReady: vi.fn(() => true),
      setPolicyTier: vi.fn(),
      getRecordedPolicyTier: vi.fn(() => null),
      parsePolicyPresetEnv: vi.fn(() => []),
      env: {},
    });

    await expect(
      application.setupPoliciesWithSelection("alpha", { selectedPresets: ["npm"] }),
    ).resolves.toEqual(lockResult);
    expect(withSandboxMutationLock).toHaveBeenCalledOnce();
    expect(withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
  });
});
