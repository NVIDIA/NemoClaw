// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../credentials/store", () => ({
  resolveProviderCredential: vi.fn(() => null),
}));

import { nativeLocalSetupReceipt } from "../../../../test/support/native-local-setup-harness";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import { customNativeProvider } from "../../inference/native-provider/custom";
import { createResumeProviderShim } from "./resume-provider-shim";

describe("createResumeProviderShim", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends routed recovery to native setup without querying a logical provider", async () => {
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
    expect(providerExistsInGateway).not.toHaveBeenCalled();
    expect(isRoutedInferenceProvider).toHaveBeenCalledWith("routed-provider");
    expect(replaceNamedCredential).not.toHaveBeenCalled();
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
        : { ...(state === "reservation" ? { pendingRouteReservation: true as const } : {}) };
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

it.each(["retained", "recreated", "replaced", "wrong-endpoint"] as const)(
  "resumes only the exact external binding: %s",
  async (state) => {
    const f = registeredInferenceFixture(state === "retained");
    const entry = {
      name: f.binding.sandboxName,
      gatewayName: f.binding.gatewayName,
      provider: f.binding.providerName,
      endpointUrl: f.binding.endpointUrl,
      credentialEnv: f.binding.credentialEnv,
      preferredInferenceApi: f.binding.inferenceApi,
      registeredInferenceProviderAttachment: f.binding,
    };
    const shim = createResumeProviderShim({
      getSandbox: () => entry,
      providerAdapter: f.adapter,
      isNonInteractive: () => true,
      providerExistsInGateway: vi.fn(),
      isRoutedInferenceProvider: () => false,
      replaceNamedCredential: vi.fn(),
    });
    f.state.id = state === "replaced" ? "replacement" : f.state.id;
    const result = shim.ensureResumeProviderReady(
      f.binding.gatewayName,
      f.binding.providerName,
      f.binding.credentialEnv,
      undefined,
      {
        sandboxName: f.binding.sandboxName,
        endpointUrl:
          state === "wrong-endpoint" ? "https://other.example/v1" : f.binding.endpointUrl,
      },
    );
    expect(
      await result.then(
        (value) => value,
        () => "rejected",
      ),
    ).toEqual(
      state === "retained" || state === "recreated"
        ? {
            forceInferenceSetup: false,
            credentialEnv: f.binding.credentialEnv,
            registeredNativeSetup: true,
          }
        : "rejected",
    );
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
  },
);

it.each(["openclaw", "hermes"] as const)(
  "resumes %s native local credentials through the exact recorded provider",
  async (agent) => {
    const receipt = nativeLocalSetupReceipt({
      agent,
      provider: "compatible-endpoint",
      gatewayName: "gateway-west",
      sandboxName: "alpha",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      authMode: "authenticated",
    });
    const providerExistsInGateway = vi.fn(() => false);
    const replaceNamedCredential = vi.fn();
    const shim = createResumeProviderShim({
      getSandbox: () => ({
        agent,
        provider: receipt.provider,
        credentialEnv: "TEAM_KEY",
        nativeLocalProviderAttachment: receipt,
      }),
      isNonInteractive: () => true,
      providerExistsInGateway,
      isRoutedInferenceProvider: () => false,
      replaceNamedCredential,
    });
    await expect(
      shim.ensureResumeProviderReady("gateway-west", "compatible-endpoint", "TEAM_KEY", undefined, {
        sandboxName: "alpha",
        endpointUrl: "http://localhost:8000/v1",
      }),
    ).resolves.toEqual({
      forceInferenceSetup: true,
      credentialEnv: "TEAM_KEY",
      nativeCustomSetup: true,
      nativeLocalSetup: true,
    });
    expect(providerExistsInGateway).not.toHaveBeenCalled();
    expect(replaceNamedCredential).not.toHaveBeenCalled();
  },
);

it.each([
  {
    gatewayName: "other",
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "TEAM_KEY",
  },
  {
    gatewayName: "gateway-west",
    sandboxName: "other",
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "TEAM_KEY",
  },
  {
    gatewayName: "gateway-west",
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    recordedProvider: "vllm-local",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "TEAM_KEY",
  },
  {
    gatewayName: "gateway-west",
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:8001/v1",
    credentialEnv: "TEAM_KEY",
  },
  {
    gatewayName: "gateway-west",
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "OTHER_KEY",
  },
])(
  "refuses changed native local resume selection before legacy recovery: %j",
  async (selection) => {
    const receipt = nativeLocalSetupReceipt({
      agent: "openclaw",
      provider: "compatible-endpoint",
      gatewayName: "gateway-west",
      sandboxName: "alpha",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      authMode: "authenticated",
    });
    const providerExistsInGateway = vi.fn(() => true);
    const replaceNamedCredential = vi.fn();
    const shim = createResumeProviderShim({
      getSandbox: () => ({
        agent: "openclaw",
        provider: selection.recordedProvider ?? receipt.provider,
        credentialEnv: "TEAM_KEY",
        nativeLocalProviderAttachment: receipt,
      }),
      isNonInteractive: () => true,
      providerExistsInGateway,
      isRoutedInferenceProvider: () => false,
      replaceNamedCredential,
    });
    await expect(
      shim.ensureResumeProviderReady(
        selection.gatewayName,
        selection.provider,
        selection.credentialEnv,
        undefined,
        selection,
      ),
    ).rejects.toThrow("does not match its recorded binding");
    expect(providerExistsInGateway).not.toHaveBeenCalled();
    expect(replaceNamedCredential).not.toHaveBeenCalled();
  },
);
