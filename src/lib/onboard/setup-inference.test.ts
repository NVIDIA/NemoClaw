// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import type { OllamaModelHolder } from "../inference/ollama/model-ownership";
import type { SandboxEntry } from "../state/registry";
import { setupOllamaLocalInference } from "./inference-providers/ollama-local";
import {
  createProviderReviewDeps,
  createSetupInference,
  releaseSupersededOllamaModel,
  type SetupInferenceDeps,
} from "./setup-inference";

// Reservation recovery has its own state tests; this suite injects registry writes.
vi.mock("./sandbox-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-lifecycle")>()),
  releaseAbandonedRouteReservation: vi.fn(() => false),
}));

function createOllamaCleanupHarness(
  options: {
    peers?: readonly SandboxEntry[];
    useProductionPeerSource?: boolean;
    useProductionDiscovery?: boolean;
    activeSandboxNames?: ReadonlySet<string>;
    discovery?: SetupInferenceDeps["discoverActiveOllamaSandboxNames"];
    pendingModels?: readonly string[];
  } = {},
) {
  let pendingModels = [...(options.pendingModels ?? [])];
  const localInference = {
    loadPersistedOllamaHost: vi.fn(() => "127.0.0.1"),
    loadPendingOllamaModelCleanup: vi.fn(() => pendingModels),
    persistPendingOllamaModelCleanup: vi.fn((_name: string, models: readonly string[]) => {
      pendingModels = [...new Set([...pendingModels, ...models])];
    }),
    clearPendingOllamaModelCleanup: vi.fn((_name: string, models: readonly string[]) => {
      pendingModels = pendingModels.filter((model) => !models.includes(model));
    }),
    clearPersistedOllamaHostIfUnused: vi.fn(),
  };
  const unloadOllamaModels = vi.fn(() => ({
    ok: true,
    outcome: "released" as const,
    endpoint: "http://127.0.0.1:11434",
    selectedModels: ["qwen2.5:1.5b"],
    discoveries: [],
    requests: [],
  }));
  const discoverActiveOllamaSandboxNames = vi.fn(
    options.discovery ??
      (() => ({
        ok: true as const,
        activeSandboxNames: options.activeSandboxNames ?? new Set<string>(),
        gatewayChecks: [],
      })),
  );
  const deps = {
    localInference,
    ...(options.useProductionPeerSource
      ? {}
      : { listOllamaModelOwnershipPeers: () => options.peers ?? [] }),
    ...(!options.useProductionDiscovery ? { discoverActiveOllamaSandboxNames } : {}),
    unloadOllamaModels,
    withOllamaModelOwnershipLock: (operation: () => void) => operation(),
  } as unknown as SetupInferenceDeps;
  return { deps, localInference, unloadOllamaModels, discoverActiveOllamaSandboxNames };
}

const previousLocalOllamaRoute: OllamaModelHolder = {
  name: "alpha",
  provider: "ollama-local",
  model: "qwen2.5:1.5b",
  endpointUrl: "http://127.0.0.1:11434",
};

function releaseToNvidia(previous: OllamaModelHolder, deps: SetupInferenceDeps): void {
  releaseSupersededOllamaModel(
    previous,
    "nvidia-prod",
    "nvidia/test-model",
    "https://integrate.api.nvidia.com/v1",
    { ok: true },
    deps,
  );
}

describe("releaseSupersededOllamaModel", () => {
  it("unloads a superseded model when matching registry rows are not live", () => {
    const staleReservation = {
      name: "incomplete-reservation",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      endpointUrl: null,
      gatewayName: "stale-peer-gateway",
    } as unknown as SandboxEntry;
    const harness = createOllamaCleanupHarness({ peers: [staleReservation] });

    releaseToNvidia(previousLocalOllamaRoute, harness.deps);

    expect(harness.discoverActiveOllamaSandboxNames).toHaveBeenCalledOnce();
    expect(harness.unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["qwen2.5:1.5b"]);
    expect(harness.localInference.clearPersistedOllamaHostIfUnused).toHaveBeenCalledExactlyOnceWith(
      [],
    );
  });

  it("releases the target model before unrelated gateway discovery for receipt retirement", () => {
    const unrelatedPeer = {
      name: "unrelated-peer",
      provider: "ollama-local",
      model: "llama3.2:1b",
      endpointUrl: null,
      gatewayName: "unavailable-gateway",
    } as unknown as SandboxEntry;
    const discovery = vi.fn((owners: readonly OllamaModelHolder[]) =>
      owners.some((owner) => owner.model === "llama3.2:1b")
        ? { ok: false as const, message: "unrelated gateway unavailable" }
        : { ok: true as const, activeSandboxNames: new Set<string>(), gatewayChecks: [] },
    );
    const harness = createOllamaCleanupHarness({ peers: [unrelatedPeer], discovery });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);

      expect(discovery).toHaveBeenCalledTimes(2);
      expect(discovery.mock.calls[0]?.[0]).toEqual([]);
      expect(discovery.mock.calls[1]?.[0]).toEqual([unrelatedPeer]);
      expect(harness.unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["qwen2.5:1.5b"]);
      expect(harness.localInference.clearPendingOllamaModelCleanup).toHaveBeenCalledWith("alpha", [
        "qwen2.5:1.5b",
      ]);
      expect(harness.localInference.clearPersistedOllamaHostIfUnused).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("host route receipt was retained"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves the model and host receipt while a matching live peer owns it", () => {
    const activePeer = {
      name: "active-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      endpointUrl: null,
      gatewayName: "peer-gateway-port",
    } as unknown as SandboxEntry;
    const harness = createOllamaCleanupHarness({
      peers: [activePeer],
      activeSandboxNames: new Set([activePeer.name]),
    });

    releaseToNvidia(previousLocalOllamaRoute, harness.deps);

    expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.localInference.clearPersistedOllamaHostIfUnused).not.toHaveBeenCalled();
  });

  it("uses Ollama peer records from other gateway roots by default", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-peer-roots-"));
    vi.stubEnv("HOME", home);
    const gatewayRoot = path.join(home, ".nemoclaw", "gateways", "32665");
    fs.mkdirSync(gatewayRoot, { recursive: true });
    const peer: SandboxEntry = {
      name: "active-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      gatewayName: "nemoclaw-32665",
      gatewayPort: 32665,
      endpointUrl: "http://127.0.0.1:11434",
    };
    fs.writeFileSync(
      path.join(gatewayRoot, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: null,
        defaultSelectionRevision: 1,
        sandboxes: { "active-peer": peer },
      }),
    );
    const harness = createOllamaCleanupHarness({
      useProductionPeerSource: true,
      activeSandboxNames: new Set([peer.name]),
    });

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);

      expect(harness.discoverActiveOllamaSandboxNames).toHaveBeenCalledOnce();
      expect(harness.discoverActiveOllamaSandboxNames.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ name: "active-peer", gatewayName: "nemoclaw-32665" }),
      ]);
      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses suppressed OpenShell output in the default cross-gateway discovery path", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-default-discovery-"));
    vi.stubEnv("HOME", home);
    const gatewayRoot = path.join(home, ".nemoclaw", "gateways", "32665");
    fs.mkdirSync(gatewayRoot, { recursive: true });
    const peer: SandboxEntry = {
      name: "active-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      gatewayName: "nemoclaw-32665",
      gatewayPort: 32665,
      endpointUrl: "http://127.0.0.1:11434",
    };
    fs.writeFileSync(
      path.join(gatewayRoot, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: null,
        defaultSelectionRevision: 1,
        sandboxes: { "active-peer": peer },
      }),
    );
    const harness = createOllamaCleanupHarness({
      useProductionPeerSource: true,
      useProductionDiscovery: true,
    });
    const runOpenshell = vi.fn(() => ({
      status: 0,
      stdout: "NAME CREATED PHASE\nactive-peer 2026-08-25 Ready\n",
      stderr: "",
    }));
    const deps = harness.deps as SetupInferenceDeps;
    deps.runOpenshell = runOpenshell as unknown as SetupInferenceDeps["runOpenshell"];
    deps.resolveOllamaOwnershipGateway = (sandbox) => sandbox.gatewayName!;

    try {
      releaseToNvidia(previousLocalOllamaRoute, deps);

      expect(runOpenshell).toHaveBeenCalledExactlyOnceWith(
        ["sandbox", "list", "-g", "nemoclaw-32665"],
        expect.objectContaining({ suppressOutput: true }),
      );
      expect(harness.discoverActiveOllamaSandboxNames).not.toHaveBeenCalled();
      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed and records retry state when default discovery lacks a gateway resolver", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-missing-resolver-"));
    vi.stubEnv("HOME", home);
    const gatewayRoot = path.join(home, ".nemoclaw", "gateways", "32665");
    fs.mkdirSync(gatewayRoot, { recursive: true });
    const peer: SandboxEntry = {
      name: "stale-peer",
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      gatewayName: "nemoclaw-32665",
      gatewayPort: 32665,
      endpointUrl: "http://127.0.0.1:11434",
    };
    fs.writeFileSync(
      path.join(gatewayRoot, "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: null,
        defaultSelectionRevision: 1,
        sandboxes: { "stale-peer": peer },
      }),
    );
    const harness = createOllamaCleanupHarness({
      useProductionPeerSource: true,
      useProductionDiscovery: true,
    });
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    (harness.deps as SetupInferenceDeps).runOpenshell =
      runOpenshell as unknown as SetupInferenceDeps["runOpenshell"];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);

      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
      expect(harness.localInference.persistPendingOllamaModelCleanup).toHaveBeenCalledWith(
        "alpha",
        ["qwen2.5:1.5b"],
      );
      expect(runOpenshell).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("No model was unloaded"));
    } finally {
      warning.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("records a failed ownership probe for retry, then unloads only after a safe retry", () => {
    const discovery = vi
      .fn<NonNullable<SetupInferenceDeps["discoverActiveOllamaSandboxNames"]>>()
      .mockReturnValueOnce({ ok: false, message: "gateway unavailable" })
      .mockReturnValueOnce({ ok: true, activeSandboxNames: new Set(), gatewayChecks: [] });
    const harness = createOllamaCleanupHarness({ discovery });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      releaseToNvidia(previousLocalOllamaRoute, harness.deps);
      expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
      expect(harness.localInference.persistPendingOllamaModelCleanup).toHaveBeenCalledWith(
        "alpha",
        ["qwen2.5:1.5b"],
      );
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("No model was unloaded"));

      releaseToNvidia({ ...previousLocalOllamaRoute, provider: "nvidia-prod" }, harness.deps);

      expect(harness.unloadOllamaModels).toHaveBeenCalledExactlyOnceWith(["qwen2.5:1.5b"]);
      expect(harness.localInference.clearPendingOllamaModelCleanup).toHaveBeenCalledWith("alpha", [
        "qwen2.5:1.5b",
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  it("does not probe or warn when the selected route still owns the same Ollama model", () => {
    const harness = createOllamaCleanupHarness();

    releaseSupersededOllamaModel(
      previousLocalOllamaRoute,
      "ollama-local",
      "qwen2.5:1.5b",
      "http://127.0.0.1:11434",
      { ok: true },
      harness.deps,
    );

    expect(harness.discoverActiveOllamaSandboxNames).not.toHaveBeenCalled();
    expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.localInference.clearPersistedOllamaHostIfUnused).not.toHaveBeenCalled();
  });

  it("does not probe unrelated routes when there is no Ollama cleanup retry", () => {
    const harness = createOllamaCleanupHarness({
      peers: [{ name: "ollama-peer", provider: "ollama-local", model: "qwen2.5:1.5b" }],
    });

    releaseToNvidia(
      { name: "alpha", provider: "nvidia-prod", model: "nvidia/model" },
      harness.deps,
    );

    expect(harness.discoverActiveOllamaSandboxNames).not.toHaveBeenCalled();
    expect(harness.unloadOllamaModels).not.toHaveBeenCalled();
    expect(harness.localInference.clearPersistedOllamaHostIfUnused).not.toHaveBeenCalled();
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

describe("native NVIDIA onboarding", () => {
  it("reserves the logical route with an attached-provider receipt and no shared route mutation", async () => {
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
        "https://integrate.api.nvidia.com/v1",
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
    expect(updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
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

  it("reuses a gateway-owned provider for a fresh second sandbox", async () => {
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
      getNativeNvidiaProviderAuthority: () => ({
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "provider-id",
      }),
      upsertProvider: vi.fn(async () => ({ ok: true })),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(async () => undefined),
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
          reuseGatewayCredentialWithoutLocalKey: true,
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(createProvider).not.toHaveBeenCalled();
    expect(updateProvider).not.toHaveBeenCalled();
    expect(updateSandbox).toHaveBeenCalledWith(
      "second",
      expect.objectContaining({
        nativeNvidiaProviderAttachment: expect.objectContaining({ providerId: "provider-id" }),
      }),
    );
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
