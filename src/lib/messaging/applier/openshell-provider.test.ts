// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { namedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import type { SandboxMessagingPlan } from "../manifest";
import {
  applyCredentialsAtOpenShell,
  cleanupProvidersAtOpenShell,
  isMessagingProviderBindingConflict,
  isMessagingProviderMutationFailure,
  type MessagingProviderApplyError,
} from "./openshell-provider";
import type {
  MessagingCredentialProviderEphemeralInput,
  MessagingProviderRefreshEphemeralInput,
} from "./types";

const target = namedOpenShellGateway("nemoclaw");
const plan: SandboxMessagingPlan = {
  schemaVersion: 1,
  sandboxName: "alpha",
  agent: "openclaw",
  workflow: "onboard",
  channels: [],
  disabledChannels: [],
  credentialBindings: [],
  networkPolicy: { presets: [], entries: [] },
  agentRender: [],
  buildSteps: [],
  stateUpdates: [],
  healthChecks: [],
};

function definition(
  overrides: Partial<MessagingCredentialProviderEphemeralInput> = {},
): MessagingCredentialProviderEphemeralInput {
  return {
    channelId: "telegram",
    credentialId: "TELEGRAM_BOT_TOKEN",
    providerName: "alpha-telegram-bridge",
    providerType: "nemoclaw-mcp-v1",
    credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: "telegram-secret" }],
    profile: { profilePath: "/repo/messaging.yaml", profileType: "nemoclaw-mcp-v1" },
    ...overrides,
  };
}

function metadata(input: MessagingCredentialProviderEphemeralInput) {
  return {
    name: input.providerName,
    type: input.providerType,
    credentialKeys: input.credentials.map(({ name }) => name),
    configKeys: [],
  };
}

function providerAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  return {
    listProviders: vi
      .fn<OpenShellProviderAdapter["listProviders"]>()
      .mockResolvedValue({ ok: true, value: { names: [] } }),
    createProvider: vi
      .fn<OpenShellProviderAdapter["createProvider"]>()
      .mockResolvedValue({ ok: true }),
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "provider not found" },
    }),
    updateProvider: vi
      .fn<OpenShellProviderAdapter["updateProvider"]>()
      .mockResolvedValue({ ok: true }),
    importProviderProfile: vi
      .fn<OpenShellProviderAdapter["importProviderProfile"]>()
      .mockResolvedValue({ ok: true }),
    inspectProviderProfile: vi
      .fn<OpenShellProviderAdapter["inspectProviderProfile"]>()
      .mockResolvedValue({ ok: true, value: { credentialKeys: [] } }),
    deleteProvider: vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValue({ ok: true }),
    detachProvider: vi
      .fn<OpenShellProviderAdapter["detachProvider"]>()
      .mockResolvedValue({ ok: true }),
    attachProvider: vi
      .fn<OpenShellProviderAdapter["attachProvider"]>()
      .mockResolvedValue({ ok: true }),
    configureProviderRefresh: vi
      .fn<OpenShellProviderAdapter["configureProviderRefresh"]>()
      .mockResolvedValue({ ok: true }),
    getProviderRefreshStatus: vi
      .fn<OpenShellProviderAdapter["getProviderRefreshStatus"]>()
      .mockResolvedValue({ ok: true, value: { status: "refreshed" } }),
    ...overrides,
  };
}

describe("messaging OpenShell provider application", () => {
  it("reuses an exact provider through typed adapter calls (#9806)", async () => {
    const expected = definition({
      credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: null }],
    });
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValue({ ok: true, value: metadata(expected) }),
    });

    const result = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
    });

    expect(adapter.getProvider).toHaveBeenCalledWith({
      target,
      providerName: expected.providerName,
    });
    expect(adapter.importProviderProfile).toHaveBeenCalledWith({
      target,
      profilePath: expected.profile!.profilePath,
    });
    expect(adapter.createProvider).not.toHaveBeenCalled();
    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      upserted: [],
      reused: [{ providerName: expected.providerName }],
      providerNames: [expected.providerName],
    });
  });

  it("does not import a profile for an OpenShell built-in provider type (#9806)", async () => {
    const expected = definition({
      providerType: "generic",
      credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: null }],
      profile: undefined,
    });
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValue({ ok: true, value: metadata(expected) }),
    });

    const result = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
    });

    expect(adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(adapter.createProvider).not.toHaveBeenCalled();
    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(result.providerNames).toEqual([expected.providerName]);
  });

  it.each([
    ["provider type", { type: "generic" }],
    ["configuration keys", { configKeys: ["BASE_URL"] }],
  ])(
    "rejects a %s collision before profile or provider mutation (#9806)",
    async (_field, conflictingMetadata) => {
      const expected = definition();
      const adapter = providerAdapter({
        getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
          ok: true,
          value: { ...metadata(expected), ...conflictingMetadata },
        }),
      });

      const failure = await applyCredentialsAtOpenShell(plan, {
        providerAdapter: adapter,
        target,
        definitions: [expected],
      }).catch((error: unknown) => error);

      expect(isMessagingProviderBindingConflict(failure)).toBe(true);
      expect(adapter.importProviderProfile).not.toHaveBeenCalled();
      expect(adapter.createProvider).not.toHaveBeenCalled();
      expect(adapter.updateProvider).not.toHaveBeenCalled();
      expect(adapter.deleteProvider).not.toHaveBeenCalled();
    },
  );

  it("rejects an incomplete required batch before profile or provider mutation (#9806)", async () => {
    const first = definition();
    const second = definition({
      channelId: "discord",
      credentialId: "DISCORD_BOT_TOKEN",
      providerName: "alpha-discord-bridge",
      credentials: [{ name: "DISCORD_BOT_TOKEN", value: null }],
    });
    const adapter = providerAdapter({
      getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      }),
    });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [first, second],
      requireCompleteBindings: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      createdProviderNames: [],
      mutatedProviderNames: [],
      replacedProviderNames: [],
    });
    expect(adapter.getProvider).toHaveBeenCalledTimes(2);
    expect(adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(adapter.createProvider).not.toHaveBeenCalled();
    expect(adapter.updateProvider).not.toHaveBeenCalled();
  });

  it("rejects replacement when any attachment is outside the authorized sandbox (#9806)", async () => {
    const expected = definition();
    const adapter = providerAdapter({
      getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
        ok: true,
        value: { ...metadata(expected), type: "generic" },
      }),
      deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>().mockResolvedValue({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider is attached",
          attachedSandboxes: ["alpha", "other"],
        },
      }),
    });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      replaceExisting: true,
      allowedSandboxes: ["alpha"],
    }).catch((error: unknown) => error);

    expect(isMessagingProviderBindingConflict(failure)).toBe(true);
    expect(adapter.detachProvider).not.toHaveBeenCalled();
    expect((failure as MessagingProviderApplyError).mutatedProviderNames).toEqual([]);
  });

  it("replaces an authorized provider and attaches the recreated provider (#9806)", async () => {
    const expected = definition();
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: true,
        value: { ...metadata(expected), type: "generic" },
      })
      .mockResolvedValueOnce({ ok: true, value: metadata(expected) });
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider is attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({ ok: true });
    const revalidateSandboxIdentity = vi.fn();
    const adapter = providerAdapter({ getProvider, deleteProvider });

    const result = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      replaceExisting: true,
      allowedSandboxes: ["alpha"],
      attachToSandbox: "alpha",
      revalidateSandboxIdentity,
    });

    expect(adapter.detachProvider).toHaveBeenCalledWith({
      target,
      providerName: expected.providerName,
      sandboxName: "alpha",
    });
    expect(adapter.createProvider).toHaveBeenCalledWith({
      target,
      name: expected.providerName,
      type: expected.providerType,
      credentials: expected.credentials,
      config: [],
      fromExisting: false,
    });
    expect(adapter.attachProvider).toHaveBeenCalledWith({
      target,
      providerName: expected.providerName,
      sandboxName: "alpha",
    });
    expect(result.providerNames).toEqual([expected.providerName]);
  });

  it.each([
    { checkpoint: 1, deletes: 0, detaches: 0, creates: 0, attaches: 0, mutated: false },
    { checkpoint: 2, deletes: 1, detaches: 0, creates: 0, attaches: 0, mutated: false },
    { checkpoint: 3, deletes: 1, detaches: 1, creates: 0, attaches: 0, mutated: true },
    { checkpoint: 4, deletes: 1, detaches: 1, creates: 0, attaches: 0, mutated: true },
    { checkpoint: 5, deletes: 2, detaches: 1, creates: 0, attaches: 0, mutated: true },
    { checkpoint: 6, deletes: 2, detaches: 1, creates: 1, attaches: 0, mutated: true },
    { checkpoint: 7, deletes: 2, detaches: 1, creates: 1, attaches: 0, mutated: true },
    { checkpoint: 8, deletes: 2, detaches: 1, creates: 1, attaches: 1, mutated: true },
  ])(
    "returns exact evidence when identity changes at replacement checkpoint $checkpoint (#9806)",
    async ({ checkpoint, deletes, detaches, creates, attaches, mutated }) => {
      const expected = definition();
      const adapter = providerAdapter({
        getProvider: vi
          .fn<OpenShellProviderAdapter["getProvider"]>()
          .mockResolvedValueOnce({
            ok: true,
            value: { ...metadata(expected), type: "generic" },
          })
          .mockResolvedValueOnce({ ok: true, value: metadata(expected) }),
        deleteProvider: vi
          .fn<OpenShellProviderAdapter["deleteProvider"]>()
          .mockResolvedValueOnce({
            ok: false,
            error: {
              kind: "command",
              reason: "attached",
              message: "provider is attached",
              attachedSandboxes: ["alpha"],
            },
          })
          .mockResolvedValueOnce({ ok: true }),
      });
      const passIdentityCheck = () => undefined;
      const identityChecks = [
        passIdentityCheck,
        passIdentityCheck,
        passIdentityCheck,
        passIdentityCheck,
        passIdentityCheck,
        passIdentityCheck,
        passIdentityCheck,
        passIdentityCheck,
      ];
      identityChecks[checkpoint - 1] = () => {
        throw new Error("sandbox identity changed");
      };
      let identityCheck = 0;
      const revalidateSandboxIdentity = vi.fn();
      revalidateSandboxIdentity.mockImplementation(() => identityChecks[identityCheck++]());

      const failure = await applyCredentialsAtOpenShell(plan, {
        providerAdapter: adapter,
        target,
        definitions: [expected],
        replaceExisting: true,
        allowedSandboxes: ["alpha"],
        attachToSandbox: "alpha",
        revalidateSandboxIdentity,
      }).catch((error: unknown) => error);

      expect(isMessagingProviderMutationFailure(failure)).toBe(true);
      expect(failure).toMatchObject({
        message: "sandbox identity changed",
        mutatedProviderNames: mutated ? [expected.providerName] : [],
        createdProviderNames: creates > 0 ? [expected.providerName] : [],
        replacedProviderNames: deletes > 1 ? [expected.providerName] : [],
      });
      expect(adapter.deleteProvider).toHaveBeenCalledTimes(deletes);
      expect(adapter.detachProvider).toHaveBeenCalledTimes(detaches);
      expect(adapter.createProvider).toHaveBeenCalledTimes(creates);
      expect(adapter.attachProvider).toHaveBeenCalledTimes(attaches);
    },
  );

  it("returns created-provider evidence when attachment fails (#9806)", async () => {
    const expected = definition();
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValueOnce({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "provider not found" },
        })
        .mockResolvedValueOnce({ ok: true, value: metadata(expected) }),
      attachProvider: vi.fn<OpenShellProviderAdapter["attachProvider"]>().mockResolvedValue({
        ok: false,
        error: { kind: "transport", reason: "unreachable", message: "gateway unavailable" },
      }),
    });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      attachToSandbox: "alpha",
      allowedSandboxes: ["alpha"],
    }).catch((error: unknown) => error);

    expect(isMessagingProviderMutationFailure(failure)).toBe(true);
    expect(failure).toMatchObject({
      createdProviderNames: [expected.providerName],
      mutatedProviderNames: [expected.providerName],
      replacedProviderNames: [],
    });
  });

  it("preserves replacement evidence when the recreated provider cannot attach (#9806)", async () => {
    const expected = definition();
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValueOnce({
          ok: true,
          value: { ...metadata(expected), type: "generic" },
        })
        .mockResolvedValueOnce({ ok: true, value: metadata(expected) }),
      attachProvider: vi.fn<OpenShellProviderAdapter["attachProvider"]>().mockResolvedValue({
        ok: false,
        error: { kind: "transport", reason: "unreachable", message: "gateway unavailable" },
      }),
    });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      replaceExisting: true,
      allowedSandboxes: ["alpha"],
      attachToSandbox: "alpha",
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      createdProviderNames: [expected.providerName],
      mutatedProviderNames: [expected.providerName],
      replacedProviderNames: [expected.providerName],
    });
  });

  it("stops before attachment when sandbox identity changes (#9806)", async () => {
    const expected = definition();
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValueOnce({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "provider not found" },
        })
        .mockResolvedValueOnce({ ok: true, value: metadata(expected) }),
    });
    const revalidateSandboxIdentity = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("sandbox identity changed");
      });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      attachToSandbox: "alpha",
      allowedSandboxes: ["alpha"],
      revalidateSandboxIdentity,
    }).catch((error: unknown) => error);

    expect(adapter.attachProvider).not.toHaveBeenCalled();
    expect(failure).toMatchObject({
      createdProviderNames: [expected.providerName],
      mutatedProviderNames: [expected.providerName],
    });
  });

  it("preserves the completed mutation when a later provider fails (#9806)", async () => {
    const first = definition();
    const second = definition({
      channelId: "discord",
      credentialId: "DISCORD_BOT_TOKEN",
      providerName: "alpha-discord-bridge",
      credentials: [{ name: "DISCORD_BOT_TOKEN", value: "discord-secret" }],
    });
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({ ok: true, value: metadata(first) });
    const createProvider = vi
      .fn<OpenShellProviderAdapter["createProvider"]>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "failed", message: "provider create failed" },
      });
    const adapter = providerAdapter({ getProvider, createProvider });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [first, second],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      createdProviderNames: [first.providerName],
      mutatedProviderNames: [first.providerName],
    });
  });

  it.each(["command uncertainty", "connection loss", "timeout"])(
    "marks an uncertain create as a cleanup candidate after %s (#9806)",
    async (failureKind) => {
      const expected = definition();
      const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>().mockResolvedValue({
        ok: false,
        error:
          failureKind === "timeout"
            ? { kind: "timeout", message: "provider create timed out" }
            : failureKind === "connection loss"
              ? {
                  kind: "transport",
                  reason: "connection_loss",
                  message: "provider connection closed",
                }
              : {
                  kind: "command",
                  reason: "uncertain",
                  message: "provider create outcome is unknown",
                },
      });
      const adapter = providerAdapter({ createProvider });

      const failure = await applyCredentialsAtOpenShell(plan, {
        providerAdapter: adapter,
        target,
        definitions: [expected],
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        createdProviderNames: [expected.providerName],
        mutatedProviderNames: [expected.providerName],
      });
      expect(adapter.getProvider).toHaveBeenCalledOnce();
    },
  );

  it("marks an uncertain update as mutated without claiming provider creation (#9806)", async () => {
    const expected = definition();
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValue({ ok: true, value: metadata(expected) }),
      updateProvider: vi.fn<OpenShellProviderAdapter["updateProvider"]>().mockResolvedValue({
        ok: false,
        error: {
          kind: "command",
          reason: "uncertain",
          message: "provider update outcome is unknown",
        },
      }),
    });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      createdProviderNames: [],
      mutatedProviderNames: [expected.providerName],
    });
  });

  it("keeps provider and refresh secrets out of successful results (#9806)", async () => {
    const credentialSecret = "credential-secret-value";
    const refreshSecret = "refresh-secret-value";
    const expected = definition({
      credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: credentialSecret }],
    });
    const refresh: MessagingProviderRefreshEphemeralInput = {
      channelId: "telegram",
      providerName: expected.providerName,
      credentialKey: "TELEGRAM_BOT_TOKEN",
      strategy: "test-refresh",
      material: [{ key: "scope", value: "chat" }],
      secretMaterial: [{ key: "private_key", value: refreshSecret }],
    };
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValueOnce({ ok: true, value: metadata(expected) })
        .mockResolvedValueOnce({ ok: true, value: metadata(expected) }),
    });

    const result = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      refreshes: [refresh],
    });

    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(result.reused).toEqual([
      expect.objectContaining({ providerName: expected.providerName }),
    ]);
    expect(adapter.configureProviderRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ secretMaterial: refresh.secretMaterial }),
    );
    expect(JSON.stringify(result)).not.toContain(credentialSecret);
    expect(JSON.stringify(result)).not.toContain(refreshSecret);
  });

  it.each([
    { phase: "before", failIndex: 0, configureCalls: 0, mutated: false },
    { phase: "after", failIndex: 1, configureCalls: 1, mutated: true },
  ])(
    "rejects sandbox identity drift $phase refresh configuration (#9806)",
    async ({ failIndex, configureCalls, mutated }) => {
      const refreshSecret = "refresh-secret-do-not-leak";
      const expected = definition({
        credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: "openshell-managed-pending-mint" }],
      });
      const refresh: MessagingProviderRefreshEphemeralInput = {
        channelId: "telegram",
        providerName: expected.providerName,
        credentialKey: "TELEGRAM_BOT_TOKEN",
        strategy: "test-refresh",
        material: [{ key: "scope", value: "chat" }],
        secretMaterial: [{ key: "private_key", value: refreshSecret }],
      };
      const adapter = providerAdapter({
        getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
          ok: true,
          value: metadata(expected),
        }),
      });
      const passIdentityCheck = () => undefined;
      const identityChecks = [passIdentityCheck, passIdentityCheck];
      identityChecks[failIndex] = () => {
        throw new Error("sandbox identity changed");
      };
      let identityCheck = 0;
      const revalidateSandboxIdentity = vi.fn(() => identityChecks[identityCheck++]?.());

      const failure = await applyCredentialsAtOpenShell(plan, {
        providerAdapter: adapter,
        target,
        definitions: [expected],
        refreshes: [refresh],
        revalidateSandboxIdentity,
      }).catch((error: unknown) => error);

      expect(isMessagingProviderMutationFailure(failure)).toBe(true);
      expect(failure).toMatchObject({
        message: "sandbox identity changed",
        mutatedProviderNames: mutated ? [expected.providerName] : [],
      });
      expect(adapter.configureProviderRefresh).toHaveBeenCalledTimes(configureCalls);
      expect(adapter.getProviderRefreshStatus).not.toHaveBeenCalled();
      expect((failure as Error).message).not.toContain(refreshSecret);
      expect(JSON.stringify(failure)).not.toContain(refreshSecret);
    },
  );

  it("redacts injected adapter failures from errors and cleanup results (#9806)", async () => {
    const secret = "nvapi-secret-value";
    const expected = definition();
    const applyAdapter = providerAdapter({
      getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
        ok: false,
        error: {
          kind: "transport",
          reason: "unreachable",
          message: `NVIDIA_API_KEY=${secret}`,
        },
      }),
    });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: applyAdapter,
      target,
      definitions: [expected],
    }).catch((error: unknown) => error);
    const cleanup = await cleanupProvidersAtOpenShell([expected.providerName], {
      providerAdapter: providerAdapter({
        deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>().mockResolvedValue({
          ok: false,
          error: {
            kind: "transport",
            reason: "unreachable",
            message: `NVIDIA_API_KEY=${secret}`,
          },
        }),
      }),
      target,
    });

    expect(String((failure as Error).message)).not.toContain(secret);
    expect(JSON.stringify(cleanup)).not.toContain(secret);
    expect(cleanup.residualProviders[0]?.error.message).toContain("<REDACTED>");
  });

  it("redacts rejected refresh configuration errors without retaining their cause (#9806)", async () => {
    const secret = "nvapi-refresh-rejection-secret";
    const expected = definition({
      credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: "openshell-managed-pending-mint" }],
    });
    const refresh: MessagingProviderRefreshEphemeralInput = {
      channelId: "telegram",
      providerName: expected.providerName,
      credentialKey: "TELEGRAM_BOT_TOKEN",
      strategy: "test-refresh",
      material: [{ key: "scope", value: "chat" }],
      secretMaterial: [{ key: "private_key", value: secret }],
    };
    const adapter = providerAdapter({
      getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
        ok: true,
        value: metadata(expected),
      }),
      configureProviderRefresh: vi
        .fn<OpenShellProviderAdapter["configureProviderRefresh"]>()
        .mockRejectedValue(new Error(`refresh rejected: ${secret}`)),
    });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      refreshes: [refresh],
    }).catch((error: unknown) => error);

    expect(isMessagingProviderMutationFailure(failure)).toBe(true);
    expect(failure).toMatchObject({
      message: expect.stringContaining(expected.providerName),
      mutatedProviderNames: [expected.providerName],
    });
    expect((failure as Error).message).toContain("<REDACTED>");
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(adapter.getProviderRefreshStatus).not.toHaveBeenCalled();
  });

  it.each(["configuration", "observation"] as const)(
    "reports %s refresh failure with mutation evidence (#9806)",
    async (failureKind) => {
      const observationSecret = "nvapi-observation-secret";
      const expected = definition({
        credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: "openshell-managed-pending-mint" }],
      });
      const refresh: MessagingProviderRefreshEphemeralInput = {
        channelId: "telegram",
        providerName: expected.providerName,
        credentialKey: "TELEGRAM_BOT_TOKEN",
        strategy: "test-refresh",
        material: [{ key: "scope", value: "chat" }],
        secretMaterial: [{ key: "private_key", value: "refresh-secret" }],
      };
      const getProvider = vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValueOnce({ ok: true, value: metadata(expected) })
        .mockResolvedValueOnce({ ok: true, value: metadata(expected) });
      const adapter =
        failureKind === "configuration"
          ? providerAdapter({
              getProvider,
              configureProviderRefresh: vi
                .fn<OpenShellProviderAdapter["configureProviderRefresh"]>()
                .mockResolvedValue({
                  ok: false,
                  error: { kind: "command", reason: "failed", message: "refresh rejected" },
                }),
            })
          : providerAdapter({
              getProvider,
              getProviderRefreshStatus: vi
                .fn<OpenShellProviderAdapter["getProviderRefreshStatus"]>()
                .mockResolvedValue({
                  ok: false,
                  error: {
                    kind: "transport",
                    reason: "unreachable",
                    message: `status unavailable ${observationSecret}`,
                  },
                }),
            });
      const nowValues = [0, 1, REFRESH_DEADLINE_FOR_TEST];
      const failure = await applyCredentialsAtOpenShell(plan, {
        providerAdapter: adapter,
        target,
        definitions: [expected],
        refreshes: [refresh],
        now: () => nowValues.shift() ?? REFRESH_DEADLINE_FOR_TEST,
        sleep: async () => {},
      }).catch((error: unknown) => error);

      expect(isMessagingProviderMutationFailure(failure)).toBe(true);
      expect(failure).toMatchObject({
        mutatedProviderNames: [expected.providerName],
      });
      expect(adapter.updateProvider).not.toHaveBeenCalled();
      expect((failure as Error).message).not.toContain(observationSecret);
    },
  );

  it("bounds a refresh that stays pending and reports mutation evidence (#9806)", async () => {
    const expected = definition({
      credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: "openshell-managed-pending-mint" }],
    });
    const refresh: MessagingProviderRefreshEphemeralInput = {
      channelId: "telegram",
      providerName: expected.providerName,
      credentialKey: "TELEGRAM_BOT_TOKEN",
      strategy: "test-refresh",
      material: [{ key: "scope", value: "chat" }],
      secretMaterial: [{ key: "private_key", value: "refresh-secret" }],
    };
    const getProviderRefreshStatus = vi
      .fn<OpenShellProviderAdapter["getProviderRefreshStatus"]>()
      .mockResolvedValue({ ok: true, value: { status: "configured" } });
    const sleep = vi.fn(async () => {});
    const adapter = providerAdapter({
      getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
        ok: true,
        value: metadata(expected),
      }),
      getProviderRefreshStatus,
    });

    const failure = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      refreshes: [refresh],
      now: () => 0,
      sleep,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      mutatedProviderNames: [expected.providerName],
    });
    expect((failure as Error).message).toContain("last status 'configured'");
    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(getProviderRefreshStatus).toHaveBeenCalledTimes(REFRESH_POLL_ATTEMPTS_FOR_TEST);
    expect(sleep).toHaveBeenCalledTimes(REFRESH_POLL_ATTEMPTS_FOR_TEST - 1);
  });

  it("returns exact detach and residual cleanup evidence (#9806)", async () => {
    const providerName = "alpha-telegram-bridge";
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "attached",
          message: "provider is attached",
          attachedSandboxes: ["alpha"],
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "transport", reason: "unreachable", message: "delete unavailable" },
      });
    const adapter = providerAdapter({ deleteProvider });

    const result = await cleanupProvidersAtOpenShell([providerName], {
      providerAdapter: adapter,
      target,
      allowedSandboxes: ["alpha"],
    });

    expect(result).toEqual({
      removedProviderNames: [],
      absentProviderNames: [],
      detachedAttachments: [{ providerName, sandboxName: "alpha" }],
      residualProviders: [
        {
          providerName,
          error: { kind: "transport", reason: "unreachable", message: "delete unavailable" },
        },
      ],
    });
  });

  it("distinguishes an already absent provider from one removed by cleanup (#9806)", async () => {
    const providerName = "alpha-telegram-bridge";
    const adapter = providerAdapter({
      deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>().mockResolvedValue({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      }),
    });

    const result = await cleanupProvidersAtOpenShell([providerName], {
      providerAdapter: adapter,
      target,
      allowedSandboxes: ["alpha"],
    });

    expect(result).toEqual({
      removedProviderNames: [],
      absentProviderNames: [providerName],
      detachedAttachments: [],
      residualProviders: [],
    });
  });

  it("stops cleanup before deletion when sandbox identity changes (#9806)", async () => {
    const providerName = "alpha-telegram-bridge";
    const adapter = providerAdapter();

    const result = await cleanupProvidersAtOpenShell([providerName], {
      providerAdapter: adapter,
      target,
      allowedSandboxes: ["alpha"],
      revalidateSandboxIdentity: () => {
        throw new Error("untrusted identity detail");
      },
    });

    expect(adapter.deleteProvider).not.toHaveBeenCalled();
    expect(result).toEqual({
      removedProviderNames: [],
      absentProviderNames: [],
      detachedAttachments: [],
      residualProviders: [
        {
          providerName,
          error: {
            kind: "validation",
            message: "Sandbox identity changed during messaging provider cleanup.",
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("untrusted identity detail");
  });
});

const REFRESH_DEADLINE_FOR_TEST = 300_001;
const REFRESH_POLL_ATTEMPTS_FOR_TEST = 50;
