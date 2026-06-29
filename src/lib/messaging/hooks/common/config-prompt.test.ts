// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { discordManifest, slackManifest, telegramManifest } from "../../channels";
import { runMessagingHook } from "../hook-runner";
import { MessagingHookRegistry } from "../registry";
import { COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID, createConfigPromptHook } from "./config-prompt";

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
            if (question.includes("Reply only")) return "n";
            return "123456789";
          },
        }),
      },
    ]);
    const hook = telegramManifest.hooks.find((entry) => entry.id === "telegram-config-prompt");

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

  it("prompts the OpenClaw-only Telegram group policy hook", async () => {
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
            return "";
          },
        }),
      },
    ]);
    const hook = telegramManifest.hooks.find(
      (entry) => entry.id === "telegram-openclaw-config-prompt",
    );

    if (!hook) throw new Error("missing Telegram OpenClaw config-prompt hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "telegram",
      }),
    ).resolves.toMatchObject({
      handlerId: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
      outputs: {
        groupPolicy: {
          kind: "config",
          value: "open",
        },
      },
    });
    expect(hook.agents).toEqual(["openclaw"]);
    expect(questions).toEqual([
      "  Telegram group policy [open/allowlist/disabled; default: open]: ",
    ]);
    expect(env.TELEGRAM_GROUP_POLICY).toBe("open");
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
    const hook = discordManifest.hooks.find((entry) => entry.id === "discord-config-prompt");

    if (!hook) throw new Error("missing Discord config-prompt hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "discord",
      }),
    ).resolves.toMatchObject({
      outputs: {},
    });
    expect(questions).toEqual(["  Discord Server ID (for guild workspace access): "]);
  });

  it("uses manifest config defaults when an interactive answer is blank", async () => {
    const env: NodeJS.ProcessEnv = {};
    const questions: string[] = [];
    const handler = createConfigPromptHook({
      env,
      log: () => {},
      prompt: async (question) => {
        questions.push(question);
        return "   ";
      },
      resolveField: () => ({
        id: "messagingPort",
        envKey: "MATRIX_MESSAGING_PORT",
        label: "Messaging port",
        defaultValue: "3978",
        format: /^[0-9]+$/,
      }),
    });

    await expect(
      handler({
        channelId: "matrix",
        hookId: "matrix-config-prompt",
        phase: "enroll",
        outputDeclarations: [{ id: "messagingPort", kind: "config", required: false }],
      }),
    ).resolves.toEqual({
      outputs: {
        messagingPort: {
          kind: "config",
          value: "3978",
        },
      },
    });
    expect(questions).toEqual(["  Messaging port [default: 3978]: "]);
    expect(env.MATRIX_MESSAGING_PORT).toBe("3978");
  });

  it("uses manifest config defaults when env is unset in non-interactive mode", async () => {
    const env: NodeJS.ProcessEnv = {};
    const handler = createConfigPromptHook({
      env,
      log: () => {},
      prompt: async () => {
        throw new Error("non-interactive default should not prompt");
      },
      resolveField: () => ({
        id: "messagingPort",
        envKey: "MATRIX_MESSAGING_PORT",
        label: "Messaging port",
        defaultValue: "3978",
        format: /^[0-9]+$/,
      }),
    });

    await expect(
      handler({
        channelId: "matrix",
        hookId: "matrix-config-prompt",
        phase: "enroll",
        isInteractive: false,
        outputDeclarations: [{ id: "messagingPort", kind: "config", required: false }],
      }),
    ).resolves.toEqual({
      outputs: {
        messagingPort: {
          kind: "config",
          value: "3978",
        },
      },
    });
    expect(env.MATRIX_MESSAGING_PORT).toBe("3978");
  });

  it("shows choice sets and defaults for generic multi-choice config prompts", async () => {
    const env: NodeJS.ProcessEnv = {};
    const questions: string[] = [];
    const handler = createConfigPromptHook({
      env,
      log: () => {},
      prompt: async (question) => {
        questions.push(question);
        return "";
      },
      resolveField: () => ({
        id: "groupPolicy",
        envKey: "MATRIX_GROUP_POLICY",
        label: "Group policy",
        validValues: ["open", "allowlist", "block"],
        defaultValue: "open",
      }),
    });

    await expect(
      handler({
        channelId: "matrix",
        hookId: "matrix-config-prompt",
        phase: "enroll",
        outputDeclarations: [{ id: "groupPolicy", kind: "config", required: false }],
      }),
    ).resolves.toEqual({
      outputs: {
        groupPolicy: {
          kind: "config",
          value: "open",
        },
      },
    });
    expect(questions).toEqual(["  Group policy [open/allowlist/block; default: open]: "]);
    expect(env.MATRIX_GROUP_POLICY).toBe("open");
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
            return question.includes("Channel IDs") ? "C012AB3CD,C987ZY6XW" : "U01ABC2DEF3";
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
            TELEGRAM_GROUP_POLICY: "open",
            TELEGRAM_ALLOWED_IDS: "123456789",
          },
          log: (message) => logs.push(message),
          prompt: async () => {
            throw new Error("existing config should not reprompt");
          },
        }),
      },
    ]);
    const hook = telegramManifest.hooks.find((entry) => entry.id === "telegram-config-prompt");

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
