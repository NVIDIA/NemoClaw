// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "./manifest";
import { compactSandboxMessagingPlanForPersistence } from "./persistence";
import { parseSandboxMessagingPlan } from "./plan-validation";

const CANONICAL_DISCORD_PLACEHOLDER = "openshell:resolve:env:DISCORD_BOT_TOKEN";
const VERSIONED_DISCORD_PLACEHOLDER =
  "openshell:resolve:env:v1442987827285932589_DISCORD_BOT_TOKEN";
const VERSIONED_SLACK_PLACEHOLDER = "openshell:resolve:env:v1442987827285932589_SLACK_BOT_TOKEN";

function makeHermesDiscordPlan(
  placeholder: string = VERSIONED_DISCORD_PLACEHOLDER,
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "sb",
    agent: "hermes",
    workflow: "onboard",
    channels: [
      {
        channelId: "discord",
        displayName: "Discord",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [
          {
            channelId: "discord",
            inputId: "botToken",
            kind: "secret",
            required: true,
            sourceEnv: "DISCORD_BOT_TOKEN",
            credentialAvailable: true,
          },
        ],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "discord",
        credentialId: "discordBotToken",
        sourceInput: "botToken",
        providerName: "sb-discord-bridge",
        providerEnvKey: "DISCORD_BOT_TOKEN",
        placeholder,
        credentialAvailable: true,
        credentialHash: "hash",
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [
      {
        channelId: "discord",
        renderId: "discord-hermes-env",
        hookId: "discord-hermes-env",
        handler: "common.staticOutputs",
        kind: "env-lines",
        agent: "hermes",
        target: "~/.hermes/.env",
        lines: ["API_SERVER_PORT=18642", `DISCORD_BOT_TOKEN=${placeholder}`],
        templateRefs: [],
      },
    ],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("persisted messaging placeholders", () => {
  it("normalizes versioned Hermes credential placeholders from full persisted plans", () => {
    const parsed = parseSandboxMessagingPlan(makeHermesDiscordPlan());

    expect(parsed?.credentialBindings[0]?.placeholder).toBe(CANONICAL_DISCORD_PLACEHOLDER);
    expect(parsed?.agentRender[0]).toMatchObject({
      kind: "env-lines",
      lines: ["API_SERVER_PORT=18642", `DISCORD_BOT_TOKEN=${CANONICAL_DISCORD_PLACEHOLDER}`],
    });
  });

  it("regenerates canonical placeholders from compact persisted Hermes plans", () => {
    const compact = compactSandboxMessagingPlanForPersistence(makeHermesDiscordPlan());
    const parsed = parseSandboxMessagingPlan(compact);

    expect(compact).not.toHaveProperty("agentRender");
    expect(parsed?.credentialBindings[0]).toMatchObject({
      providerEnvKey: "DISCORD_BOT_TOKEN",
      placeholder: CANONICAL_DISCORD_PLACEHOLDER,
      credentialAvailable: true,
    });
  });

  it("does not canonicalize versioned placeholders for a different env key", () => {
    const parsed = parseSandboxMessagingPlan(makeHermesDiscordPlan(VERSIONED_SLACK_PLACEHOLDER));

    expect(parsed?.credentialBindings[0]?.placeholder).toBe(VERSIONED_SLACK_PLACEHOLDER);
    expect(parsed?.agentRender[0]).toMatchObject({
      kind: "env-lines",
      lines: ["API_SERVER_PORT=18642", `DISCORD_BOT_TOKEN=${VERSIONED_SLACK_PLACEHOLDER}`],
    });
  });
});
