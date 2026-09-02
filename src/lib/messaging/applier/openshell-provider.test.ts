// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { SandboxMessagingPlan } from "../manifest";
import { applyCredentialsAtOpenShell, MessagingProviderApplyError } from "./openshell-provider";

const TELEGRAM_PROVIDER = "demo-telegram-bridge";
const TELEGRAM_TOKEN = "123456:telegram-token";

const EXACT_PROVIDER = {
  name: TELEGRAM_PROVIDER,
  type: "nemoclaw-mcp-v1",
  credentialKeys: ["TELEGRAM_BOT_TOKEN"],
  configKeys: [],
} as const;

const PROVIDER_NOT_FOUND = {
  ok: false as const,
  error: {
    kind: "command" as const,
    reason: "not_found" as const,
    message: "OpenShell provider was not found.",
  },
};

function providerAdapter(operations: Partial<OpenShellProviderAdapter>): OpenShellProviderAdapter {
  return {
    ensureEndpointlessProviderProfile: vi.fn(async () => ({
      ok: true as const,
      value: { state: "ready" as const },
    })),
    ...operations,
  } as unknown as OpenShellProviderAdapter;
}

function telegramPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        displayName: "Telegram",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "telegram-bot-token",
        sourceInput: "bot-token",
        providerName: TELEGRAM_PROVIDER,
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function telegramDefinition(value: string | null = TELEGRAM_TOKEN) {
  return {
    channelId: "telegram" as const,
    credentialId: "telegram-bot-token",
    providerName: TELEGRAM_PROVIDER,
    providerType: "nemoclaw-mcp-v1",
    credentials: [{ name: "TELEGRAM_BOT_TOKEN", value }],
    profile: {
      kind: "endpointless" as const,
      profilePath: "/repo/nemoclaw-mcp-v1.yaml",
      profileType: "nemoclaw-mcp-v1",
      inferenceCapable: false as const,
    },
  };
}

describe("messaging OpenShell provider application", () => {
  it("makes provider decisions from typed adapter results (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          kind: "command",
          reason: "not_found",
          message: "OpenShell provider was not found.",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: EXACT_PROVIDER,
      });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
      ok: true,
      value: { state: "created" },
    }));
    const adapter = providerAdapter({
      getProvider,
      createProvider,
    });

    const result = await applyCredentialsAtOpenShell(telegramPlan(), {
      env: { TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN },
      providerAdapter: adapter,
    });

    expect(createProvider).toHaveBeenCalledWith({
      target: { kind: "selected" },
      name: TELEGRAM_PROVIDER,
      type: "nemoclaw-mcp-v1",
      credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: TELEGRAM_TOKEN }],
      config: [],
      fromExisting: false,
    });
    expect(result.upserted).toEqual([
      expect.objectContaining({ action: "create", providerName: TELEGRAM_PROVIDER }),
    ]);
    expect(JSON.stringify(result)).not.toContain(TELEGRAM_TOKEN);
  });

  it("refuses a provider collision before mutation (#9806)", async () => {
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>();
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: {
          ...EXACT_PROVIDER,
          credentialKeys: ["TELEGRAM_BOT_TOKEN", "FOREIGN_TOKEN"],
        },
      })),
      createProvider,
      updateProvider,
    });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        env: { TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN },
        providerAdapter: adapter,
      }),
    ).rejects.toThrow("does not match the required endpointless credential binding");
    expect(createProvider).not.toHaveBeenCalled();
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("refuses partial credential material before provider creation (#9806)", async () => {
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => PROVIDER_NOT_FOUND),
      createProvider,
    });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: adapter,
        definitions: [
          {
            ...telegramDefinition(),
            credentials: [
              { name: "TELEGRAM_BOT_TOKEN", value: TELEGRAM_TOKEN },
              { name: "TELEGRAM_SECONDARY_TOKEN", value: null },
            ],
          },
        ],
      }),
    ).rejects.toThrow("is missing required credential material for creation");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it.each([
    { action: "create", observed: PROVIDER_NOT_FOUND },
    { action: "update", observed: { ok: true as const, value: EXACT_PROVIDER } },
  ])(
    "does not expose credentials when provider $action fails (#9806)",
    async ({ action, observed }) => {
      const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "failed" as const,
          message: "OpenShell could not create the selected provider.",
        },
      }));
      const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>(async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "failed" as const,
          message: "OpenShell could not update the selected provider.",
        },
      }));
      const adapter = providerAdapter({
        getProvider: vi.fn(async () => observed),
        createProvider,
        updateProvider,
      });

      const result = applyCredentialsAtOpenShell(telegramPlan(), {
        env: { TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN },
        providerAdapter: adapter,
      });
      await expect(result).rejects.toThrow(`Failed to ${action} messaging provider`);
      await expect(result).rejects.not.toThrow(/telegram-token/u);
      expect(action === "create" ? createProvider : updateProvider).toHaveBeenCalledOnce();
    },
  );

  it("rejects a changed provider binding after update (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: EXACT_PROVIDER })
      .mockResolvedValueOnce({
        ok: true,
        value: { ...EXACT_PROVIDER, type: "foreign" },
      });
    const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>(async () => ({
      ok: true,
      value: { state: "updated" },
    }));
    const adapter = providerAdapter({ getProvider, updateProvider });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        env: { TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN },
        providerAdapter: adapter,
      }),
    ).rejects.toThrow(
      `OpenShell did not confirm messaging provider '${TELEGRAM_PROVIDER}' after update.`,
    );
    expect(updateProvider).toHaveBeenCalledOnce();
    expect(getProvider).toHaveBeenCalledTimes(2);
  });

  it("preflights every provider before preparing profiles or mutating state (#9806)", async () => {
    const ensureEndpointlessProviderProfile = vi.fn();
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const adapter = providerAdapter({
      getProvider: vi.fn(async ({ providerName }) =>
        providerName === TELEGRAM_PROVIDER
          ? PROVIDER_NOT_FOUND
          : {
              ok: true as const,
              value: {
                name: providerName,
                type: "foreign",
                credentialKeys: ["SECOND_TOKEN"],
                configKeys: [],
              },
            },
      ),
      ensureEndpointlessProviderProfile,
      createProvider,
    });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: adapter,
        definitions: [
          telegramDefinition(),
          {
            ...telegramDefinition("second-token"),
            channelId: "slack",
            credentialId: "second-token",
            providerName: "demo-second-bridge",
            credentials: [{ name: "SECOND_TOKEN", value: "second-token" }],
          },
        ],
      }),
    ).rejects.toThrow("does not match the required endpointless credential binding");
    expect(ensureEndpointlessProviderProfile).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("replaces an authorized attached provider before recreating it (#9806)", async () => {
    const operations: string[] = [];
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: true,
        value: { ...EXACT_PROVIDER, type: "foreign" },
      })
      .mockResolvedValueOnce({ ok: true, value: EXACT_PROVIDER });
    const deleteProvider = vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockImplementationOnce(async () => {
        operations.push("delete");
        return {
          ok: false,
          error: {
            kind: "command",
            reason: "attached",
            message: "provider is attached",
            attachedSandboxes: ["demo"],
          },
        };
      })
      .mockImplementationOnce(async () => {
        operations.push("delete");
        return { ok: true, value: { state: "deleted" } };
      });
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => {
      operations.push("detach:demo");
      return { ok: true, value: { state: "detached" } };
    });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => {
      operations.push("create");
      return { ok: true, value: { state: "created" } };
    });
    const revalidateSandboxIdentity = vi.fn();

    const result = await applyCredentialsAtOpenShell(telegramPlan(), {
      providerAdapter: providerAdapter({
        getProvider,
        deleteProvider,
        detachProvider,
        createProvider,
      }),
      definitions: [telegramDefinition()],
      replaceExisting: true,
      allowedSandboxes: ["demo"],
      revalidateSandboxIdentity,
    });

    expect(operations).toEqual(["delete", "detach:demo", "delete", "create"]);
    expect(revalidateSandboxIdentity.mock.calls.map(([operation]) => operation)).toEqual([
      `delete messaging provider "${TELEGRAM_PROVIDER}"`,
      `detach messaging provider "${TELEGRAM_PROVIDER}" from sandbox "demo"`,
      `delete messaging provider "${TELEGRAM_PROVIDER}"`,
    ]);
    expect(result.upserted).toEqual([
      expect.objectContaining({ action: "create", providerName: TELEGRAM_PROVIDER }),
    ]);
  });

  it("reports a deleted provider as an incomplete replacement when recreate fails (#9806)", async () => {
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: { ...EXACT_PROVIDER, type: "foreign" },
      })),
      deleteProvider: vi.fn(async () => ({
        ok: true as const,
        value: { state: "deleted" as const },
      })),
      createProvider: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "failed" as const,
          message: "provider create failed",
        },
      })),
    });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: adapter,
        definitions: [telegramDefinition()],
        replaceExisting: true,
      }),
    ).rejects.toMatchObject({
      mutatedProviderNames: [TELEGRAM_PROVIDER],
      createdProviderNames: [],
    });
  });

  it("does not report or perform a mutation for an unauthorized attachment (#9806)", async () => {
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>();
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: { ...EXACT_PROVIDER, type: "foreign" },
      })),
      deleteProvider: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "attached" as const,
          message: "provider is attached",
          attachedSandboxes: ["other-sandbox"],
        },
      })),
      detachProvider,
      createProvider,
    });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: adapter,
        definitions: [telegramDefinition()],
        replaceExisting: true,
        allowedSandboxes: ["demo"],
      }),
    ).rejects.toMatchObject({
      mutatedProviderNames: [],
      createdProviderNames: [],
    });
    expect(detachProvider).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("returns exact partial-mutation evidence when create verification fails (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce(PROVIDER_NOT_FOUND)
      .mockResolvedValueOnce({
        ok: true,
        value: { ...EXACT_PROVIDER, type: "foreign" },
      });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
      ok: true,
      value: { state: "created" },
    }));

    const result = applyCredentialsAtOpenShell(telegramPlan(), {
      providerAdapter: providerAdapter({ getProvider, createProvider }),
      definitions: [telegramDefinition()],
    });

    await expect(result).rejects.toBeInstanceOf(MessagingProviderApplyError);
    await expect(result).rejects.toMatchObject({
      mutatedProviderNames: [TELEGRAM_PROVIDER],
      createdProviderNames: [TELEGRAM_PROVIDER],
    });
  });

  it("imports and verifies a checked-in provider profile before reuse (#9806)", async () => {
    const contractDigest = "profile-contract-digest";
    const importProviderProfile = vi.fn(async () => ({
      ok: true as const,
      value: { state: "already_present" as const },
    }));
    const inspectProviderProfile = vi.fn(async () => ({
      ok: true as const,
      value: { credentialKeys: ["GOOGLE_CHAT_ACCESS_TOKEN"], contractDigest },
    }));
    const definition = {
      ...telegramDefinition(null),
      channelId: "googlechat" as const,
      credentialId: "google-chat-access-token",
      providerName: "demo-google-chat-bridge",
      providerType: "google-chat-bridge",
      credentials: [{ name: "GOOGLE_CHAT_ACCESS_TOKEN", value: null }],
      profile: {
        kind: "checked-in" as const,
        profilePath: "/repo/google-chat.yaml",
        profileType: "google-chat-bridge",
        contractDigest,
      },
    };
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: definition.providerName,
          type: definition.providerType,
          credentialKeys: ["GOOGLE_CHAT_ACCESS_TOKEN"],
          configKeys: [],
        },
      })),
      importProviderProfile,
      inspectProviderProfile,
    });

    const result = await applyCredentialsAtOpenShell(telegramPlan(), {
      providerAdapter: adapter,
      definitions: [definition],
    });

    expect(importProviderProfile).toHaveBeenCalledWith({
      target: { kind: "selected" },
      profilePath: "/repo/google-chat.yaml",
    });
    expect(inspectProviderProfile).toHaveBeenCalledWith({
      target: { kind: "selected" },
      profileType: "google-chat-bridge",
    });
    expect(result.reused).toEqual([
      expect.objectContaining({ providerName: definition.providerName }),
    ]);
  });

  it("rejects a checked-in profile contract mismatch before provider mutation (#9806)", async () => {
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
    const definition = {
      ...telegramDefinition(),
      providerType: "google-chat-bridge",
      profile: {
        kind: "checked-in" as const,
        profilePath: "/repo/google-chat.yaml",
        profileType: "google-chat-bridge",
        contractDigest: "expected-digest",
      },
    };
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => PROVIDER_NOT_FOUND),
      importProviderProfile: vi.fn(async () => ({
        ok: true as const,
        value: { state: "imported" as const },
      })),
      inspectProviderProfile: vi.fn(async () => ({
        ok: true as const,
        value: { credentialKeys: ["TELEGRAM_BOT_TOKEN"], contractDigest: "foreign-digest" },
      })),
      createProvider,
    });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: adapter,
        definitions: [definition],
      }),
    ).rejects.toThrow("does not match NemoClaw's checked-in credential contract");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("rejects conflicting definitions for one checked-in profile before inspection (#9806)", async () => {
    const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>();
    const definition = {
      ...telegramDefinition(),
      providerType: "google-chat-bridge",
      profile: {
        kind: "checked-in" as const,
        profilePath: "/repo/google-chat.yaml",
        profileType: "google-chat-bridge",
        contractDigest: "expected-digest",
      },
    };

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: providerAdapter({ getProvider }),
        definitions: [
          definition,
          {
            ...definition,
            providerName: "demo-second-google-chat-bridge",
            profile: { ...definition.profile, contractDigest: "different-digest" },
          },
        ],
      }),
    ).rejects.toThrow("profile 'google-chat-bridge' has conflicting definitions");
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("rejects refresh credentials outside the provider definition before inspection (#9806)", async () => {
    const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>();

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: providerAdapter({ getProvider }),
        definitions: [telegramDefinition()],
        refreshes: [
          {
            channelId: "googlechat",
            providerName: TELEGRAM_PROVIDER,
            credentialKey: "FOREIGN_TOKEN",
            strategy: "test-refresh",
            material: [{ key: "client_email", value: "bot@example.com" }],
            secretMaterial: [{ key: "private_key", value: "host-only-private-key" }],
          },
        ],
      }),
    ).rejects.toThrow(
      `Messaging provider '${TELEGRAM_PROVIDER}' has an invalid refresh definition.`,
    );
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("configures and observes refresh through typed secret-safe results (#9806)", async () => {
    const privateKey = "host-only-private-key";
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: EXACT_PROVIDER })
      .mockResolvedValueOnce({ ok: true, value: EXACT_PROVIDER });
    const configureProviderRefresh = vi.fn(async () => ({
      ok: true as const,
      value: { state: "configured" as const },
    }));
    const getProviderRefreshStatus = vi
      .fn<OpenShellProviderAdapter["getProviderRefreshStatus"]>()
      .mockResolvedValueOnce({ ok: true, value: { status: "pending" } })
      .mockResolvedValueOnce({ ok: true, value: { status: "refreshed" } });
    const sleep = vi.fn(async () => undefined);
    const adapter = providerAdapter({
      getProvider,
      updateProvider: vi.fn(async () => ({
        ok: true as const,
        value: { state: "updated" as const },
      })),
      configureProviderRefresh,
      getProviderRefreshStatus,
    });

    const result = await applyCredentialsAtOpenShell(telegramPlan(), {
      providerAdapter: adapter,
      definitions: [telegramDefinition()],
      refreshes: [
        {
          channelId: "googlechat",
          providerName: TELEGRAM_PROVIDER,
          credentialKey: "TELEGRAM_BOT_TOKEN",
          strategy: "test-refresh",
          material: [{ key: "client_email", value: "bot@example.com" }],
          secretMaterial: [{ key: "private_key", value: privateKey }],
        },
      ],
      sleep,
      now: () => 0,
    });

    expect(configureProviderRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: TELEGRAM_PROVIDER,
        secretMaterial: [{ key: "private_key", value: privateKey }],
      }),
    );
    expect(getProviderRefreshStatus).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it("preserves a typed refresh observation failure instead of reporting an unknown status (#9806)", async () => {
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValueOnce({ ok: true, value: EXACT_PROVIDER })
        .mockResolvedValueOnce({ ok: true, value: EXACT_PROVIDER }),
      updateProvider: vi.fn(async () => ({
        ok: true as const,
        value: { state: "updated" as const },
      })),
      configureProviderRefresh: vi.fn(async () => ({
        ok: true as const,
        value: { state: "configured" as const },
      })),
      getProviderRefreshStatus: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "authentication" as const,
          message: "OpenShell could not authenticate the provider operation.",
        },
      })),
    });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: adapter,
        definitions: [telegramDefinition()],
        refreshes: [
          {
            channelId: "googlechat",
            providerName: TELEGRAM_PROVIDER,
            credentialKey: "TELEGRAM_BOT_TOKEN",
            strategy: "test-refresh",
            material: [],
            secretMaterial: [{ key: "private_key", value: "host-only-private-key" }],
          },
        ],
        sleep: async () => undefined,
        now: () => 0,
      }),
    ).rejects.toThrow(
      "Could not observe gateway token minting for messaging provider 'demo-telegram-bridge': OpenShell could not authenticate the provider operation.",
    );
  });

  it("reports the last successful pending refresh status separately from observation errors (#9806)", async () => {
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValueOnce({ ok: true, value: EXACT_PROVIDER })
        .mockResolvedValueOnce({ ok: true, value: EXACT_PROVIDER }),
      updateProvider: vi.fn(async () => ({
        ok: true as const,
        value: { state: "updated" as const },
      })),
      configureProviderRefresh: vi.fn(async () => ({
        ok: true as const,
        value: { state: "configured" as const },
      })),
      getProviderRefreshStatus: vi.fn(async () => ({
        ok: true as const,
        value: { status: "pending" },
      })),
    });

    await expect(
      applyCredentialsAtOpenShell(telegramPlan(), {
        providerAdapter: adapter,
        definitions: [telegramDefinition()],
        refreshes: [
          {
            channelId: "googlechat",
            providerName: TELEGRAM_PROVIDER,
            credentialKey: "TELEGRAM_BOT_TOKEN",
            strategy: "test-refresh",
            material: [],
            secretMaterial: [{ key: "private_key", value: "host-only-private-key" }],
          },
        ],
        sleep: async () => undefined,
        now: () => 0,
      }),
    ).rejects.toThrow("last status 'pending'");
  });
});
