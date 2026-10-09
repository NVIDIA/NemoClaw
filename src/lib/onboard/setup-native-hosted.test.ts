// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { HOSTED_NATIVE_PROVIDERS } from "../inference/native-provider/hosted";
import { createSetupInference, type SetupInferenceDeps } from "./setup-inference";

vi.mock("./sandbox-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-lifecycle")>()),
  releaseAbandonedRouteReservation: vi.fn(() => false),
}));

describe.each(HOSTED_NATIVE_PROVIDERS)("native $label onboarding", (provider) => {
  it("reserves the selected attachment without changing the shared route (#12589)", async () => {
    const receipt = {
      schemaVersion: 1,
      profileId: provider.profileId,
      providerName: provider.providerName,
      providerId: "identity",
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
    const updateSandbox = vi.fn(() => true);
    const writeAuthority = vi.fn();
    const setup = createSetupInference({
      checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true })),
      withSandboxMutationLock: async <T>(_name: string, fn: () => T | Promise<T>) => await fn(),
      withGatewayRouteMutationLock: async <T>(_name: string, fn: () => T | Promise<T>) =>
        await fn(),
      step: vi.fn(),
      getGatewayName: () => "gateway",
      runOpenshell,
      updateSandbox,
      getNativeHostedProviderAuthority: () => undefined,
      setNativeHostedProviderAuthority: writeAuthority,
      getSandbox: () => null,
      upsertProvider: vi.fn(),
      verifyInferenceRoute,
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
        provider.endpoint,
        provider.credentialEnv,
        null,
        [],
        { revalidateSandboxIdentity: () => undefined },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: provider.providerName,
        credentials: [{ name: provider.credentialEnv, value: "host-secret" }],
        type: provider.profileId,
      }),
    );
    expect(writeAuthority).toHaveBeenCalledWith("gateway", provider.logicalProvider, receipt);
    expect(updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeHostedProviderAttachment: receipt,
        provider: provider.logicalProvider,
      }),
    );
    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(JSON.stringify(updateSandbox.mock.calls)).not.toContain("host-secret");
  });
});
