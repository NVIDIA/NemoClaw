// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { SandboxMessagingPlan } from "../manifest";
import { applyCredentialsAtOpenShell } from "./openshell-provider";

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
});
