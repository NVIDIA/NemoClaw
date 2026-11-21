// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { endpointlessProviderProfilePath } from "../../adapters/openshell/provider-profile";
import { credentialFamilyProfileType } from "../../messaging/applier/credential-family-profile";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { nativeNvidiaProviderProfilePath } from "../../inference/native-nvidia";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../../messaging/provider-profile";
import {
  publishAttachedProvidersBeforeDockerSandboxCreation,
  validateAttachedMessagingProvidersBeforeSandboxCreation,
  validateAttachedOwnedProfilesBeforeSandboxCreation,
} from "./provider-publication";
import { createProviderEffectBoundary, runSandboxCreateWithProviderEffects } from "./orchestration";

const providerName = "my-assistant-telegram-bridge";
const target = { kind: "named", gatewayName: "nemoclaw" } as const;
const exactMetadata = {
  name: providerName,
  type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  credentialKeys: ["TELEGRAM_BOT_TOKEN"],
  configKeys: [],
} as const;

function typedProviderAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  const adapter: OpenShellProviderAdapter = {
    ensureProviderPolicyComposition: vi
      .fn<OpenShellProviderAdapter["ensureProviderPolicyComposition"]>()
      .mockResolvedValue({ ok: true, value: undefined }),
    listProviders: vi.fn(async () => ({ ok: true as const, value: { names: [] } })),
    createProvider: vi.fn(async () => ({ ok: true as const })),
    getProvider: vi.fn(async (request) => ({
      ok: true as const,
      value: { ...exactMetadata, name: request.providerName },
    })),
    updateProvider: vi.fn(async () => ({ ok: true as const })),
    importProviderProfile: vi.fn(async () => ({ ok: true as const })),
    inspectProviderProfile: vi.fn(async () => ({
      ok: true as const,
      value: { credentialKeys: [] },
    })),
    deleteProvider: vi.fn(async () => ({ ok: true as const })),
    detachProvider: vi.fn(async () => ({ ok: true as const, value: { changed: true } })),
    attachProvider: vi.fn(async () => ({ ok: true as const })),
    listProviderAttachments: vi.fn(async () => ({ ok: true as const, value: { names: [] } })),
    configureProviderRefresh: vi.fn(async () => ({ ok: true as const })),
    getProviderRefreshStatus: vi.fn(async () => ({
      ok: true as const,
      value: { status: "refreshed" },
    })),
  };
  return { ...adapter, ...overrides };
}

function publicationInput(
  overrides: Partial<
    Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0]
  > = {},
): Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0] {
  return {
    openshellDriver: "docker",
    inferenceProvider: null,
    messagingProviders: [providerName],
    messagingProviderRequests: [
      {
        name: providerName,
        envKey: "TELEGRAM_BOT_TOKEN",
        providerType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        credentialConfigured: false,
        channel: "telegram",
      },
    ],
    extraProviders: [],
    gatewayName: "nemoclaw",
    ...overrides,
  };
}

function createHarness(adapter = typedProviderAdapter(), cleanupCreateSources = vi.fn()) {
  const runOpenshell = vi.fn(() => {
    throw new Error("Raw provider commands must stay behind OpenShellProviderAdapter.");
  });
  return {
    adapter,
    cleanupCreateSources,
    runOpenshell,
    deps: {
      cleanupCreateSources,
      providerAdapter: adapter,
      runOpenshell: runOpenshell as never,
    },
  };
}

async function prepareProviders(
  input: Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[0],
  deps: Parameters<typeof publishAttachedProvidersBeforeDockerSandboxCreation>[1],
): Promise<void> {
  await validateAttachedMessagingProvidersBeforeSandboxCreation(input, deps);
  await publishAttachedProvidersBeforeDockerSandboxCreation(input, deps);
}

const HERMES_PROFILE_TYPE = "nemoclaw-hermes-tool-gateway-v1";
const HERMES_CREDENTIAL_ENV = "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";
const hermesProviderName = "alpha-hermes-tool-gateway";

function hermesProvider(
  overrides: {
    type?: string;
    name?: string;
    credentialKeys?: string[];
    configKeys?: string[];
  } = {},
) {
  return vi.fn(async () => ({
    ok: true as const,
    value: {
      name: hermesProviderName,
      type: HERMES_PROFILE_TYPE,
      credentialKeys: [HERMES_CREDENTIAL_ENV],
      configKeys: [],
      ...overrides,
    },
  }));
}

function hermesBoundary(harness: ReturnType<typeof createHarness>) {
  return createProviderEffectBoundary({
    deferred: false,
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    preparationInput: publicationInput({
      messagingProviders: [],
      messagingProviderRequests: [],
      hermesToolGateway: { providerName: hermesProviderName },
    }),
    preparationDeps: harness.deps,
    runVerifiedSandboxCreateEffects: null,
    activateDeferredProviderEffects: null,
    revalidateSandboxIdentityBeforeCreate: vi.fn(),
  });
}

describe("sandbox provider preparation", () => {
  it.each([
    ["brave", true, expect.anything()],
    ["google-chat-bridge", true, expect.anything()],
    [
      "langfuse-hermes-v1",
      true,
      {
        target,
        profilePath: endpointlessProviderProfilePath(REPOSITORY_ROOT, "langfuse-hermes-v1"),
      },
    ],
    [
      "nemoclaw-nvidia-inference-v1",
      true,
      { target, profilePath: nativeNvidiaProviderProfilePath() },
    ],
    ["generic", false, undefined],
    ["operator-custom-v1", false, undefined],
  ] as const)(
    "checks an attached %s provider only when its profile is NemoClaw-owned",
    async (type, owned, profileImport) => {
      const warningCheck = vi.fn();
      const adapter = Object.assign(
        typedProviderAdapter({
          getProvider: vi.fn(async () => ({
            ok: true as const,
            value: {
              name: "search-provider",
              type,
              credentialKeys: ["SEARCH_TOKEN"],
              configKeys: [],
            },
          })),
        }),
        { warnIfVerifiedProfilesChangedAfterSandboxCreate: warningCheck },
      );
      const harness = createHarness(adapter);
      const boundary = createProviderEffectBoundary({
        deferred: false,
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        preparationInput: publicationInput({
          messagingProviders: [],
          messagingProviderRequests: [],
          extraProviders: ["search-provider"],
          directCreateProviderNames: ["search-provider"],
        }),
        preparationDeps: harness.deps,
        runVerifiedSandboxCreateEffects: null,
        activateDeferredProviderEffects: null,
        revalidateSandboxIdentityBeforeCreate: vi.fn(),
      });

      await boundary.validateBeforeCreate();
      await boundary.runAfterVerifiedCreate?.({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "none",
        revalidateSandboxIdentity: vi.fn(),
      });
      expect(vi.mocked(adapter.importProviderProfile).mock.calls).toEqual(
        owned ? [[profileImport]] : [],
      );
      expect(warningCheck).toHaveBeenCalledTimes(owned ? 1 : 0);
      expect(warningCheck.mock.calls[0] ?? null).toEqual(owned ? [{ target }, [type]] : null);
    },
  );

  it.each(
    [
      { type: "langfuse-hermes-v1", credentialKeys: ["TOKEN"] },
      { type: "nemoclaw-nvidia-inference-v1", credentialKeys: ["TOKEN"] },
      {
        type: credentialFamilyProfileType(
          MESSAGING_CREDENTIAL_PROVIDER_TYPE,
          "TELEGRAM_BOT_TOKEN",
          ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_WORKSPACE"],
        ),
        credentialKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_WORKSPACE"],
      },
    ].flatMap(({ type, credentialKeys }) =>
      (
        [
          ["profile_incompatible", "Resolve the conflicting same-ID profile"],
          ["not_found", "resolve the missing resource"],
          ["failed", "resolve the OpenShell command failure"],
        ] as const
      ).map(([reason, recovery]) => ({
        type,
        credentialKeys,
        reason,
        recovery,
      })),
    ),
  )(
    "blocks $type on $reason and verifies the profile on retry (#13345)",
    async ({ type, credentialKeys, reason, recovery }) => {
      const secret = "unrecognized-private-provider-value";
      const adapter = typedProviderAdapter({
        getProvider: vi.fn(async () => ({
          ok: true as const,
          value: { name: "extra-provider", type, credentialKeys, configKeys: [] },
        })),
        importProviderProfile: vi
          .fn<OpenShellProviderAdapter["importProviderProfile"]>()
          .mockResolvedValueOnce({
            ok: false,
            error: { kind: "command", reason, message: `command output: ${secret}` },
          })
          .mockResolvedValue({ ok: true }),
      });
      const harness = createHarness(adapter);
      const boundary = createProviderEffectBoundary({
        deferred: false,
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        preparationInput: publicationInput({
          messagingProviders: [],
          messagingProviderRequests: [],
          extraProviders: ["extra-provider"],
          directCreateProviderNames: ["extra-provider"],
        }),
        preparationDeps: harness.deps,
        runVerifiedSandboxCreateEffects: null,
        activateDeferredProviderEffects: null,
        revalidateSandboxIdentityBeforeCreate: vi.fn(),
      });

      const failure = await boundary.validateBeforeCreate().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        `Could not verify provider profile '${type}' before sandbox creation.`,
      );
      expect((failure as Error).message).toContain(`Profile verify failed (command/${reason}).`);
      expect((failure as Error).message).toContain(recovery);
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).cause).toBeUndefined();
      expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
      expect(adapter.createProvider).not.toHaveBeenCalled();
      expect(adapter.updateProvider).not.toHaveBeenCalled();
      expect(adapter.attachProvider).not.toHaveBeenCalled();
      expect(harness.runOpenshell).not.toHaveBeenCalled();

      await expect(boundary.validateBeforeCreate()).resolves.toBeUndefined();
      expect(adapter.importProviderProfile).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["validation", "read", "Restore the bundled provider profile"],
    ["validation", "inspect", "Check the selected gateway configuration"],
    ["authentication", "inspect", "Restore authentication"],
    ["schema", "verify", "supported OpenShell CLI and gateway versions"],
    ["timeout", "import", "Confirm the selected OpenShell gateway is available"],
  ] as const)("reports safe %s recovery during profile %s", async (kind, operation, recovery) => {
    const secret = "unrecognized-private-provider-value";
    const harness = createHarness(
      typedProviderAdapter({
        getProvider: vi.fn(async () => ({
          ok: true as const,
          value: {
            name: "extra-provider",
            type: "langfuse-hermes-v1",
            credentialKeys: [],
            configKeys: [],
          },
        })),
        importProviderProfile: vi.fn(async () => ({
          ok: false as const,
          error: { kind, message: secret },
          operation,
        })),
      }),
    );
    const failure = await validateAttachedOwnedProfilesBeforeSandboxCreation(
      publicationInput({
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: ["extra-provider"],
      }),
      harness.deps,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`Profile ${operation} failed (${kind}).`);
    expect((failure as Error).message).toContain(recovery);
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).cause).toBeUndefined();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("preserves profile recovery and cleanup failures without exposing adapter output", async () => {
    const secret = "unrecognized-private-provider-value";
    const cleanupFailure = new Error("Temporary sources could not be removed.");
    const harness = createHarness(
      typedProviderAdapter({
        getProvider: vi.fn(async () => ({
          ok: true as const,
          value: {
            name: "extra-provider",
            type: "nemoclaw-nvidia-inference-v1",
            credentialKeys: [],
            configKeys: [],
          },
        })),
        importProviderProfile: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: "transport" as const,
            reason: "connection_loss" as const,
            message: secret,
          },
          operation: "import" as const,
        })),
      }),
      vi.fn(() => {
        throw cleanupFailure;
      }),
    );
    const failure = await validateAttachedOwnedProfilesBeforeSandboxCreation(
      publicationInput({
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: ["extra-provider"],
      }),
      harness.deps,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(
      "Profile import failed (transport/connection_loss).",
    );
    expect((failure as AggregateError).message).toContain(
      "Check the OpenShell CLI and the selected gateway's identity and connectivity",
    );
    expect((failure as AggregateError).message).not.toContain(secret);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
      cleanupFailure,
    ]);
    expect((failure as AggregateError).errors[0].cause).toBeUndefined();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("stops direct create when an attached provider cannot be inspected", async () => {
    const adapter = typedProviderAdapter({
      getProvider: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "failed" as const,
          message: "provider inspection failed",
        },
      })),
    });
    const harness = createHarness(adapter);
    const boundary = createProviderEffectBoundary({
      deferred: false,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: publicationInput({
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: ["search-provider"],
        directCreateProviderNames: ["search-provider"],
      }),
      preparationDeps: harness.deps,
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: null,
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });

    await expect(boundary.validateBeforeCreate()).rejects.toThrow(
      "Could not inspect attached provider 'search-provider' before sandbox creation",
    );
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
    expect(adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it.each([HERMES_PROFILE_TYPE, "generic"])(
    "preserves the %s Hermes tool gateway binding on direct create",
    async (type) => {
      const warningCheck = vi.fn();
      const adapter = Object.assign(
        typedProviderAdapter({ getProvider: hermesProvider({ type }) }),
        { warnIfVerifiedProfilesChangedAfterSandboxCreate: warningCheck },
      );
      const harness = createHarness(adapter);
      const boundary = hermesBoundary(harness);

      await boundary.validateBeforeCreate();
      expect(adapter.importProviderProfile).toHaveBeenCalledTimes(type === "generic" ? 0 : 1);
      await boundary.runAfterVerifiedCreate?.({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "none",
        revalidateSandboxIdentity: vi.fn(),
      });
      expect(warningCheck).toHaveBeenCalledTimes(type === "generic" ? 0 : 1);
      expect(warningCheck.mock.calls[0] ?? null).toEqual(
        type === "generic" ? null : [{ target }, [type]],
      );
    },
  );

  it("blocks a changed Hermes tool gateway profile before sandbox creation", async () => {
    const adapter = typedProviderAdapter({
      getProvider: hermesProvider(),
      importProviderProfile: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "profile_incompatible" as const,
          message: "drift",
        },
      })),
    });
    const harness = createHarness(adapter);

    await expect(hermesBoundary(harness).validateBeforeCreate()).rejects.toThrow(
      "Could not verify Hermes tool gateway profile before sandbox creation",
    );
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
    expect(adapter.updateProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["unrelated provider type", { type: "unrelated" }],
    ["legacy provider name", { type: "generic", name: "other" }],
    [
      "legacy credential keys",
      { type: "generic", credentialKeys: [HERMES_CREDENTIAL_ENV, "OTHER_KEY"] },
    ],
    ["legacy config keys", { type: "generic", configKeys: ["OTHER_KEY"] }],
    ["owned credential key", { credentialKeys: ["OTHER_KEY"] }],
  ])("stops on %s before sandbox or provider mutation", async (_case, overrides) => {
    const adapter = typedProviderAdapter({ getProvider: hermesProvider(overrides) });
    const harness = createHarness(adapter);

    await expect(hermesBoundary(harness).validateBeforeCreate()).rejects.toThrow(
      "Hermes tool gateway provider binding changed before sandbox creation",
    );
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
    expect(adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(adapter.createProvider).not.toHaveBeenCalled();
    expect(adapter.updateProvider).not.toHaveBeenCalled();
  });

  it("checks one verified messaging profile after direct sandbox creation", async () => {
    const warningCheck = vi.fn();
    const adapter = Object.assign(typedProviderAdapter(), {
      warnIfVerifiedProfilesChangedAfterSandboxCreate: warningCheck,
    });
    const harness = createHarness(adapter);
    const boundary = createProviderEffectBoundary({
      deferred: false,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: publicationInput({ messagingProviders: [providerName, providerName] }),
      preparationDeps: harness.deps,
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: null,
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });

    await boundary.validateBeforeCreate();
    expect(warningCheck).not.toHaveBeenCalled();
    const result = await runSandboxCreateWithProviderEffects({
      resumingVerifiedCreate: false,
      providerEffectBoundary: boundary,
      create: async (afterVerifiedCreate) => {
        await afterVerifiedCreate?.({
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          lifecycleGeneration: "generation-1",
          lifecycleLiveIdentityFingerprint: "a".repeat(64),
          route: "none",
          revalidateSandboxIdentity: vi.fn(),
        });
        return "created";
      },
    });

    expect(result).toBe("created");
    expect(warningCheck).toHaveBeenCalledExactlyOnceWith({ target }, [
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    ]);
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("does not infer the original bind-time profile from a resumed create", async () => {
    const warningCheck = vi.fn();
    const adapter = Object.assign(typedProviderAdapter(), {
      warnIfVerifiedProfilesChangedAfterSandboxCreate: warningCheck,
    });
    const harness = createHarness(adapter);
    const boundary = createProviderEffectBoundary({
      deferred: false,
      resumingVerifiedCreate: true,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: publicationInput(),
      preparationDeps: harness.deps,
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: null,
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });

    await boundary.validateBeforeCreate();
    await boundary.runAfterVerifiedCreate?.({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      route: "none",
      revalidateSandboxIdentity: vi.fn(),
    });
    expect(adapter.importProviderProfile).toHaveBeenCalledOnce();
    expect(warningCheck).not.toHaveBeenCalled();
  });

  it("prepares and verifies a messaging provider through exact adapter calls (#9806)", async () => {
    const harness = createHarness();

    await prepareProviders(publicationInput(), harness.deps);

    expect(harness.adapter.importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    expect(harness.adapter.getProvider).toHaveBeenNthCalledWith(1, {
      target,
      providerName,
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName,
      credentials: [],
      config: [],
    });
    expect(harness.adapter.getProvider).toHaveBeenNthCalledWith(2, {
      target,
      providerName,
    });
    expect(harness.adapter.createProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("accepts canonical and namespaced messaging credentials through exact adapter calls (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async (request) => ({
      ok: true as const,
      value: {
        ...exactMetadata,
        name: request.providerName,
        type: credentialFamilyProfileType(
          MESSAGING_CREDENTIAL_PROVIDER_TYPE,
          "TELEGRAM_BOT_TOKEN",
          ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_WORKSPACE"],
        ),
        credentialKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_WORKSPACE"],
      },
    }));
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps);

    expect(harness.adapter.importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName,
    });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("rejects an ambient endpoint before a named messaging profile operation (#9806)", async () => {
    const cleanupCreateSources = vi.fn();
    const runOpenshell = vi.fn();

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), {
        cleanupCreateSources,
        environment: { OPENSHELL_GATEWAY_ENDPOINT: "https://untrusted.example.test" },
        runOpenshell: runOpenshell as never,
      }),
    ).rejects.toThrowError(
      "OPENSHELL_GATEWAY_ENDPOINT is set, so OpenShell may bypass the gateway recorded for this sandbox.",
    );

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("surfaces a safe profile preparation failure before provider lookup (#9806)", async () => {
    const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = vi.fn(
      async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "failed" as const,
          message: "profile import rejected request 17",
        },
      }),
    );
    const harness = createHarness(typedProviderAdapter({ importProviderProfile }));

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
    ).rejects.toThrowError(
      "Could not prepare the OpenShell messaging credential profile: profile import rejected request 17",
    );
    expect(harness.adapter.importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    expect(harness.adapter.getProvider).not.toHaveBeenCalled();
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it.each([
    ["provider type", { ...exactMetadata, type: "generic" }],
    ["credential key", { ...exactMetadata, credentialKeys: ["WRONG_TOKEN"] }],
    [
      "credential family",
      {
        ...exactMetadata,
        credentialKeys: ["TELEGRAM_BOT_TOKEN", "UNRELATED_TOKEN"],
      },
    ],
    ["configuration", { ...exactMetadata, configKeys: ["UNEXPECTED_CONFIG"] }],
  ])(
    "rejects a messaging binding with the wrong %s before publication (#9875)",
    async (_case, value) => {
      const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
        ok: true as const,
        value,
      }));
      const harness = createHarness(typedProviderAdapter({ getProvider }));

      await expect(
        validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
      ).rejects.toThrowError(
        `OpenShell did not confirm messaging provider '${providerName}' before sandbox creation.`,
      );
      expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
        target,
        providerName,
      });
      expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
      expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
    },
  );

  it("keeps identity mismatch distinct during messaging provider inspection (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "transport" as const,
        reason: "identity_mismatch" as const,
        message: "The selected OpenShell gateway identity does not match the recorded identity.",
      },
    }));
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await expect(
      validateAttachedMessagingProvidersBeforeSandboxCreation(publicationInput(), harness.deps),
    ).rejects.toThrowError(
      `Could not inspect messaging provider '${providerName}' before sandbox creation: The selected OpenShell gateway identity does not match the recorded identity.`,
    );
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({ target, providerName });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("publishes an existing inference provider through exact adapter calls (#9806)", async () => {
    const harness = createHarness();

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      harness.deps,
    );

    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
      credentials: [],
      config: [],
    });
    expect(harness.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("does not republish a transaction-bound inference provider (#11336)", async () => {
    const harness = createHarness();

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "ollama-local",
        transactionBoundInferenceProvider: "ollama-local",
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: ["ollama-local"],
      }),
      harness.deps,
    );

    expect(harness.adapter.getProvider).not.toHaveBeenCalled();
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("skips optional publication only when exact lookup reports absence (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "not_found" as const,
        message: "OpenShell provider 'inference' was not found.",
      },
    }));
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      harness.deps,
    );

    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).not.toHaveBeenCalled();
  });

  it("surfaces a safe optional lookup failure without updating (#9806)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "transport" as const,
        reason: "unreachable" as const,
        message: "OpenShell could not reach gateway 'nemoclaw'.",
      },
    }));
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(
        publicationInput({
          inferenceProvider: "inference",
          messagingProviders: [],
          messagingProviderRequests: [],
        }),
        harness.deps,
      ),
    ).rejects.toThrowError(
      "Could not inspect attached provider 'inference' before publication: OpenShell could not reach gateway 'nemoclaw'.",
    );
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("surfaces a safe update failure after the exact lookup (#9806)", async () => {
    const updateProvider: OpenShellProviderAdapter["updateProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
        message: "provider update rejected request 23",
      },
    }));
    const harness = createHarness(typedProviderAdapter({ updateProvider }));

    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(
        publicationInput({
          inferenceProvider: "inference",
          messagingProviders: [],
          messagingProviderRequests: [],
        }),
        harness.deps,
      ),
    ).rejects.toThrowError(
      "Could not publish attached provider 'inference' before managed sandbox creation: provider update rejected request 23",
    );
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
      credentials: [],
      config: [],
    });
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("reports provider and temporary-source cleanup failures together (#9806)", async () => {
    const updateProvider: OpenShellProviderAdapter["updateProvider"] = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
        message: "provider update rejected request 25",
      },
    }));
    const cleanupFailure = new AggregateError(
      [new Error("The temporary sandbox build context could not be removed.")],
      "Temporary sandbox create sources remain.",
    );
    const cleanupCreateSources = vi.fn(() => {
      throw cleanupFailure;
    });
    const harness = createHarness(typedProviderAdapter({ updateProvider }), cleanupCreateSources);

    const failure = await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        inferenceProvider: "inference",
        messagingProviders: [],
        messagingProviderRequests: [],
      }),
      harness.deps,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message:
        "Could not publish attached provider 'inference' before managed sandbox creation: provider update rejected request 25 Temporary sandbox create-source cleanup also failed.",
    });
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message:
          "Could not publish attached provider 'inference' before managed sandbox creation: provider update rejected request 25",
      }),
      cleanupFailure,
    ]);
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "inference",
      credentials: [],
      config: [],
    });
    expect(cleanupCreateSources).toHaveBeenCalledOnce();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("reruns publication from desired state after a partial failure (#9806)", async () => {
    let updateAttempt = 0;
    const updateProvider: OpenShellProviderAdapter["updateProvider"] = vi.fn(async () =>
      (updateAttempt += 1) === 2
        ? {
            ok: false as const,
            error: {
              kind: "command" as const,
              reason: "failed" as const,
              message: "provider update rejected request 24",
            },
          }
        : { ok: true as const },
    );
    const harness = createHarness(typedProviderAdapter({ updateProvider }));
    const input = publicationInput({
      messagingProviders: [],
      messagingProviderRequests: [],
      extraProviders: ["first-provider", "second-provider"],
    });

    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(input, harness.deps),
    ).rejects.toThrowError(/provider update rejected request 24/u);
    expect(harness.adapter.updateProvider).toHaveBeenCalledTimes(2);
    expect(harness.adapter.updateProvider).toHaveBeenCalledWith({
      target,
      providerName: "first-provider",
      credentials: [],
      config: [],
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledWith({
      target,
      providerName: "second-provider",
      credentials: [],
      config: [],
    });

    vi.mocked(harness.adapter.updateProvider).mockClear();
    await expect(
      publishAttachedProvidersBeforeDockerSandboxCreation(input, harness.deps),
    ).resolves.toBeUndefined();

    expect(harness.adapter.updateProvider).toHaveBeenCalledTimes(2);
    expect(harness.adapter.updateProvider).toHaveBeenCalledWith({
      target,
      providerName: "first-provider",
      credentials: [],
      config: [],
    });
    expect(harness.adapter.updateProvider).toHaveBeenCalledWith({
      target,
      providerName: "second-provider",
      credentials: [],
      config: [],
    });
    expect(harness.adapter.getProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("rejects a messaging binding that changes during publication (#9875)", async () => {
    const getProvider: OpenShellProviderAdapter["getProvider"] = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: exactMetadata })
      .mockResolvedValueOnce({
        ok: true as const,
        value: { ...exactMetadata, type: "generic" },
      });
    const harness = createHarness(typedProviderAdapter({ getProvider }));

    await expect(prepareProviders(publicationInput(), harness.deps)).rejects.toThrowError(
      `OpenShell did not confirm messaging provider '${providerName}' after publication.`,
    );
    expect(harness.adapter.getProvider).toHaveBeenNthCalledWith(1, { target, providerName });
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName,
      credentials: [],
      config: [],
    });
    expect(harness.adapter.getProvider).toHaveBeenNthCalledWith(2, { target, providerName });
    expect(harness.cleanupCreateSources).toHaveBeenCalledOnce();
  });

  it("publishes a provider outside the messaging credential profile without a lookup (#9875)", async () => {
    const harness = createHarness();

    await publishAttachedProvidersBeforeDockerSandboxCreation(
      publicationInput({
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: ["operator-provider"],
      }),
      harness.deps,
    );

    expect(harness.adapter.getProvider).not.toHaveBeenCalled();
    expect(harness.adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: "operator-provider",
      credentials: [],
      config: [],
    });
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });

  it("validates the messaging profile before portable Hermes provider adoption (#9875)", async () => {
    const harness = createHarness();

    await validateAttachedMessagingProvidersBeforeSandboxCreation(
      publicationInput({ openshellDriver: "native" }),
      harness.deps,
    );

    expect(harness.adapter.importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
    });
    expect(harness.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({ target, providerName });
    expect(harness.adapter.updateProvider).not.toHaveBeenCalled();
    expect(harness.runOpenshell).not.toHaveBeenCalled();
  });
});
