// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { discordManifest, slackManifest, telegramManifest } from "../../channels";
import { runMessagingHook } from "../hook-runner";
import { MessagingHookRegistry } from "../registry";
import {
  COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
  createConfigPromptHook,
} from "./config-prompt";

describe("common config-prompt hook implementation", () => {
  it("prompts manifest config outputs in hook declaration order", async () => {
    const env: NodeJS.ProcessEnv = {};
    const questions: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
        handler: createConfigPromptHook({
          env,
          log: () => {},
          prompt: async (question) => {
            questions.push(question);
            return question.includes("Reply only") ? "n" : "123456789";
          },
        }),
      },
    ]);
    const hook = telegramManifest.hooks.find(
      (entry) => entry.id === "telegram-config-prompt",
    );

    if (!hook) throw new Error("missing Telegram config-prompt hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "telegram",
      }),
    ).resolves.toMatchObject({
      handlerId: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
      outputs: {
        requireMention: {
          kind: "config",
          value: "0",
        },
        allowedIds: {
          kind: "config",
          value: "123456789",
        },
      },
    });
    expect(questions).toEqual([
      "  Reply only when @mentioned? [Y/n]: ",
      "  Telegram User ID (for DM access): ",
    ]);
    expect(env.TELEGRAM_REQUIRE_MENTION).toBe("0");
    expect(env.TELEGRAM_ALLOWED_IDS).toBe("123456789");
  });

  it("gates dependent prompts on earlier manifest config input values", async () => {
    const questions: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
        handler: createConfigPromptHook({
          env: {},
          log: () => {},
          prompt: async (question) => {
            questions.push(question);
            return "";
          },
        }),
      },
    ]);
    const hook = discordManifest.hooks.find(
      (entry) => entry.id === "discord-config-prompt",
    );

    if (!hook) throw new Error("missing Discord config-prompt hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "discord",
      }),
    ).resolves.toMatchObject({
      outputs: {},
    });
    expect(questions).toEqual([
      "  Discord Server ID (for guild workspace access): ",
    ]);
  });

  it("prompts Slack user and channel allowlists from the manifest", async () => {
    const env: NodeJS.ProcessEnv = {};
    const questions: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
        handler: createConfigPromptHook({
          env,
          log: () => {},
          prompt: async (question) => {
            questions.push(question);
            return question.includes("Channel IDs")
              ? "C012AB3CD,C987ZY6XW"
              : "U01ABC2DEF3";
          },
        }),
      },
    ]);
    const hook = slackManifest.hooks.find((entry) => entry.id === "slack-config-prompt");

    if (!hook) throw new Error("missing Slack config-prompt hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "slack",
      }),
    ).resolves.toMatchObject({
      outputs: {
        allowedUsers: {
          kind: "config",
          value: "U01ABC2DEF3",
        },
        allowedChannels: {
          kind: "config",
          value: "C012AB3CD,C987ZY6XW",
        },
      },
    });
    expect(questions).toEqual([
      "  Slack Member IDs (comma-separated allowlist): ",
      "  Slack Channel IDs (comma-separated allowlist): ",
    ]);
    expect(env.SLACK_ALLOWED_USERS).toBe("U01ABC2DEF3");
    expect(env.SLACK_ALLOWED_CHANNELS).toBe("C012AB3CD,C987ZY6XW");
  });

  it("logs existing config values without reprompting", async () => {
    const logs: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
        handler: createConfigPromptHook({
          env: {
            TELEGRAM_REQUIRE_MENTION: "1",
            TELEGRAM_ALLOWED_IDS: "123456789",
          },
          log: (message) => logs.push(message),
          prompt: async () => {
            throw new Error("existing config should not reprompt");
          },
        }),
      },
    ]);
    const hook = telegramManifest.hooks.find(
      (entry) => entry.id === "telegram-config-prompt",
    );

    if (!hook) throw new Error("missing Telegram config-prompt hook");

    await runMessagingHook(hook, registry, {
      channelId: "telegram",
    });

    expect(logs.join("\n")).toContain("reply mode already set: @mentions only");
    expect(logs.join("\n")).toContain("allowed IDs already set: 123456789");
  });

  it("records existing config but does not prompt for missing config in non-interactive mode", async () => {
    const env: NodeJS.ProcessEnv = {
      SLACK_ALLOWED_USERS: "U01ABC2DEF3",
    };
    const logs: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
        handler: createConfigPromptHook({
          env,
          log: (message) => logs.push(message),
          prompt: async () => {
            throw new Error("non-interactive config hook should not prompt");
          },
        }),
      },
    ]);
    const hook = slackManifest.hooks.find((entry) => entry.id === "slack-config-prompt");

    if (!hook) throw new Error("missing Slack config-prompt hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "slack",
        isInteractive: false,
      }),
    ).resolves.toMatchObject({
      outputs: {
        allowedUsers: {
          kind: "config",
          value: "U01ABC2DEF3",
        },
      },
    });
    expect(env.SLACK_ALLOWED_CHANNELS).toBeUndefined();
    expect(logs.join("\n")).toContain("allowed IDs already set: U01ABC2DEF3");
  });
});
