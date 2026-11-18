// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { getInstalledOpenshellVersion } from "./openshell-version";

import { cliOpenShellInstalledVersionObserver } from "../adapters/openshell/installed-version-cli";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import type { OpenShellSandboxPolicyReader } from "../adapters/openshell/sandbox-policy";
import { customNativeProvider } from "../inference/native-provider/custom";
import { nativeProviderLifecycle } from "../inference/native-provider";
import type { SandboxEntry } from "../state/registry/types";
import { redactFullWithUrls } from "../security/redact";
import { createDirectSetupInferenceHarnessFactory } from "../../../test/support/setup-inference-test-harness";
import { NVIDIA_HOSTED_NATIVE_ENDPOINT } from "../inference/native-nvidia/contract";
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

it.each([
  { label: "0.1.3", observation: { ok: true, version: "0.1.3" } },
  { label: "unknown", observation: { ok: false, error: { kind: "timeout", message: "timeout" } } },
] as const)(
  "rejects direct retained Pi setup before route mutation on OpenShell $label",
  async ({ observation }) => {
    vi.spyOn(cliOpenShellInstalledVersionObserver, "observeInstalledVersion").mockReturnValue(
      observation,
    );
    const recorded = {
      agent: "pi",
      provider: "ollama-local",
      model: "qwen3:8b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
      createdAt: "2026-09-01T00:00:00Z",
    };
    const withGatewayRouteMutationLock = vi.fn();
    const requireNativeProviderPolicy = vi.fn();
    const updateSandbox = vi.fn();
    const setup = createSetupInference({
      getGatewayName: () => "nemoclaw",
      getSandbox: () => recorded,
      getInstalledOpenshellVersion,
      withSandboxMutationLock: (_name: string, operation: () => unknown) => operation(),
      withGatewayRouteMutationLock,
      requireNativeProviderPolicy,
      updateSandbox,
    } as unknown as SetupInferenceDeps);
    await expect(
      setup("alpha", recorded.model, recorded.provider, recorded.endpointUrl, null, null, [], {
        agentName: "pi",
        preserveLegacyPiSharedLocalRoute: true,
      }),
    ).rejects.toThrow("Cannot resume a legacy Pi shared inference route");
    expect(withGatewayRouteMutationLock).not.toHaveBeenCalled();
    expect(requireNativeProviderPolicy).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  },
);

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

describe("custom native onboarding policy admission", () => {
  function fixture(
    document: string,
    registration: Pick<SandboxEntry, "createdAt" | "pendingRouteReservation"> | null = {
      createdAt: "2026-10-28T00:00:00Z",
    },
    setupOptions: Record<string, unknown> = {},
  ) {
    const binding = {
      provider: "compatible-endpoint",
      endpointUrl: "https://api.example.com/v1",
      api: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
      allowedIps: ["8.8.8.8"],
    } as const;
    const definition = customNativeProvider(binding);
    const metadata = (selected: typeof definition) => ({
      name: selected.providerName,
      type: selected.profileId,
      credentialKeys: [selected.credentialEnv],
      configKeys: [],
      revision: { id: "provider-identity", resourceVersion: 1 },
    });
    const previous = customNativeProvider({
      ...binding,
      endpointUrl: "https://old.example.com/v1",
    });
    let present = false;
    const adapter = {
      importProviderProfile: vi.fn(async () => ({ ok: true as const })),
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true as const, value: undefined })),
      getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async () =>
        present
          ? { ok: true, value: metadata(definition) }
          : { ok: false, error: { kind: "command", reason: "not_found", message: "absent" } },
      ),
      createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => {
        present = true;
        return { ok: true };
      }),
      attachProvider: vi.fn<OpenShellProviderAdapter["attachProvider"]>(),
      updateProvider: vi.fn<OpenShellProviderAdapter["updateProvider"]>(),
    };
    const readSandboxPolicy = vi.fn<OpenShellSandboxPolicyReader["readSandboxPolicy"]>(
      async () => ({
        ok: true,
        value: { document, appliedRevision: 1 },
      }),
    );
    const writeAuthority = vi.fn();
    const h = createDirectSetupInferenceHarnessFactory((deps) =>
      createSetupInference(deps as SetupInferenceDeps),
    )({
      overrides: {
        providerAdapter: adapter as unknown as OpenShellProviderAdapter,
        sandboxPolicyReader: { readSandboxPolicy },
        getSandbox: () =>
          registration
            ? {
                name: "alpha",
                agent: "openclaw",
                provider: binding.provider,
                ...registration,
                nativeHostedProviderAttachment: nativeProviderLifecycle(
                  previous,
                ).nativeProviderAttachmentFromMetadata(metadata(previous)),
              }
            : null,
        getNativeHostedProviderAuthority: () => undefined,
        setNativeHostedProviderAuthority: writeAuthority,
        hydrateCredentialEnv: () => "synthetic-secret",
        resolveEndpointHost: async () => [{ address: "8.8.8.8", family: 4 }],
        resolvePolicyTier: async () => "balanced",
        requireNativeProviderPolicy: async () => {},
        redact: redactFullWithUrls,
        compactText: (value) => value,
      },
    });
    const select = () =>
      h.setupInference(
        "alpha",
        "model-a",
        binding.provider,
        binding.endpointUrl,
        binding.credentialEnv,
        null,
        [],
        { skipHostInferenceSmoke: true, ...setupOptions },
      );
    return { ...h, adapter, readSandboxPolicy, writeAuthority, select };
  }

  const policy = (pins = "") =>
    `version: 1\nnetwork_policies:\n  existing_policy:\n    endpoints:\n      - host: '*.example.com'\n        port: 443\n${pins}`;

  const generatedPolicy =
    "  _provider_previous_custom:\n    endpoints:\n      - host: api.example.com\n        port: 443\n";
  const matchingPolicyWithGeneratedRule =
    policy("        allowed_ips: [8.8.8.8]\n") + generatedPolicy;

  it.each([
    { source: "live", setupOptions: {} },
    {
      source: "retained rebuild",
      setupOptions: { rebuildSandboxPolicyDocument: matchingPolicyWithGeneratedRule },
    },
  ])(
    "ignores generated rules in the $source policy before provider setup",
    async ({ setupOptions }) => {
      const h = fixture(matchingPolicyWithGeneratedRule, undefined, setupOptions);
      await expect(h.select()).resolves.toMatchObject({ ok: true });
      expect(h.adapter.createProvider).toHaveBeenCalledOnce();
      expect(h.writeAuthority).toHaveBeenCalledOnce();
    },
  );

  it("refuses a retained base conflict beside a generated rule before provider setup", async () => {
    const h = fixture(policy() + generatedPolicy);
    await expect(h.select()).rejects.toThrow(/existing_policy.*IP pins/);
    expect(h.adapter.createProvider).not.toHaveBeenCalled();
    expect(h.adapter.attachProvider).not.toHaveBeenCalled();
    expect(h.writeAuthority).not.toHaveBeenCalled();
    expect(h.updateSandbox).not.toHaveBeenCalled();
  });

  it.each(["", "        allowed_ips: [1.1.1.1]\n"])(
    "rejects existing sandbox pin conflicts before provider mutation (%j)",
    async (pins) => {
      const h = fixture(policy(pins));
      await expect(h.select()).rejects.toThrow('Existing policy "existing_policy"');
      expect(h.readSandboxPolicy).toHaveBeenCalledWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
        scope: "base",
      });
      expect(h.adapter.createProvider).not.toHaveBeenCalled();
      expect(h.adapter.attachProvider).not.toHaveBeenCalled();
      expect(h.adapter.updateProvider).not.toHaveBeenCalled();
      expect(h.writeAuthority).not.toHaveBeenCalled();
      expect(h.updateSandbox).not.toHaveBeenCalled();
    },
  );

  it("stops existing sandbox onboarding when its policy cannot be read", async () => {
    const h = fixture(policy());
    h.readSandboxPolicy.mockResolvedValue({
      ok: false,
      error: {
        kind: "timeout",
        message: "policy read timed out Authorization: Bearer synthetic-policy-secret",
      },
    });
    const failure = await h.select().then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    expect(failure).toContain("policy read timed out");
    expect(failure).toContain("Bearer <REDACTED>");
    expect(failure).not.toContain("synthetic-policy-secret");
    expect(h.adapter.createProvider).not.toHaveBeenCalled();
    expect(h.writeAuthority).not.toHaveBeenCalled();
    expect(h.updateSandbox).not.toHaveBeenCalled();
  });

  it("keeps matching pins valid for existing sandbox onboarding", async () => {
    const h = fixture(policy("        allowed_ips: [8.8.8.8]\n"));
    await expect(h.select()).resolves.toMatchObject({ ok: true });
    expect(h.readSandboxPolicy).toHaveBeenCalledOnce();
    expect(h.adapter.createProvider).toHaveBeenCalledOnce();
    expect(h.writeAuthority).toHaveBeenCalledOnce();
  });

  it("admits a rebuilt provider using its retained policy after sandbox deletion", async () => {
    const h = fixture(policy(), undefined, {
      rebuildSandboxPolicyDocument: policy("        allowed_ips: [8.8.8.8]\n"),
    });
    h.readSandboxPolicy.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "failed", message: "sandbox was deleted for rebuild" },
    });
    await expect(h.select()).resolves.toMatchObject({ ok: true });
    expect(h.readSandboxPolicy).not.toHaveBeenCalled();
    expect(h.adapter.createProvider).toHaveBeenCalledOnce();
    expect(h.writeAuthority).toHaveBeenCalledOnce();
  });

  it.each([policy(), "version: 1\nnetwork_policies: []\n"])(
    "rejects an incompatible retained rebuild policy before provider mutation (%j)",
    async (rebuildSandboxPolicyDocument) => {
      const h = fixture(policy("        allowed_ips: [8.8.8.8]\n"), undefined, {
        rebuildSandboxPolicyDocument,
      });
      await expect(h.select()).rejects.toThrow();
      expect(h.readSandboxPolicy).not.toHaveBeenCalled();
      expect(h.adapter.createProvider).not.toHaveBeenCalled();
      expect(h.writeAuthority).not.toHaveBeenCalled();
    },
  );

  it.each([null, { pendingRouteReservation: true as const }])(
    "prepares a provider before sandbox creation without reading an absent policy (%j)",
    async (registration) => {
      const h = fixture(policy(), registration);
      await expect(h.select()).resolves.toMatchObject({ ok: true });
      expect(h.readSandboxPolicy).not.toHaveBeenCalled();
      expect(h.adapter.createProvider).toHaveBeenCalledOnce();
      expect(h.writeAuthority).toHaveBeenCalledOnce();
    },
  );

  it("checks the policy of a created sandbox even when its route reservation is pending", async () => {
    const h = fixture(policy(), {
      pendingRouteReservation: true,
      createdAt: "2026-10-28T00:00:00Z",
    });
    await expect(h.select()).rejects.toThrow('Existing policy "existing_policy"');
    expect(h.readSandboxPolicy).toHaveBeenCalledOnce();
    expect(h.adapter.createProvider).not.toHaveBeenCalled();
    expect(h.writeAuthority).not.toHaveBeenCalled();
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
    const updateSandbox = vi.fn(() => true);
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
      getSandbox: () => null,
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
