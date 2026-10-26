// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { createSetupInference, type SetupInferenceDeps } from "../../setup-inference";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

it.each([
  {
    name: "langchain-deepagents-code",
    provider: "ollama-local",
    endpointUrl: "http://host.openshell.internal:11434/v1",
  },
  { name: "pi", provider: "ollama-local", endpointUrl: "http://host.openshell.internal:11434/v1" },
  {
    name: "pi",
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:12345/v1",
  },
])(
  "admits selected $name $provider inference when the prior registration was Hermes",
  async ({ name, provider, endpointUrl }) => {
    const { deps, calls } = createDeps();
    const session = createSession();
    calls.setupNim.mockResolvedValue({
      ...baseSelection,
      provider,
      model: "local-model",
      endpointUrl,
      credentialEnv: null,
    });
    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "same-sandbox",
      agent: { name },
    });

    // Stop at the next real boundary after agent admission, before provider mutation.
    const policyFailure = new Error("fixture policy unavailable");
    const requireNativeProviderPolicy = vi.fn(async () => {
      throw policyFailure;
    });
    const setup = createSetupInference({
      getGatewayName: () => "nemoclaw",
      getSandbox: () => ({ agent: "hermes" }),
      requireNativeProviderPolicy,
      withSandboxMutationLock: (_name: string, operation: () => unknown) => operation(),
    } as unknown as SetupInferenceDeps);
    expect(calls.setupInference).toHaveBeenCalledOnce();
    await expect(setup(...calls.setupInference.mock.calls[0]!)).rejects.toBe(policyFailure);
    expect(requireNativeProviderPolicy).toHaveBeenCalledWith("nemoclaw");
  },
);

it.each(["openclaw", "hermes"])(
  "keeps selected %s local inference on the existing shared route",
  async (name) => {
    const { deps, calls } = createDeps();
    const session = createSession();
    calls.setupNim.mockResolvedValue({
      ...baseSelection,
      provider: "ollama-local",
      model: "local-model",
      endpointUrl: "http://host.openshell.internal:11434/v1",
      credentialEnv: null,
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "same-sandbox",
      agent: { name },
    });

    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.setupInference.mock.calls[0]?.[7]).toEqual(
      expect.objectContaining({ agentName: name }),
    );
  },
);

it.each(["openclaw", "langchain-deepagents-code"])(
  "keeps selected %s Local NIM on its owned shared route",
  async (name) => {
    let sharedRoute = { provider: "vllm-local", model: "prior-nim-model" };
    const inferenceRouteMutator = {
      setInferenceRoute: vi.fn(async (request: { route: typeof sharedRoute }) => {
        sharedRoute = request.route;
        return { ok: true as const };
      }),
    };
    const nativeProviderAdapter = { registerProvider: vi.fn(), attachProvider: vi.fn() };
    const requireNativeProviderPolicy = vi.fn(async () => {
      throw new Error("native policy must not run for NIM");
    });
    const upsertProvider = vi.fn(async () => ({ ok: true as const }));
    const setup = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_sandbox: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_gateway: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "nemoclaw",
      getSandbox: () => ({
        agent: name,
        provider: "vllm-local",
        model: "prior-nim-model",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        nimContainer: "nemoclaw-nim-owned",
      }),
      localInference: {
        loadPendingOllamaModelCleanup: vi.fn(() => []),
        loadPersistedOllamaHost: vi.fn(() => null),
      },
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      inferenceRouteMutator,
      inferenceRouteObserver: {
        observeInferenceRoute: vi.fn(async () => ({
          ok: true as const,
          value: { state: "configured" as const, route: sharedRoute },
        })),
      },
      upsertProvider,
      updateSandbox: vi.fn(() => true),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(),
      validateLocalProvider: vi.fn(() => ({ ok: true as const })),
      getLocalProviderBaseUrl: () => "http://host.openshell.internal:8000/v1",
      getManagedVllmProviderBinding: () => null,
      vllmLocalCredentialEnv: "NEMOCLAW_VLLM_LOCAL_TOKEN",
      localInferenceTimeoutSecs: 60,
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      requireNativeProviderPolicy,
      providerAdapter: nativeProviderAdapter,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    } as unknown as SetupInferenceDeps);
    const { deps, calls } = createDeps({ setupInference: setup });
    calls.setupNim.mockResolvedValue({
      ...baseSelection,
      provider: "vllm-local",
      model: "nim-model",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      nimContainer: "nemoclaw-nim-owned",
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, createSession()),
      sandboxName: "nim-sandbox",
      agent: { name },
    });

    expect(inferenceRouteMutator.setInferenceRoute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "nemoclaw" },
        route: { provider: "vllm-local", model: "nim-model" },
      }),
    );
    expect(requireNativeProviderPolicy).not.toHaveBeenCalled();
    expect(nativeProviderAdapter.registerProvider).not.toHaveBeenCalled();
    expect(nativeProviderAdapter.attachProvider).not.toHaveBeenCalled();
    expect(upsertProvider).toHaveBeenCalledWith(
      "vllm-local",
      "openai",
      "NEMOCLAW_VLLM_LOCAL_TOKEN",
      "http://host.openshell.internal:8000/v1",
      { NEMOCLAW_VLLM_LOCAL_TOKEN: "dummy" },
      "nemoclaw",
    );
    const probeInferenceLocal = (url: string) => {
      expect(url).toBe("http://inference.local/v1/models");
      return sharedRoute.model;
    };
    expect(probeInferenceLocal("http://inference.local/v1/models")).toBe("nim-model");
  },
);
