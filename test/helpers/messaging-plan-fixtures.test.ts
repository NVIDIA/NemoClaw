// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  MessagingChannelId,
  SandboxMessagingCredentialBindingPlan,
} from "../../src/lib/messaging";
import { makeMessagingPlan } from "./messaging-plan-fixtures";

describe("makeMessagingPlan", () => {
  it("isolates nested plan state from later results and caller inputs (#8357)", () => {
    const channels: MessagingChannelId[] = ["telegram"];
    const disabledChannels: MessagingChannelId[] = ["telegram"];
    const credentialBindings: SandboxMessagingCredentialBindingPlan[] = [
      {
        channelId: "telegram",
        credentialId: "telegramBotToken",
        sourceInput: "botToken",
        providerName: "my-assistant-telegram-bridge",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash: "telegram-bot-token-hash",
      },
    ];
    const options = { channels, disabledChannels, credentialBindings };

    const first = makeMessagingPlan(options);
    const second = makeMessagingPlan(options);

    (first.disabledChannels as MessagingChannelId[]).push("discord");
    (first.channels[0] as { displayName: string }).displayName = "mutated";
    (first.channels[0].inputs as unknown[]).push({ inputId: "mutated" });
    (first.credentialBindings[0] as { providerName: string }).providerName = "mutated";

    expect(second.disabledChannels).toEqual(["telegram"]);
    expect(second.channels[0]).toMatchObject({ displayName: "telegram", inputs: [] });
    expect(second.credentialBindings[0].providerName).toBe("my-assistant-telegram-bridge");
    expect(channels).toEqual(["telegram"]);
    expect(disabledChannels).toEqual(["telegram"]);
    expect(credentialBindings[0].providerName).toBe("my-assistant-telegram-bridge");
  });
});
