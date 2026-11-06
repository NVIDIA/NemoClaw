// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeModelRouterEndpoint } from "../inference/native-local/model-router";
import { normalizeNativeLocalProviderAttachment } from "../inference/native-local/contract";
import { isProtectedLocalInferencePort } from "../inference/gateway/local-endpoint-ports";
import { prepareNativeModelRouterSelection } from "./routed-inference";
import { loadSession } from "../state/onboard-session";
import { doesModelRouterProcessOwnPort } from "./model-router-process";
import { ensureNativeLocalProvider } from "../inference/native-local/profile";
import { hashCredential } from "../security/credential-hash";
import type { BlueprintInferenceProfile } from "../core/model-router-port";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";

vi.mock("../state/onboard-session", () => ({ loadSession: vi.fn() }));
vi.mock("./model-router-process", () => ({ doesModelRouterProcessOwnPort: vi.fn() }));
vi.mock("../inference/native-local/profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../inference/native-local/profile")>()),
  ensureNativeLocalProvider: vi.fn(),
}));

const profile: BlueprintInferenceProfile = {
  provider_name: "custom-router",
  endpoint: "http://localhost:4000/v1",
  model: "routed",
  router: { enabled: true, port: 4000 },
};
const input = {
  adapter: {} as OpenShellProviderAdapter,
  binding: {
    provider: "nvidia-router",
    agent: "openclaw" as const,
    endpointUrl: "http://host.openshell.internal:4000/v1",
    authMode: "authenticated" as const,
    gatewayName: "nemoclaw",
    sandboxName: "alice",
  },
  credentialValue: "test-router-key",
  readAuthority: vi.fn(),
  writeAuthority: vi.fn(),
};

beforeEach(() => {
  vi.mocked(loadSession).mockReturnValue({
    routerPort: 4000,
    routerPid: 123,
    routerCredentialHash: hashCredential(input.credentialValue),
  } as ReturnType<typeof loadSession>);
  vi.mocked(doesModelRouterProcessOwnPort).mockReturnValue(true);
  vi.mocked(ensureNativeLocalProvider).mockImplementation(
    async (request) => ({ ...request.binding, providerId: "owned" }) as never,
  );
});

describe("native Model Router ownership", () => {
  it("checks Router ownership while preserving the credential before sandbox backup", async () => {
    await prepareNativeModelRouterSelection({ ...input, preserveProviderCredential: true });
    expect(doesModelRouterProcessOwnPort).toHaveBeenCalledTimes(2);
    expect(ensureNativeLocalProvider).toHaveBeenCalledWith(
      expect.objectContaining({ credentialValue: null }),
    );
  });

  it("rejects a changed Router credential even when provider mutation is deferred", async () => {
    await expect(
      prepareNativeModelRouterSelection({
        ...input,
        credentialValue: "changed-key",
        preserveProviderCredential: true,
      }),
    ).rejects.toThrow();
    expect(ensureNativeLocalProvider).not.toHaveBeenCalled();
  });

  it("preserves the configured provider name and endpoint without admitting another host or service", () => {
    expect(nativeModelRouterEndpoint("custom-router", "http://127.0.0.1:4000/v1", profile)).toBe(
      "http://host.openshell.internal:4000/v1",
    );
  });

  it.each([
    ["other-router", "http://localhost:4000/v1"],
    ["custom-router", "http://localhost:8080/v1"],
    ["custom-router", "http://10.0.0.1:4000/v1"],
    ["custom-router", "http://host.openshell.internal:4000/admin"],
    ["custom-router", "http://user:pass@localhost:4000/v1"],
    ["custom-router", "http://localhost:4000/v1?token=x"],
  ])("rejects router %s at unowned endpoint %s", (provider, endpoint) => {
    expect(nativeModelRouterEndpoint(provider, endpoint, profile)).toBeNull();
  });

  it("requires the recorded live process and credential before registering the provider", async () => {
    await prepareNativeModelRouterSelection(input);
    expect(ensureNativeLocalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialValue: "test-router-key",
        binding: expect.objectContaining({
          provider: "nvidia-router",
          credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        }),
      }),
    );
    expect(doesModelRouterProcessOwnPort).toHaveBeenCalledWith(123, 4000);
  });

  it("rejects a forged or stale router identity before touching provider state", async () => {
    vi.mocked(doesModelRouterProcessOwnPort).mockReturnValue(false);
    await expect(prepareNativeModelRouterSelection(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(ensureNativeLocalProvider).not.toHaveBeenCalled();
    vi.mocked(doesModelRouterProcessOwnPort).mockReturnValue(true);
    vi.mocked(loadSession).mockReturnValue({
      routerPort: 4000,
      routerPid: 123,
      routerCredentialHash: "other",
    } as never);
    await expect(prepareNativeModelRouterSelection(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(ensureNativeLocalProvider).not.toHaveBeenCalled();
  });

  it("retains provider recovery authority when the router changes during registration", async () => {
    vi.mocked(doesModelRouterProcessOwnPort).mockReturnValueOnce(true).mockReturnValue(false);
    await expect(prepareNativeModelRouterSelection(input)).rejects.toThrow(
      "ownership could not be verified",
    );
    expect(ensureNativeLocalProvider).toHaveBeenCalledOnce();
  });

  it("keeps router ports reserved for ordinary endpoints and never exempts control ports", () => {
    expect(isProtectedLocalInferencePort(4000)).toBe(true);
    expect(
      normalizeNativeLocalProviderAttachment({
        ...input.binding,
        routeKind: "model-router",
        endpointUrl: "http://host.openshell.internal:8080/v1",
      }),
    ).toBeUndefined();
  });
  it.each([8080, 8990, 18789, 8642, 11435, 11436, 11437, 11438])(
    "rejects protected port %i for Model Router",
    (port) => {
      expect(isProtectedLocalInferencePort(port, { ownedModelRouterPort: port })).toBe(true);
    },
  );
});

describe("Model Router native setup", () => {
  it.each(["openclaw", "hermes", "langchain-deepagents-code", "pi"])(
    "publishes %s provider ownership inside both lifecycle locks",
    async (agentName) => {
      const { createSetupInference } = await import("./setup-inference");
      const { upsertRoutedProvider } = await import("./routed-inference");
      let gatewayLocked = false;
      let routerLocked = false;
      const updateSandbox = vi.fn(() => {
        expect(gatewayLocked && routerLocked).toBe(true);
        return true;
      });
      const retiredCommand = vi.fn(() => {
        throw new Error("retired shared route command");
      });
      const setup = createSetupInference({
        getGatewayName: () => "nemoclaw",
        withSandboxMutationLock: async (_name: string, action: () => Promise<unknown>) =>
          await action(),
        withGatewayRouteMutationLock: async (_name: string, action: () => Promise<unknown>) => {
          gatewayLocked = true;
          try {
            return await action();
          } finally {
            gatewayLocked = false;
          }
        },
        withModelRouterPortLifecycleLock: async (_port: number, action: () => Promise<unknown>) => {
          expect(gatewayLocked).toBe(true);
          routerLocked = true;
          try {
            return await action();
          } finally {
            routerLocked = false;
          }
        },
        getModelRouterPort: () => 4000,
        isRoutedInferenceProvider: () => true,
        requireNativeProviderPolicy: async () => {},
        checkGatewayRouteCompatibility: () => ({ ok: true }),
        getSandbox: () => null,
        updateSandbox,
        providerAdapter: input.adapter,
        getNativeLocalProviderAuthority: () => undefined,
        setNativeLocalProviderAuthority: vi.fn(),
        reconcileModelRouter: async () => {
          expect(gatewayLocked && routerLocked).toBe(true);
        },
        routedInference: { upsertRoutedProvider },
        hydrateCredentialEnv: () => input.credentialValue,
        runOpenshell: retiredCommand,
        inferenceRouteObserver: { observeInferenceRoute: retiredCommand },
        inferenceRouteMutator: { setInferenceRoute: retiredCommand },
        verifyInferenceRoute: retiredCommand,
        verifyOnboardInferenceSmoke: async () => {},
        isNonInteractive: () => true,
        hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
        localInference: { loadPendingOllamaModelCleanup: () => [] },
        withOllamaModelOwnershipLock: (action: () => unknown) => action(),
        step: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
        redact: (s: string) => s,
        compactText: (s: string) => s,
        exitProcess: (code: number) => {
          throw new Error(`exit ${code}`);
        },
      } as unknown as import("./setup-inference").SetupInferenceDeps);
      await expect(
        setup(
          "alice",
          "nvidia-routed",
          "nvidia-router",
          "http://localhost:4000/v1",
          "NVIDIA_INFERENCE_API_KEY",
          null,
          [],
          { agentName, revalidateSandboxIdentity: () => {} },
        ),
      ).resolves.toMatchObject({ ok: true });
      expect(updateSandbox).toHaveBeenCalledWith(
        "alice",
        expect.objectContaining({
          provider: "nvidia-router",
          nativeLocalProviderAttachment: expect.objectContaining({ providerId: "owned" }),
        }),
      );
      expect(JSON.stringify(updateSandbox.mock.calls)).not.toContain(input.credentialValue);
      expect(retiredCommand).not.toHaveBeenCalled();
    },
  );
});
