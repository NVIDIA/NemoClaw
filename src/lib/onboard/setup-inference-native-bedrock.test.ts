// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/sandbox-observer";
import { nativeBedrockIdentity } from "../inference/native-bedrock/contract";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../inference/bedrock-runtime";
import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";
function nativeBedrockOnboardingFixture(endpointSuffix = "") {
  const provider = "compatible-anthropic-endpoint";
  const binding = {
    endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    adapterGeneration: "a".repeat(32),
    adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    gatewayName: "onboarding-gateway",
  };
  const identity = { ...nativeBedrockIdentity(binding), endpoint: binding.endpointUrl };
  const importProviderProfile = vi.fn(async () => ({ ok: true as const }));
  const getProvider = vi
    .fn<OpenShellProviderAdapter["getProvider"]>()
    .mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "not found" },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        name: identity.providerName,
        type: identity.profileId,
        credentialKeys: ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
        configKeys: [],
        revision: { id: "provider-id", resourceVersion: 4 },
      },
    });
  const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
    ok: true,
  }));
  const providerAdapter = {
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true as const })),
    importProviderProfile,
    getProvider,
    createProvider,
  } as unknown as OpenShellProviderAdapter;
  const runOpenshell = vi.fn((_args: string[]) => ({ status: 0, stdout: "", stderr: "" }));
  const updateSandbox = vi.fn(() => true);
  const setNativeBedrockProviderAuthority = vi.fn(() => true);
  const verifyInferenceRoute = vi.fn();
  const verifyOnboardInferenceSmoke = vi.fn(async () => undefined);
  const surfaceProbe = vi.fn(async () => ({ ok: true }));
  const setupInference = createSetupInference({
    ensureBedrockRuntimeAdapter: vi.fn(async () => ({
      baseUrl: binding.adapterBaseUrl,
      localBaseUrl: "http://127.0.0.1:11436/v1",
      endpointUrl: binding.endpointUrl,
      region: binding.region,
      generation: binding.adapterGeneration,
      token: "host-adapter-token",
      credentialEnv: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
      logPath: "/tmp/adapter.log",
    })),
    getNativeBedrockProviderAuthority: () => undefined,
    probeOpenAiLikeEndpoint: surfaceProbe,
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
    withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    step: vi.fn(),
    resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    getGatewayName: () => "onboarding-gateway",
    runOpenshell,
    updateSandbox,
    setNativeBedrockProviderAuthority,
    getSandbox: () => null,
    upsertProvider: vi.fn(async () => ({ ok: true })),
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    isNonInteractive: () => true,
    hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
    providerAdapter,
    hydrateCredentialEnv: vi.fn(() => "host-only-compatible-credential"),
    redact: (value: string) => value,
    compactText: (value: string) => value,
    log: vi.fn(),
    error: vi.fn(),
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  } as unknown as SetupInferenceDeps);

  const run = setupInference(
    "alpha",
    "nvidia/nemotron-3-super-120b-a12b",
    provider,
    identity.endpoint + endpointSuffix,
    "COMPATIBLE_ANTHROPIC_API_KEY",
    null,
    [],
    { revalidateSandboxIdentity: () => undefined, preferredInferenceApi: "openai-completions" },
  );

  return {
    binding,
    identity,
    run,
    createProvider,
    importProviderProfile,
    getProvider,
    runOpenshell,
    updateSandbox,
    setNativeBedrockProviderAuthority,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    surfaceProbe,
  };
}

it.each(["", "/"])(
  "reserves the verified native Bedrock receipt before sandbox creation without shared-route effects (suffix %s)",
  async (suffix) => {
    const f = nativeBedrockOnboardingFixture(suffix);
    await expect(f.run).resolves.toEqual({ ok: true });
    expect(f.createProvider).toHaveBeenCalledOnce();
    expect(f.setNativeBedrockProviderAuthority).toHaveBeenCalledWith(
      "onboarding-gateway",
      expect.objectContaining({ ...f.binding, providerId: "provider-id" }),
    );
    expect(f.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeBedrockProviderAttachment: expect.objectContaining({
          ...f.binding,
          providerId: "provider-id",
        }),
        endpointUrl: f.binding.endpointUrl,
        preferredInferenceApi: "openai-completions",
      }),
    );
    expect(f.setNativeBedrockProviderAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      f.updateSandbox.mock.invocationCallOrder[0],
    );
    expect(f.verifyInferenceRoute).not.toHaveBeenCalled();
    expect(f.verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
    expect(f.runOpenshell).not.toHaveBeenCalled();
    expect(JSON.stringify(f.updateSandbox.mock.calls)).not.toContain("host-adapter-token");
  },
);
