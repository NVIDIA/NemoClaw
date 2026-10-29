// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "../inference/native-nvidia/contract";
import type { OllamaModelHolder } from "../inference/ollama/model-ownership";
import { setupOllamaLocalInference } from "./inference-providers/ollama-local";
import {
  createProviderReviewDeps,
  createSetupInference,
  type SetupInferenceDeps,
} from "./setup-inference";

// Reservation recovery has its own state tests; this suite injects registry writes.
vi.mock("./sandbox-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-lifecycle")>()),
  releaseAbandonedRouteReservation: vi.fn(() => false),
}));

const previousLocalOllamaRoute: OllamaModelHolder = {
  name: "alpha",
  provider: "ollama-local",
  model: "qwen2.5:1.5b",
  endpointUrl: "http://127.0.0.1:11434",
  gatewayName: "nemoclaw-32677",
  gatewayPort: 32677,
  lifecycleGeneration: "generation-alpha",
  lifecycleLiveIdentityFingerprint: "a".repeat(64),
};

describe("recorded Pi local inference route", () => {
  it("rejects a changed selection before invoking a provider or gateway", async () => {
    const getSandbox = vi.fn(() => ({
      agent: "pi",
      provider: "ollama-local",
      model: "qwen3:8b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
      createdAt: "2026-09-01T00:00:00Z",
    }));
    const requireNativeProviderPolicy = vi.fn();
    const setup = createSetupInference({
      getGatewayName: () => "nemoclaw",
      getSandbox,
      withSandboxMutationLock: (_name: string, operation: () => unknown) => operation(),
      requireNativeProviderPolicy,
    } as unknown as SetupInferenceDeps);

    await expect(
      setup(
        "alpha",
        "different-model",
        "ollama-local",
        "http://host.openshell.internal:11435/v1",
        null,
        null,
        [],
        { agentName: "pi", preserveLegacyPiSharedLocalRoute: true },
      ),
    ).rejects.toThrow("Recorded Pi shared local inference route changed before setup");
    expect(requireNativeProviderPolicy).not.toHaveBeenCalled();
  });
});

describe("createProviderReviewDeps", () => {
  it("prepares the Ollama proxy after review acceptance", async () => {
    const updateSession = vi.fn();
    const checkpointSandboxName = vi.fn(async () => undefined);
    const startOllamaAuthProxy = vi.fn(() => true);
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const getOllamaProxyToken = vi.fn(() => "proxy-token");
    const deps = createProviderReviewDeps(
      updateSession,
      checkpointSandboxName,
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      vi.fn(),
    );

    const preparedToken = await deps.prepareLocalProviderForInference("ollama-local");

    expect(startOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).toHaveBeenCalledOnce();
    expect(persistAndProbeOllamaProxy).toHaveBeenCalledWith("proxy-token");
    expect(preparedToken).toBe("proxy-token");
  });

  it("does not mutate local provider state for another provider", async () => {
    const startOllamaAuthProxy = vi.fn(() => true);
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy,
      },
      (code): never => {
        throw new Error(`exit ${code}`);
      },
      vi.fn(),
    );

    await expect(deps.prepareLocalProviderForInference("nvidia-prod")).resolves.toBeNull();

    expect(startOllamaAuthProxy).not.toHaveBeenCalled();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("exits without persisting when the Ollama proxy cannot start", async () => {
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy: () => false,
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      vi.fn(),
    );

    await expect(deps.prepareLocalProviderForInference("ollama-local")).rejects.toThrow("exit 1");

    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("exits without persisting when the Ollama proxy token is unavailable", async () => {
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const writeError = vi.fn();
    const deps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy: () => true,
        getOllamaProxyToken: () => null,
        persistAndProbeOllamaProxy,
      },
      exitProcess,
      writeError,
    );

    await expect(deps.prepareLocalProviderForInference("ollama-local")).rejects.toThrow("exit 1");

    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("proxy token is not set"));
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("hands the accepted proxy token to provider setup without repeating proxy mutations", async () => {
    const startOllamaAuthProxy = vi.fn(() => true);
    const getOllamaProxyToken = vi.fn(() => "proxy-token");
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const reviewDeps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
      (code): never => {
        throw new Error(`exit ${code}`);
      },
      vi.fn(),
    );
    const preparedProxyToken = await reviewDeps.prepareLocalProviderForInference("ollama-local");
    const ensureOllamaAuthProxy = vi.fn();

    await setupOllamaLocalInference(
      {
        model: "qwen3.5:9b",
        provider: "ollama-local",
        allowToolsIncompatible: false,
        preparedProxyToken: preparedProxyToken ?? undefined,
      },
      {
        runOpenshell: () => ({ status: 0 }),
        upsertProvider: async () => ({ ok: true }),
        verifyInferenceRoute: vi.fn(),
        verifyOnboardInferenceSmoke: vi.fn(),
        isNonInteractive: () => true,
        registry: { updateSandbox: vi.fn() as never },
        exitProcess: (code): never => {
          throw new Error(`exit ${code}`);
        },
        error: vi.fn(),
        log: vi.fn(),
        validateLocalProvider: () => ({ ok: true }),
        getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
        applyLocalInferenceRoute: async () => false,
        run: vi.fn() as never,
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy,
        isProxyHealthy: () => true,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
        localInference: {
          validateOllamaModelWithToolsOverride: () => ({ ok: true }),
          validateSandboxFacingOllamaModel: () => ({ ok: true }),
          runOllamaWarmup: () => {},
          persistResolvedOllamaHost: () => () => {},
        },
        OLLAMA_PROXY_CREDENTIAL_ENV: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      },
    );

    expect(startOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).toHaveBeenCalledOnce();
    expect(persistAndProbeOllamaProxy).toHaveBeenCalledOnce();
    expect(ensureOllamaAuthProxy).not.toHaveBeenCalled();
  });
});

describe("Personal custom endpoint onboarding", () => {
  it("resolves Personal before provider setup and keeps the shared route", async () => {
    const events: string[] = [];
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const attachProvider = vi.fn<OpenShellProviderAdapter["attachProvider"]>();
    const upsertProvider = vi.fn(async () => {
      events.push("shared-provider");
      return { ok: true };
    });
    const inferenceRouteMutator = {
      setInferenceRoute: vi.fn(async () => ({ ok: true as const })),
    };
    const setup = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) => {
        events.push("sandbox-lock");
        return await operation();
      },
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) => {
        events.push("gateway-lock");
        return await operation();
      },
      step: vi.fn(),
      getGatewayName: () => "nemoclaw",
      getSandbox: () => null,
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      inferenceRouteMutator,
      inferenceRouteObserver: {
        observeInferenceRoute: vi.fn(async () => ({
          ok: true as const,
          value: { state: "unconfigured" as const },
        })),
      },
      updateSandbox: vi.fn(() => true),
      upsertProvider,
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(),
      resolveEndpointHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
      resolvePolicyTier: async () => {
        events.push("policy-tier");
        return "personal";
      },
      bedrockRuntimeOnboard: {
        setupBedrockRuntimeInference: vi.fn(async () => ({ handled: false as const })),
      },
      openrouterRuntimeOnboard: {
        setupOpenRouterRuntimeInference: vi.fn(async () => ({ handled: false as const })),
      },
      isNonInteractive: () => false,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      providerAdapter: { createProvider, attachProvider } as unknown as OpenShellProviderAdapter,
      REMOTE_PROVIDER_CONFIG: {
        custom: {
          label: "Compatible endpoint",
          providerName: "compatible-endpoint",
          providerType: "openai",
          credentialEnv: "COMPATIBLE_API_KEY",
          endpointUrl: "https://api.example/v1",
          helpUrl: null,
          modelMode: "input",
          defaultModel: "model-a",
        },
      },
      hydrateCredentialEnv: vi.fn(() => "secret"),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    } as unknown as SetupInferenceDeps);

    await expect(
      setup(
        "alpha",
        "model-a",
        "compatible-endpoint",
        "https://api.example/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        { skipHostInferenceSmoke: true },
      ),
    ).resolves.toEqual({ ok: true });

    expect(events).toEqual(["policy-tier", "sandbox-lock", "gateway-lock", "shared-provider"]);
    expect(createProvider).not.toHaveBeenCalled();
    expect(attachProvider).not.toHaveBeenCalled();
    expect(inferenceRouteMutator.setInferenceRoute).toHaveBeenCalledOnce();
  });
});

describe("native NVIDIA onboarding", () => {
  const endpoints = ["https://integrate.api.nvidia.com/v1", "https://inference.local/v1", null];
  it.each(endpoints)("probes NVIDIA from saved endpoint %s (#13526)", async (endpointUrl) => {
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
          name: "nemoclaw-nvidia-prod-v1",
          type: "nemoclaw-nvidia-inference-v1",
          credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
          configKeys: [],
          revision: { id: "provider-id", resourceVersion: 4 },
        },
      });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
      ok: true,
    }));
    const providerAdapter = {
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
      importProviderProfile,
      getProvider,
      createProvider,
    } as unknown as OpenShellProviderAdapter;
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0, stdout: "", stderr: "" }));
    const events: string[] = [];
    const updateSandbox = vi.fn(() => {
      events.push("route-published");
      return true;
    });
    const unloadOllamaModels = vi.fn(() => {
      events.push("unload");
      return {
        ok: true as const,
        outcome: "released" as const,
        endpoint: "http://127.0.0.1:11434",
        selectedModels: ["qwen2.5:1.5b"],
        discoveries: [],
        requests: [],
      };
    });
    const setNativeNvidiaProviderAuthority = vi.fn(() => true);
    const verifyInferenceRoute = vi.fn();
    const verifyOnboardInferenceSmoke = vi.fn(async () => undefined);
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "onboarding-gateway",
      runOpenshell,
      updateSandbox,
      setNativeNvidiaProviderAuthority,
      getSandbox: () => previousLocalOllamaRoute,
      localInference: {
        loadPersistedOllamaHost: () => "127.0.0.1",
        loadPendingOllamaModelCleanup: () => [],
        persistPendingOllamaModelCleanup: vi.fn(),
        clearPendingOllamaModelCleanup: vi.fn(),
        clearPersistedOllamaHostIfUnused: vi.fn(),
      },
      listOllamaModelOwnershipPeers: () => [],
      discoverActiveOllamaSandboxNames: () => ({
        ok: true as const,
        activeSandboxNames: new Set<string>(),
        gatewayChecks: [],
      }),
      unloadOllamaModels,
      withOllamaModelOwnershipLock: (operation: () => void) => operation(),
      withOllamaModelOwnershipTransaction: async <T>(operation: () => Promise<T> | T) => {
        events.push("ownership-transaction-start");
        const result = await operation();
        events.push("ownership-transaction-end");
        return result;
      },
      upsertProvider: vi.fn(async () => ({ ok: true })),
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      providerAdapter,
      hydrateCredentialEnv: vi.fn(() => "host-only-nvidia-credential"),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "alpha",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia-prod",
        endpointUrl,
        "NVIDIA_INFERENCE_API_KEY",
        null,
        [],
        { revalidateSandboxIdentity: () => undefined },
      ),
    ).resolves.toEqual({ ok: true });

    expect(importProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "onboarding-gateway" },
      }),
    );
    expect(getProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "onboarding-gateway" },
      providerName: "nemoclaw-nvidia-prod-v1",
    });
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "onboarding-gateway" },
        name: "nemoclaw-nvidia-prod-v1",
        credentials: [{ name: "NVIDIA_INFERENCE_API_KEY", value: "host-only-nvidia-credential" }],
        config: [],
      }),
    );
    expect(
      runOpenshell.mock.calls.filter(([args]) => args[0] === "inference" && args[1] === "set"),
    ).toEqual([]);
    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(verifyOnboardInferenceSmoke).toHaveBeenCalledOnce();
    expect(verifyOnboardInferenceSmoke).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "nvidia-prod",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
      }),
    );
    expect(updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        endpointUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
        nativeNvidiaProviderAttachment: {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "provider-id",
        },
      }),
    );
    expect(events.indexOf("route-published")).toBeLessThan(events.indexOf("unload"));
    expect(events[0]).toBe("ownership-transaction-start");
    expect(events.at(-1)).toBe("ownership-transaction-end");
    expect(unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["qwen2.5:1.5b"]);
    expect(setNativeNvidiaProviderAuthority).toHaveBeenCalledWith("onboarding-gateway", {
      schemaVersion: 1,
      profileId: "nemoclaw-nvidia-inference-v1",
      providerName: "nemoclaw-nvidia-prod-v1",
      providerId: "provider-id",
    });
  });

  it("removes a new provider when gateway authority persistence fails (#12562)", async () => {
    let providerPresent = false;
    const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>(async () =>
      providerPresent
        ? {
            ok: true,
            value: {
              name: "nemoclaw-nvidia-prod-v1",
              type: "nemoclaw-nvidia-inference-v1",
              credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
              configKeys: [],
              revision: { id: "provider-id", resourceVersion: 4 },
            },
          }
        : {
            ok: false,
            error: { kind: "command", reason: "not_found", message: "not found" },
          },
    );
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => {
      providerPresent = false;
      return { ok: true };
    });
    const providerAdapter = {
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
      importProviderProfile: vi.fn(async () => ({ ok: true as const })),
      getProvider,
      createProvider: vi.fn(async () => {
        providerPresent = true;
        return { ok: true as const };
      }),
      deleteProvider,
    } as unknown as OpenShellProviderAdapter;
    const updateSandbox = vi.fn(() => true);
    const verifyOnboardInferenceSmoke = vi.fn(async () => undefined);
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "onboarding-gateway",
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      updateSandbox,
      getSandbox: () => null,
      getNativeNvidiaProviderAuthority: () => undefined,
      setNativeNvidiaProviderAuthority: () => {
        throw new Error("state directory is read-only");
      },
      upsertProvider: vi.fn(async () => ({ ok: true })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke,
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      providerAdapter,
      hydrateCredentialEnv: vi.fn(() => "host-only-nvidia-credential"),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "alpha",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia-prod",
        "https://integrate.api.nvidia.com/v1",
        "NVIDIA_INFERENCE_API_KEY",
        null,
        [],
        { revalidateSandboxIdentity: () => undefined },
      ),
    ).rejects.toThrow(/newly created provider was removed.*state directory is read-only/su);

    expect(deleteProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "onboarding-gateway" },
      providerName: "nemoclaw-nvidia-prod-v1",
    });
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
  });

  it.each(["fresh", "recorded"])("reuses native NVIDIA without a host key (%s)", async (state) => {
    const receipt = {
      schemaVersion: 1 as const,
      profileId: "nemoclaw-nvidia-inference-v1" as const,
      providerName: "nemoclaw-nvidia-prod-v1" as const,
      providerId: "provider-id",
    };
    const importProviderProfile = vi.fn(async () => ({ ok: true as const }));
    const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
      ok: true,
      value: {
        name: "nemoclaw-nvidia-prod-v1",
        type: "nemoclaw-nvidia-inference-v1",
        credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
        configKeys: [],
        revision: { id: "provider-id", resourceVersion: 4 },
      },
    }));
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>();
    const updateSandbox = vi.fn(() => true);
    const verifyOnboardInferenceSmoke = vi.fn(async () => undefined);
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "onboarding-gateway",
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      updateSandbox,
      getSandbox: () =>
        state === "recorded"
          ? {
              name: "second",
              provider: "nvidia-prod",
              nativeNvidiaProviderAttachment: receipt,
            }
          : null,
      getNativeNvidiaProviderAuthority: () => receipt,
      upsertProvider: vi.fn(async () => ({ ok: true })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke,
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      providerAdapter: {
        ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
        importProviderProfile,
        getProvider,
        createProvider,
        updateProvider,
      } as unknown as OpenShellProviderAdapter,
      hydrateCredentialEnv: vi.fn(() => null),
      localInference: {},
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "second",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia-prod",
        "https://integrate.api.nvidia.com/v1",
        "NVIDIA_INFERENCE_API_KEY",
        null,
        [],
        {
          revalidateSandboxIdentity: () => undefined,
          reuseGatewayCredentialWithoutLocalKey: state === "fresh",
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(createProvider).not.toHaveBeenCalled();
    expect(updateProvider).not.toHaveBeenCalled();
    expect(verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
    expect(updateSandbox).toHaveBeenCalledWith(
      "second",
      expect.objectContaining({
        nativeNvidiaProviderAttachment: expect.objectContaining({ providerId: "provider-id" }),
      }),
    );
  });

  it.each([
    [
      "only the registry records ownership",
      false,
      /only the NemoClaw registry record for sandbox 'alpha'.*'nemoclaw alpha destroy'/su,
    ],
    ["the gateway records ownership", true, /complete uninstall without --keep-openshell/u],
  ])("explains a missing NVIDIA provider when %s", async (_case, gatewayOwned, message) => {
    const receipt = {
      schemaVersion: 1,
      profileId: "nemoclaw-nvidia-inference-v1",
      providerName: "nemoclaw-nvidia-prod-v1",
      providerId: "provider-id",
    } as const;
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "onboarding-gateway",
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      updateSandbox: vi.fn(() => true),
      getSandbox: () => ({
        name: "alpha",
        provider: "nvidia-prod",
        nativeNvidiaProviderAttachment: receipt,
      }),
      getNativeNvidiaProviderAuthority: () => (gatewayOwned ? receipt : undefined),
      upsertProvider: vi.fn(async () => ({ ok: true })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(async () => undefined),
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      providerAdapter: {
        ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
        importProviderProfile: vi.fn(async () => ({ ok: true as const })),
        getProvider: vi.fn(async () => ({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "not found" },
        })),
        createProvider,
      } as unknown as OpenShellProviderAdapter,
      hydrateCredentialEnv: vi.fn(() => "host-only-nvidia-credential"),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "alpha",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia-prod",
        "https://integrate.api.nvidia.com/v1",
        "NVIDIA_INFERENCE_API_KEY",
        null,
        [],
        { revalidateSandboxIdentity: () => undefined },
      ),
    ).rejects.toThrow(message);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("requires recreation instead of recording a receipt for a legacy NVIDIA sandbox", async () => {
    const providerAdapter = {
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
      importProviderProfile: vi.fn(),
      getProvider: vi.fn(),
      updateProvider: vi.fn(),
    } as unknown as OpenShellProviderAdapter;
    const updateSandbox = vi.fn(() => true);
    const setupInference = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "nemoclaw",
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      updateSandbox,
      getSandbox: () => ({ name: "alpha", provider: "nvidia-prod" }) as never,
      upsertProvider: vi.fn(async () => ({ ok: true })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(async () => undefined),
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      providerAdapter,
      hydrateCredentialEnv: vi.fn(() => "host-only-nvidia-credential"),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
    } as unknown as SetupInferenceDeps);

    await expect(
      setupInference(
        "alpha",
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia-prod",
        "https://integrate.api.nvidia.com/v1",
        "NVIDIA_INFERENCE_API_KEY",
      ),
    ).rejects.toThrow(/Recreate this beta sandbox.*does not migrate existing beta sandboxes/u);

    expect(providerAdapter.importProviderProfile).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });
});

describe("concurrent Ollama ownership transactions", () => {
  it("serializes route publication before superseded-model release (#12677)", async () => {
    const events: string[] = [];
    const registry = new Map<string, OllamaModelHolder>([
      [
        "alpha",
        {
          name: "alpha",
          provider: "ollama-local",
          model: "qwen2.5:1.5b",
          endpointUrl: "http://127.0.0.1:11434/v1",
          gatewayName: "gateway-alpha",
        },
      ],
      [
        "beta",
        {
          name: "beta",
          provider: "compatible-endpoint",
          model: "previous-model",
          endpointUrl: "https://previous.example/v1",
          gatewayName: "gateway-beta",
        },
      ],
    ]);
    let signalBetaRouteStarted!: () => void;
    let signalAlphaRouteStarted!: () => void;
    let releaseBetaRoute!: () => void;
    let signalAlphaQueued!: () => void;
    const betaRouteStarted = new Promise<void>((resolve) => {
      signalBetaRouteStarted = resolve;
    });
    const alphaRouteStarted = new Promise<void>((resolve) => {
      signalAlphaRouteStarted = resolve;
    });
    const allowBetaRouteToFinish = new Promise<void>((resolve) => {
      releaseBetaRoute = resolve;
    });
    const alphaQueuedForTransaction = new Promise<void>((resolve) => {
      signalAlphaQueued = resolve;
    });
    const transactionLabels = ["gateway-beta", "gateway-alpha"];
    let transactionTail = Promise.resolve();
    let transactionCalls = 0;
    const withOwnershipTransaction: NonNullable<
      SetupInferenceDeps["withOllamaModelOwnershipTransaction"]
    > = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      transactionCalls += 1;
      const label = transactionLabels[transactionCalls - 1] ?? "unknown";
      events.push(`transaction-request:${label}`);
      [() => undefined, signalAlphaQueued][transactionCalls - 1]?.();
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      events.push(`transaction-enter:${label}`);
      try {
        const result = await operation();
        events.push(`transaction-exit:${label}`);
        return result;
      } finally {
        release();
      }
    };
    const signalRouteStarted: Record<string, () => void> = {
      "gateway-alpha": signalAlphaRouteStarted,
      "gateway-beta": signalBetaRouteStarted,
    };
    const inferenceRouteMutator: SetupInferenceDeps["inferenceRouteMutator"] = {
      setInferenceRoute: async (request) => {
        const gateway = request.target.gatewayName;
        events.push(`route-start:${gateway}`);
        signalRouteStarted[gateway]?.();
        await (gateway === "gateway-beta" ? allowBetaRouteToFinish : Promise.resolve());
        events.push(`route-finished:${gateway}`);
        return { ok: true };
      },
    };
    const updateSandbox: SetupInferenceDeps["updateSandbox"] = (name, route) => {
      const previous = registry.get(name);
      registry.set(name, { ...previous, ...route, name } as OllamaModelHolder);
      events.push(`registry-published:${name}`);
      return true;
    };
    const listOllamaModelOwnershipPeers = vi.fn(() => {
      events.push("peer-discovery");
      return [...registry.values()];
    });
    const unloadOllamaModels = vi.fn(() => {
      events.push("unload");
      return {
        ok: true as const,
        outcome: "released" as const,
        endpoint: "http://127.0.0.1:11434",
        selectedModels: ["qwen2.5:1.5b"],
        discoveries: [],
        requests: [],
      };
    });
    const localInference = {
      loadPersistedOllamaHost: () => "127.0.0.1",
      loadPendingOllamaModelCleanup: () => [],
      persistPendingOllamaModelCleanup: vi.fn(),
      clearPendingOllamaModelCleanup: vi.fn(),
      clearPersistedOllamaHostIfUnused: vi.fn(),
    };
    const deps = {
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
      withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
        await operation(),
      step: vi.fn(),
      getGatewayName: () => "gateway-default",
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      inferenceRouteMutator,
      inferenceRouteObserver: {
        observeInferenceRoute: vi.fn(async () => ({ ok: true as const })),
      } as unknown as SetupInferenceDeps["inferenceRouteObserver"],
      updateSandbox,
      getSandbox: (name: string) => registry.get(name) ?? null,
      listOllamaModelOwnershipPeers,
      discoverActiveOllamaSandboxNames: (owners: readonly OllamaModelHolder[]) => ({
        ok: true as const,
        activeSandboxNames: new Set(owners.map((owner) => owner.name)),
        gatewayChecks: [],
      }),
      localInference,
      unloadOllamaModels,
      withOllamaModelOwnershipLock: (operation: () => void) => operation(),
      withOllamaModelOwnershipTransaction: withOwnershipTransaction,
      upsertProvider: vi.fn(async () => ({ ok: true as const })),
      bedrockRuntimeOnboard: {
        setupBedrockRuntimeInference: vi.fn(async () => ({ handled: false as const })),
      },
      openrouterRuntimeOnboard: {
        setupOpenRouterRuntimeInference: vi.fn(async () => ({ handled: false as const })),
      },
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(async () => undefined),
      isNonInteractive: () => true,
      hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
      hydrateCredentialEnv: vi.fn(() => "test-compatible-api-key"),
      redact: (value: string) => value,
      compactText: (value: string) => value,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: vi.fn((code: number): never => {
        throw new Error(`exit ${code}`);
      }),
      localInferenceTimeoutSecs: 30,
      vllmLocalCredentialEnv: "VLLM_API_KEY",
      ollamaProxyCredentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      isRoutedInferenceProvider: () => false,
    } as unknown as SetupInferenceDeps;
    const setupAlpha = createSetupInference(deps);
    const setupBeta = createSetupInference(deps);
    const betaSwitch = setupBeta(
      "beta",
      "qwen2.5:1.5b",
      "compatible-endpoint",
      "http://127.0.0.1:11434/v1",
      "COMPATIBLE_API_KEY",
      null,
      [],
      {
        gatewayName: "gateway-beta",
        endpointPinnedAddresses: ["127.0.0.1"],
        skipHostInferenceSmoke: true,
      },
    );

    await betaRouteStarted;
    const alphaSwitch = setupAlpha(
      "alpha",
      "other-model",
      "compatible-endpoint",
      "https://api.example.test/v1",
      "COMPATIBLE_API_KEY",
      null,
      [],
      {
        gatewayName: "gateway-alpha",
        endpointPinnedAddresses: ["93.184.216.34"],
        skipHostInferenceSmoke: true,
      },
    );
    const alphaOrder = await Promise.race([
      alphaQueuedForTransaction.then(() => "queued"),
      alphaRouteStarted.then(() => "route-started"),
    ]);
    releaseBetaRoute();
    await expect(Promise.all([alphaSwitch, betaSwitch])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);

    expect(alphaOrder).toBe("queued");
    expect(events).toContain("registry-published:beta");
    expect(events).toContain("route-start:gateway-alpha");
    expect(events).toContain("transaction-exit:gateway-beta");
    expect(events).toContain("transaction-exit:gateway-alpha");
    expect(events).toContain("peer-discovery");
    expect(events.indexOf("transaction-exit:gateway-beta")).toBeLessThan(
      events.indexOf("route-start:gateway-alpha"),
    );
    expect(events.indexOf("registry-published:beta")).toBeLessThan(
      events.indexOf("route-start:gateway-alpha"),
    );
    expect(events.indexOf("transaction-exit:gateway-beta")).toBeLessThan(
      events.indexOf("peer-discovery"),
    );
    expect(events.indexOf("registry-published:alpha")).toBeLessThan(
      events.indexOf("peer-discovery"),
    );
    expect(events.indexOf("peer-discovery")).toBeLessThan(
      events.indexOf("transaction-exit:gateway-alpha"),
    );
    expect(listOllamaModelOwnershipPeers).toHaveBeenCalledOnce();
    expect(unloadOllamaModels).not.toHaveBeenCalled();
  }, 20_000);
});
