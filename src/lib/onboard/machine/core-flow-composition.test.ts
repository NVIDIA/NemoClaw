// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProviderInferencePhase: vi.fn(),
  createResumeProviderShim: vi.fn(),
  createSandboxPhase: vi.fn(),
}));

vi.mock("./core-flow-phases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./core-flow-phases")>()),
  createProviderInferenceOnboardFlowPhase: mocks.createProviderInferencePhase,
  createSandboxOnboardFlowPhase: mocks.createSandboxPhase,
}));

vi.mock("./resume-provider-shim", () => ({
  createResumeProviderShim: mocks.createResumeProviderShim,
}));

import { createCoreOnboardFlowPhases } from "./core-flow-composition";
import type { OnboardFlowContext } from "./flow-context";

describe("createCoreOnboardFlowPhases", () => {
  beforeEach(() => {
    mocks.createProviderInferencePhase.mockReturnValue({ state: "provider_selection" });
    mocks.createResumeProviderShim.mockReturnValue({
      ensureManagedLlamaCppResumeReady: vi.fn(),
      ensureResumeProviderReady: vi.fn(),
      isResumeProviderSurfaceReady: vi.fn(),
    });
    mocks.createSandboxPhase.mockReturnValue({ state: "sandbox" });
  });

  it("preserves provider recovery and stale dashboard listener cleanup in the composed core phases (#7695)", () => {
    const existingProviderDependency = vi.fn();
    const existingSandboxDependency = vi.fn();
    const resumeProvider = {
      isNonInteractive: vi.fn(),
      isRoutedInferenceProvider: vi.fn(),
      providerExistsInGateway: vi.fn(),
      replaceNamedCredential: vi.fn(),
    };

    const phases = createCoreOnboardFlowPhases<OnboardFlowContext>({
      resumeProvider,
      providerInference: {
        deps: { existingProviderDependency },
      } as never,
      sandbox: {
        deps: { existingSandboxDependency },
      } as never,
    });

    expect(mocks.createResumeProviderShim).toHaveBeenCalledWith(resumeProvider);
    expect(mocks.createProviderInferencePhase).toHaveBeenCalledWith({
      deps: {
        existingProviderDependency,
        ensureManagedLlamaCppResumeReady: expect.any(Function),
        ensureResumeProviderReady: expect.any(Function),
        isResumeProviderSurfaceReady: expect.any(Function),
      },
    });
    expect(mocks.createSandboxPhase).toHaveBeenCalledWith({
      deps: {
        existingSandboxDependency,
      },
    });
    expect(phases).toEqual({
      providerInference: { state: "provider_selection" },
      sandbox: { state: "sandbox" },
    });
  });
});
