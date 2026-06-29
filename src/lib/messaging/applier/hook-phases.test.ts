// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  MessagingChannelId,
  SandboxMessagingChannelPlan,
  SandboxMessagingPlan,
} from "../manifest";
import { applyDiagnostics, applyPreEnableChecks, MessagingSetupApplier } from "./index";
import type { MessagingHookApplyRequest, MessagingHookApplyRunner } from "./types";

describe("messaging applier hook phases", () => {
  it("runs enabled channel hooks for the requested phase through the provided runner", async () => {
    const calls: MessagingHookApplyRequest[] = [];
    const result = await applyPreEnableChecks(makePlan(), {
      runHook: (request) => {
        calls.push(request);
        return {
          outputs: {
            checked: {
              kind: "config",
              value: "ok",
            },
          },
        };
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        sandboxName: "demo",
        agent: "openclaw",
        channelId: "telegram",
        hookId: "telegram-pre-enable",
        phase: "pre-enable",
        handler: "telegram.preEnable",
        inputs: {
          allowedIds: "12345",
          "allowedIds.telegram": "12345",
          "credential.telegramBotToken.placeholder": "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        },
      }),
    ]);
    expect(result).toMatchObject({
      phase: "pre-enable",
      appliedHooks: ["telegram:telegram-pre-enable"],
      skippedHooks: [],
    });
    expect(result.hookResults).toEqual([
      {
        hookId: "telegram-pre-enable",
        handlerId: "telegram.preEnable",
        phase: "pre-enable",
        outputs: {
          checked: {
            kind: "config",
            value: "ok",
          },
        },
      },
    ]);
  });

  it("requires a runner only when the selected phase has matching hooks", async () => {
    await expect(applyPreEnableChecks(makePlan())).rejects.toThrow(
      "Messaging hook phase 'pre-enable' requires a hook runner.",
    );

    await expect(applyDiagnostics(makePlan())).resolves.toEqual({
      phase: "diagnostic",
      hookRequests: [],
      hookResults: [],
      appliedHooks: [],
      skippedHooks: [],
    });
  });

  it("merges phase-level inputs into hook requests", async () => {
    const calls: MessagingHookApplyRequest[] = [];

    await applyPreEnableChecks(makePlan(), {
      additionalInputs: {
        currentSandbox: "demo",
        currentGatewayName: "nemoclaw",
      },
      runHook: (request) => {
        calls.push(request);
      },
    });

    expect(calls[0]?.inputs).toMatchObject({
      allowedIds: "12345",
      currentSandbox: "demo",
      currentGatewayName: "nemoclaw",
    });
  });

  it("honors skip-channel failure policy and continues later hooks", async () => {
    const runHook: MessagingHookApplyRunner = (request) => {
      if (request.hookId === "telegram-pre-enable") {
        throw new Error("telegram skipped");
      }
      return {
        hookId: request.hookId,
        handlerId: request.handler,
        phase: request.phase,
        outputs: {},
      };
    };

    const result = await MessagingSetupApplier.applyPreEnableChecks(
      makePlan({
        telegramOnFailure: "skip-channel",
        includeDiscordPreEnable: true,
      }),
      { runHook },
    );

    expect(result.skippedHooks).toEqual(["telegram:telegram-pre-enable"]);
    expect(result.appliedHooks).toEqual(["discord:discord-pre-enable"]);
    expect(result.hookResults).toEqual([
      {
        hookId: "discord-pre-enable",
        handlerId: "discord.preEnable",
        phase: "pre-enable",
        outputs: {},
      },
    ]);
  });

  it("stops later hooks for the skipped channel after a skip-channel failure", async () => {
    const calls: string[] = [];
    const runHook: MessagingHookApplyRunner = (request) => {
      calls.push(`${request.channelId}:${request.hookId}`);
      if (request.hookId === "telegram-pre-enable") {
        throw new Error("telegram skipped");
      }
      return {
        hookId: request.hookId,
        handlerId: request.handler,
        phase: request.phase,
        outputs: {},
      };
    };

    const result = await MessagingSetupApplier.applyPreEnableChecks(
      makePlan({
        telegramOnFailure: "skip-channel",
        includeTelegramSecondPreEnable: true,
        includeDiscordPreEnable: true,
      }),
      { runHook },
    );

    expect(calls).toEqual(["telegram:telegram-pre-enable", "discord:discord-pre-enable"]);
    expect(result.skippedHooks).toEqual([
      "telegram:telegram-pre-enable",
      "telegram:telegram-second-pre-enable",
    ]);
    expect(result.appliedHooks).toEqual(["discord:discord-pre-enable"]);
  });
});

function makePlan(
  options: {
    readonly telegramOnFailure?: "abort" | "skip-channel";
    readonly includeTelegramSecondPreEnable?: boolean;
    readonly includeDiscordPreEnable?: boolean;
  } = {},
): SandboxMessagingPlan {
  const channels: SandboxMessagingChannelPlan[] = [
    makeChannel("telegram", {
      hooks: [
        {
          channelId: "telegram",
          id: "telegram-pre-enable",
          phase: "pre-enable",
          handler: "telegram.preEnable",
          inputs: ["allowedIds", "allowedIds.telegram", "credential.telegramBotToken.placeholder"],
          outputs: [
            {
              id: "checked",
              kind: "config",
            },
          ],
          onFailure: options.telegramOnFailure,
        },
        ...(options.includeTelegramSecondPreEnable
          ? [
              {
                channelId: "telegram" as MessagingChannelId,
                id: "telegram-second-pre-enable",
                phase: "pre-enable" as const,
                handler: "telegram.secondPreEnable",
                onFailure: "abort" as const,
              },
            ]
          : []),
      ],
    }),
    makeChannel("slack", {
      active: false,
      disabled: true,
      hooks: [
        {
          channelId: "slack",
          id: "slack-pre-enable",
          phase: "pre-enable",
          handler: "slack.preEnable",
        },
      ],
    }),
  ];
  if (options.includeDiscordPreEnable) {
    channels.push(
      makeChannel("discord", {
        hooks: [
          {
            channelId: "discord",
            id: "discord-pre-enable",
            phase: "pre-enable",
            handler: "discord.preEnable",
          },
        ],
      }),
    );
  }

  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "add-channel",
    channels,
    disabledChannels: ["slack"],
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "telegramBotToken",
        sourceInput: "botToken",
        providerName: "demo-telegram-bridge",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
      },
    ],
    networkPolicy: {
      presets: ["telegram"],
      entries: [
        {
          channelId: "telegram",
          presetName: "telegram",
          policyKeys: ["telegram"],
          source: "manifest",
        },
      ],
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function makeChannel(
  channelId: MessagingChannelId,
  options: {
    readonly active?: boolean;
    readonly disabled?: boolean;
    readonly hooks?: SandboxMessagingChannelPlan["hooks"];
  } = {},
): SandboxMessagingChannelPlan {
  return {
    channelId,
    displayName: channelId,
    authMode: "token-paste",
    active: options.active ?? true,
    selected: true,
    configured: true,
    disabled: options.disabled ?? false,
    inputs:
      channelId === "telegram"
        ? [
            {
              channelId,
              inputId: "allowedIds",
              kind: "config",
              required: false,
              sourceEnv: "TELEGRAM_ALLOWED_IDS",
              statePath: "allowedIds.telegram",
              value: "12345",
            },
          ]
        : [],
    hooks: options.hooks ?? [],
  };
}
