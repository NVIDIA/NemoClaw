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
    );
  });
});
