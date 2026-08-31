// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { SandboxMessagingPlan } from "../manifest";
import { applyCredentialsAtOpenShell } from "./openshell-provider";

const TELEGRAM_PROVIDER = "demo-telegram-bridge";
const TELEGRAM_TOKEN = "123456:telegram-token";

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
  it.each([
    {
      label: "string output",
      output: JSON.stringify({
        id: "nemoclaw-mcp-v1",
        credentials: [],
        endpoints: [],
        binaries: [],
        inference_capable: false,
      }),
    },
    {
      label: "stdio array output",
      output: [
        null,
        JSON.stringify({
          id: "nemoclaw-mcp-v1",
          credentials: [],
          endpoints: [],
          binaries: [],
          inference_capable: false,
        }),
        "",
      ],
    },
  ])("accepts a valid profile from legacy $label (#9806)", async ({ output }) => {
    const result = await applyCredentialsAtOpenShell(telegramPlan(), {
      env: {},
      runOpenshell: (args) =>
        args[1] === "profile"
          ? { status: 0, output }
          : { status: 1, output: `provider '${TELEGRAM_PROVIDER}' not found` },
    });

    expect(result.missing).toEqual([expect.objectContaining({ providerName: TELEGRAM_PROVIDER })]);
  });

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
        value: {
          name: TELEGRAM_PROVIDER,
          type: "nemoclaw-mcp-v1",
          credentialKeys: ["TELEGRAM_BOT_TOKEN"],
          configKeys: [],
        },
      });
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
      ok: true,
      value: { state: "created" },
    }));
    const providerAdapter = {
      ensureEndpointlessProviderProfile: vi.fn(async () => ({
        ok: true as const,
        value: { state: "ready" as const },
      })),
      getProvider,
      createProvider,
    } as unknown as OpenShellProviderAdapter;

    const result = await applyCredentialsAtOpenShell(telegramPlan(), {
      env: { TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN },
      providerAdapter,
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

  it("does not expose a rejected CLI runner through the typed boundary (#9806)", async () => {
    const result = applyCredentialsAtOpenShell(telegramPlan(), {
      env: { TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN },
      runOpenshell: (args) =>
        args[1] === "profile"
          ? {
              status: 0,
              stdout: JSON.stringify({
                id: "nemoclaw-mcp-v1",
                credentials: [],
                endpoints: [],
                binaries: [],
                inference_capable: false,
              }),
            }
          : (() => {
              throw new Error(`untrusted runner diagnostic with ${TELEGRAM_TOKEN}`);
            })(),
    });

    await expect(result).rejects.toThrow(
      `Could not inspect messaging provider '${TELEGRAM_PROVIDER}'.`,
    );
    await expect(result).rejects.not.toThrow(/telegram-token/u);
  });
});
