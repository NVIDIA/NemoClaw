// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../credentials/store", () => ({
  resolveProviderCredential: vi.fn(() => null),
}));

import { customNativeProvider } from "../../inference/native-provider/custom";
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

it.each([
  ["native", "TEAM_KEY"],
  ["native", null],
  ["reservation", "TEAM_KEY"],
  ["reservation", null],
  ["legacy", "TEAM_KEY"],
] as const)(
  "routes %s custom resume through its owning credential recovery",
  async (state, credentialEnv) => {
    const definition = customNativeProvider({
      provider: "compatible-endpoint",
      endpointUrl: "https://custom.example/v1",
      api: "openai-completions",
      credentialEnv: "TEAM_KEY",
      allowedIps: ["8.8.8.8"],
    });
    const recorded =
      state === "native"
        ? {
            nativeHostedProviderAttachment: {
              schemaVersion: 1 as const,
              profileId: definition.profileId,
              providerName: definition.providerName,
              providerId: "owned-id",
              endpointUrl: definition.endpointUrl,
              allowedIps: definition.allowedIps,
              custom: definition.custom,
            },
          }
        : { pendingRouteReservation: state === "reservation" };
    const providerExistsInGateway = vi.fn(() => true);
    const replaceNamedCredential = vi.fn(async () => "unexpected");
    const shim = createResumeProviderShim({
      getSandbox: (name) => {
        expect(name).toBe("alpha");
        return recorded;
      },
      isNonInteractive: () => true,
      providerExistsInGateway,
      isRoutedInferenceProvider: () => false,
      replaceNamedCredential,
    });
    const result = await shim.ensureResumeProviderReady(
      "gateway-west",
      "compatible-endpoint",
      credentialEnv,
      undefined,
      { sandboxName: "alpha", endpointUrl: "https://custom.example/v1" },
    );
    expect(result).toEqual(
      state === "legacy"
        ? { forceInferenceSetup: false, credentialEnv: "TEAM_KEY" }
        : {
            forceInferenceSetup: true,
            credentialEnv:
              credentialEnv ?? (state === "native" ? "TEAM_KEY" : "COMPATIBLE_API_KEY"),
            nativeCustomSetup: true,
          },
    );
    expect(providerExistsInGateway.mock.calls).toEqual(
      state === "legacy" ? [["compatible-endpoint", "gateway-west"]] : [],
    );
    expect(replaceNamedCredential).not.toHaveBeenCalled();
  },
);

function nativeResumeHarness(provider: "compatible-endpoint" | "compatible-anthropic-endpoint") {
  const definition = customNativeProvider({
    provider,
    endpointUrl:
      provider === "compatible-endpoint" ? "https://custom.example/v1" : "https://custom.example",
    api: provider === "compatible-endpoint" ? "openai-completions" : "anthropic-messages",
    credentialEnv: "TEAM_KEY",
    allowedIps: ["8.8.8.8"],
  });
  const attachment = {
    schemaVersion: 1 as const,
    profileId: definition.profileId,
    providerName: definition.providerName,
    providerId: "owned-id",
    endpointUrl: definition.endpointUrl,
    allowedIps: definition.allowedIps,
    custom: definition.custom,
  };
  const providerExistsInGateway = vi.fn(() => true);
  const replaceNamedCredential = vi.fn(async () => "unexpected");
  const shim = createResumeProviderShim({
    getSandbox: () => ({ nativeHostedProviderAttachment: attachment }),
    isNonInteractive: () => true,
    providerExistsInGateway,
    isRoutedInferenceProvider: () => false,
    replaceNamedCredential,
  });
  return { attachment, shim, providerExistsInGateway, replaceNamedCredential };
}

it.each(["compatible-endpoint", "compatible-anthropic-endpoint"] as const)(
  "recovers the validated %s credential binding for an equivalent endpoint (#13195)",
  async (provider) => {
    const h = nativeResumeHarness(provider);
    const result = await h.shim.ensureResumeProviderReady(
      "gateway-west",
      provider,
      undefined,
      undefined,
      { sandboxName: "alpha", endpointUrl: h.attachment.custom.endpointUrl + "/" },
    );
    expect(result).toEqual({
      forceInferenceSetup: true,
      credentialEnv: "TEAM_KEY",
      nativeCustomSetup: true,
    });
    expect(h.providerExistsInGateway).not.toHaveBeenCalled();
    expect(h.replaceNamedCredential).not.toHaveBeenCalled();
  },
);

it("preserves an explicitly selected credential instead of the recorded binding (#13195)", async () => {
  const h = nativeResumeHarness("compatible-endpoint");
  const result = await h.shim.ensureResumeProviderReady(
    "gateway-west",
    "compatible-endpoint",
    "NEW_TEAM_KEY",
    undefined,
    { sandboxName: "alpha", endpointUrl: h.attachment.custom.endpointUrl },
  );
  expect(result.credentialEnv).toBe("NEW_TEAM_KEY");
  expect(h.replaceNamedCredential).not.toHaveBeenCalled();
});

it.each([
  ["compatible-endpoint", "https://different.example/v1", "COMPATIBLE_API_KEY"],
  ["compatible-anthropic-endpoint", "https://custom.example/v1", "COMPATIBLE_ANTHROPIC_API_KEY"],
])(
  "does not inherit a credential binding for changed %s at %s (#13195)",
  async (provider, endpointUrl, expected) => {
    const h = nativeResumeHarness("compatible-endpoint");
    const result = await h.shim.ensureResumeProviderReady(
      "gateway-west",
      provider,
      null,
      undefined,
      { sandboxName: "alpha", endpointUrl },
    );
    expect(result.credentialEnv).toBe(expected);
    expect(h.replaceNamedCredential).not.toHaveBeenCalled();
  },
);

it("rejects an altered native attachment before recovering its credential binding (#13195)", async () => {
  const h = nativeResumeHarness("compatible-endpoint");
  h.attachment.profileId = "altered-profile";
  await expect(
    h.shim.ensureResumeProviderReady("gateway-west", "compatible-endpoint", null, undefined, {
      sandboxName: "alpha",
      endpointUrl: h.attachment.custom.endpointUrl,
    }),
  ).rejects.toThrow("Invalid native hosted provider attachment");
  expect(h.providerExistsInGateway).not.toHaveBeenCalled();
  expect(h.replaceNamedCredential).not.toHaveBeenCalled();
});
