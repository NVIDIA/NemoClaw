// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../credentials/store", () => ({
  resolveProviderCredential: vi.fn(() => null),
}));

import { createResumeProviderShim } from "./resume-provider-shim";

describe("createResumeProviderShim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds the selected gateway and recovery dependencies", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const providerExistsInGateway = vi.fn(() => false);
    const isRoutedInferenceProvider = vi.fn(() => true);
    const replaceNamedCredential = vi.fn(async () => "fresh-key");
    const shim = createResumeProviderShim({
      isNonInteractive: () => false,
      providerExistsInGateway,
      isRoutedInferenceProvider,
      replaceNamedCredential,
    });

    await expect(
      shim.ensureResumeProviderReady("gateway-west", "routed-provider", null),
    ).resolves.toEqual({
      forceInferenceSetup: true,
      credentialEnv: "OPENAI_API_KEY",
    });
    expect(providerExistsInGateway).toHaveBeenCalledWith("routed-provider", "gateway-west");
    expect(isRoutedInferenceProvider).toHaveBeenCalledWith("routed-provider");
    expect(replaceNamedCredential).toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      expect.any(String),
      null,
      expect.any(Function),
      undefined,
    );
  });

  it("delegates only an exact managed llama.cpp sandbox to lifecycle recovery (#8144)", async () => {
    const resumeManagedLlamaCppRuntime = vi
      .fn(async (sandboxName: string) => sandboxName === "spark-agent")
      .mockName("resumeManagedLlamaCppRuntime");
    const shim = createResumeProviderShim({
      isNonInteractive: () => true,
      providerExistsInGateway: () => true,
      isRoutedInferenceProvider: () => false,
      replaceNamedCredential: vi.fn(async () => "unused"),
      resumeManagedLlamaCppRuntime,
    });

    await expect(
      shim.ensureManagedLlamaCppResumeReady("llama-cpp-local", "spark-agent"),
    ).resolves.toBe(true);
    await expect(
      shim.ensureManagedLlamaCppResumeReady("llama-cpp-local", "operator-attached"),
    ).resolves.toBe(false);
    await expect(shim.ensureManagedLlamaCppResumeReady("vllm-local", "spark-agent")).resolves.toBe(
      false,
    );
    await expect(shim.ensureManagedLlamaCppResumeReady("llama-cpp-local", null)).resolves.toBe(
      false,
    );

    expect(resumeManagedLlamaCppRuntime).toHaveBeenCalledTimes(2);
    expect(resumeManagedLlamaCppRuntime).toHaveBeenNthCalledWith(1, "spark-agent", undefined);
    expect(resumeManagedLlamaCppRuntime).toHaveBeenNthCalledWith(2, "operator-attached", undefined);
  });

  it("propagates a conflicting managed llama.cpp owner instead of reusing its provider", async () => {
    const ownershipConflict = new Error(
      "Managed llama.cpp on this gateway is owned by sandbox 'first-sandbox'.",
    );
    const shim = createResumeProviderShim({
      isNonInteractive: () => true,
      providerExistsInGateway: () => true,
      isRoutedInferenceProvider: () => false,
      replaceNamedCredential: vi.fn(async () => "unused"),
      resumeManagedLlamaCppRuntime: vi.fn(async () => {
        throw ownershipConflict;
      }),
    });

    await expect(
      shim.ensureManagedLlamaCppResumeReady("llama-cpp-local", "second-sandbox"),
    ).rejects.toBe(ownershipConflict);
  });
});
