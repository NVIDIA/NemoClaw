// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { customNativeProvider } from "../inference/native-provider/custom";
import {
  HOSTED_NATIVE_PROVIDERS,
  hostedNativeProvider,
  type HostedProviderDefinition,
} from "../inference/native-provider/hosted";
import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";

vi.mock("./sandbox-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-lifecycle")>()),
  releaseAbandonedRouteReservation: vi.fn(() => false),
}));

const providers: HostedProviderDefinition[] = [
  ...HOSTED_NATIVE_PROVIDERS,
  ...[
    { endpoint: "https://8.8.8.8/team/v1", allowedIps: ["8.8.8.8"] },
    { endpoint: "http://8.8.8.8/team/v1", allowedIps: ["8.8.8.8"] },
    { endpoint: "http://host.openshell.internal:42103/team/v1", allowedIps: undefined },
  ].map(({ endpoint, allowedIps }) => ({
    ...hostedNativeProvider("hermes-provider", endpoint)!,
    allowedIps,
  })),
  ...[
    ["compatible-endpoint", "openai-completions", "https://custom.example/v1"],
    ["compatible-endpoint", "openai-responses", "https://custom.example/v1"],
    ["compatible-anthropic-endpoint", "anthropic-messages", "https://custom.example"],
    ["compatible-anthropic-endpoint", "openai-completions", "https://custom.example"],
    ["compatible-anthropic-endpoint", "openai-responses", "https://custom.example"],
  ].map(([provider, api, endpointUrl]) =>
    customNativeProvider({
      provider,
      api,
      endpointUrl,
      credentialEnv: "HOST_KEY",
      allowedIps: ["8.8.8.8"],
    }),
  ),
];

describe.each(providers)("native $label onboarding", (provider) => {
  const endpointModes = provider.custom
    ? [
        "explicit",
        "previous-provider",
        ...(provider.api ===
        (provider.logicalProvider === "compatible-anthropic-endpoint"
          ? "anthropic-messages"
          : "openai-completions")
          ? ["default-api"]
          : []),
      ]
    : provider.endpointUrl
      ? ["explicit"]
      : ["explicit", "omitted"];
  it.each(endpointModes)("uses %s native endpoint (#12589)", async (endpointMode) => {
    const receipt = {
      schemaVersion: 1,
      profileId: provider.profileId,
      providerName: provider.providerName,
      providerId: "identity",
      ...(provider.endpointUrl ? { endpointUrl: provider.endpointUrl } : {}),
      ...(provider.allowedIps ? { allowedIps: provider.allowedIps } : {}),
      ...(provider.custom ? { custom: provider.custom } : {}),
    } as const;
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "absent" },
      })
      .mockResolvedValue({
        ok: true,
        value: {
          name: provider.providerName,
          type: provider.profileId,
          credentialKeys: [provider.credentialEnv],
          configKeys: [],
          revision: { id: "identity", resourceVersion: 1 },
        },
      });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
      ok: true,
    }));
    const providerAdapter = {
      getProvider,
      createProvider,
      importProviderProfile: vi.fn(async () => ({ ok: true })),
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
    } as unknown as OpenShellProviderAdapter;
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const verifyInferenceRoute = vi.fn();
    const verifyOnboardInferenceSmoke = vi.fn(async () => undefined);
    const updateSandbox = vi.fn(() => true);
    const writeAuthority = vi.fn();
    const recordMigratedProviderCredential = vi.fn();
    const setup = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true })),
      withSandboxMutationLock: async <T>(_name: string, fn: () => T | Promise<T>) => await fn(),
      withGatewayRouteMutationLock: async <T>(_name: string, fn: () => T | Promise<T>) =>
        await fn(),
      step: vi.fn(),
      getGatewayName: () => "gateway",
      runOpenshell,
      updateSandbox,
      localInference: { loadPendingOllamaModelCleanup: () => [] },
      withOllamaModelOwnershipLock: (operation: () => unknown) => operation(),
      getNativeHostedProviderAuthority: () => undefined,
      setNativeHostedProviderAuthority: writeAuthority,
      getSandbox: () =>
        endpointMode === "previous-provider"
          ? {
              name: "alpha",
              provider: "openai-api",
              pendingRouteReservation: true,
              nativeHostedProviderAttachment: {
                schemaVersion: 1,
                profileId: HOSTED_NATIVE_PROVIDERS[0].profileId,
                providerName: HOSTED_NATIVE_PROVIDERS[0].providerName,
                providerId: "previous-provider-id",
              },
            }
          : null,
      resolveEndpointHost: async () => [{ address: "8.8.8.8", family: 4 }],
      upsertProvider: vi.fn(),
      recordMigratedProviderCredential,
      verifyInferenceRoute,
      verifyOnboardInferenceSmoke,
      isNonInteractive: () => true,
      hermesProviderAuth: {
        HERMES_PROVIDER_NAME: "hermes-provider",
        isHermesProviderRegistered: async () => false,
        ensureHermesProviderApiKeyCredentials: async (
          _name: string,
          options: {
            registerInferenceCredential: (input: {
              apiKey: string;
              credentialEnv: string;
              baseUrl: string;
            }) => Promise<unknown>;
          },
        ) => {
          await options.registerInferenceCredential({
            apiKey: "host-secret",
            credentialEnv: "NOUS_API_KEY",
            baseUrl: provider.endpoint,
          });
          return {
            auth_method: "api_key",
            credential_env: "OPENAI_API_KEY",
            inference_base_url: provider.endpoint,
          };
        },
      },
      normalizeHermesAuthMethod: () => "api_key",
      checkHermesProviderStoreReachable: () => ({ ok: true }),
      resolveHermesNousApiKey: () => "host-secret",
      hermesConstants: {
        HERMES_NOUS_API_KEY_CREDENTIAL_ENV: "NOUS_API_KEY",
        HERMES_AUTH_METHOD_API_KEY: "api_key",
        HERMES_AUTH_METHOD_OAUTH: "oauth",
      },
      requireValue: (value: unknown) => value,

      providerAdapter,
      hydrateCredentialEnv: () => "host-secret",
      redact: (s: string) => s,
      compactText: (s: string) => s,
      log: vi.fn(),
      error: vi.fn(),
      exitProcess: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    } as unknown as SetupInferenceDeps);
    await expect(
      setup(
        "alpha",
        "supported-model",
        provider.logicalProvider,
        endpointMode !== "omitted" ? (provider.custom?.endpointUrl ?? provider.endpoint) : null,
        provider.custom?.credentialEnv ?? provider.credentialEnv,
        null,
        [],
        {
          revalidateSandboxIdentity: () => undefined,
          preferredInferenceApi: endpointMode === "default-api" ? null : provider.api,
        },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: provider.providerName,
        credentials: [{ name: provider.credentialEnv, value: "host-secret" }],
        type: provider.profileId,
      }),
    );
    expect(recordMigratedProviderCredential.mock.calls).toEqual(
      provider.custom
        ? [
            [
              provider.logicalProvider,
              provider.custom.credentialEnv,
              "host-secret",
              expect.any(Function),
            ],
          ]
        : [],
    );
    expect(writeAuthority).toHaveBeenCalledWith("gateway", provider.logicalProvider, receipt);
    expect(updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeHostedProviderAttachment: receipt,
        provider: provider.logicalProvider,
        preferredInferenceApi: provider.api,
      }),
    );
    expect(verifyOnboardInferenceSmoke.mock.calls).toEqual(
      provider.logicalProvider === "hermes-provider" || provider.custom
        ? []
        : [
            [
              expect.objectContaining({
                provider: provider.logicalProvider,
                endpointUrl: provider.endpoint,
              }),
            ],
          ],
    );
    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(JSON.stringify(updateSandbox.mock.calls)).not.toContain("host-secret");
  });
});

describe.each(providers)("native $label onboarding with a stale registry record", (provider) => {
  it("points the missing provider at destroy without creating one", async () => {
    const receipt = {
      schemaVersion: 1,
      profileId: provider.profileId,
      providerName: provider.providerName,
      providerId: "identity",
      ...(provider.endpointUrl ? { endpointUrl: provider.endpointUrl } : {}),
      ...(provider.allowedIps ? { allowedIps: provider.allowedIps } : {}),
      ...(provider.custom ? { custom: provider.custom } : {}),
    };
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const log = vi.fn();
    const error = vi.fn();
    const setup = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true })),
      withSandboxMutationLock: async <T>(_name: string, fn: () => T | Promise<T>) => await fn(),
      withGatewayRouteMutationLock: async <T>(_name: string, fn: () => T | Promise<T>) =>
        await fn(),
      step: vi.fn(),
      getGatewayName: () => "gateway",
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      updateSandbox: vi.fn(() => true),
      localInference: { loadPendingOllamaModelCleanup: () => [] },
      withOllamaModelOwnershipLock: (operation: () => unknown) => operation(),
      getNativeHostedProviderAuthority: () => undefined,
      setNativeHostedProviderAuthority: vi.fn(),
      getSandbox: () => ({
        name: "alpha",
        provider: provider.logicalProvider,
        nativeHostedProviderAttachment: receipt,
      }),
      resolveEndpointHost: async () => [{ address: "8.8.8.8", family: 4 }],
      upsertProvider: vi.fn(),
      verifyInferenceRoute: vi.fn(),
      verifyOnboardInferenceSmoke: vi.fn(async () => undefined),
      isNonInteractive: () => true,
      hermesProviderAuth: {
        HERMES_PROVIDER_NAME: "hermes-provider",
        isHermesProviderRegistered: async () => false,
        ensureHermesProviderApiKeyCredentials: async (
          _name: string,
          options: {
            registerInferenceCredential: (input: {
              apiKey: string;
              credentialEnv: string;
              baseUrl: string;
            }) => Promise<unknown>;
          },
        ) => {
          await options.registerInferenceCredential({
            apiKey: "host-secret",
            credentialEnv: "NOUS_API_KEY",
            baseUrl: provider.endpoint,
          });
          return {
            auth_method: "api_key",
            credential_env: "OPENAI_API_KEY",
            inference_base_url: provider.endpoint,
          };
        },
      },
      normalizeHermesAuthMethod: () => "api_key",
      checkHermesProviderStoreReachable: () => ({ ok: true }),
      resolveHermesNousApiKey: () => "host-secret",
      hermesConstants: {
        HERMES_NOUS_API_KEY_CREDENTIAL_ENV: "NOUS_API_KEY",
        HERMES_AUTH_METHOD_API_KEY: "api_key",
        HERMES_AUTH_METHOD_OAUTH: "oauth",
      },
      requireValue: (value: unknown) => value,
      providerAdapter: {
        getProvider: vi.fn(async () => ({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "absent" },
        })),
        createProvider,
        importProviderProfile: vi.fn(async () => ({ ok: true })),
        ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
      } as unknown as OpenShellProviderAdapter,
      hydrateCredentialEnv: () => "host-secret",
      redact: (s: string) => s,
      compactText: (s: string) => s,
      log,
      error,
      exitProcess: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    } as unknown as SetupInferenceDeps);
    const failure = await setup(
      "alpha",
      "supported-model",
      provider.logicalProvider,
      provider.custom?.endpointUrl ?? provider.endpoint,
      provider.custom?.credentialEnv ?? provider.credentialEnv,
      null,
      [],
      { revalidateSandboxIdentity: () => undefined, preferredInferenceApi: provider.api },
    ).catch((caught: unknown) => caught);
    // Hermes setup prints the provider error and exits; the other paths throw it.
    const surfaced = [failure, ...log.mock.calls.flat(), ...error.mock.calls.flat()]
      .map(String)
      .join("\n");
    expect(failure).toBeInstanceOf(Error);
    expect(surfaced).toMatch(
      /only the NemoClaw registry record for sandbox 'alpha'.*'nemoclaw alpha destroy'/su,
    );
    expect(createProvider).not.toHaveBeenCalled();
  });
});
