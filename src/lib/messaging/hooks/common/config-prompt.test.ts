// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { discordManifest, slackManifest, telegramManifest, whatsappManifest } from "../../channels";
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

// The manifest owns this hook, so resolve it once here. Failing at module load
// rather than inside the helper keeps the helper free of a setup branch.
const WHATSAPP_CONFIG_PROMPT_HOOK =
  whatsappManifest.hooks.find((entry) => entry.id === "whatsapp-config-prompt") ??
  (() => {
    throw new Error("missing WhatsApp config-prompt hook");
  })();

describe("WhatsApp reply mode prompt", () => {
  function whatsappRun(options: {
    readonly env: NodeJS.ProcessEnv;
    readonly answer?: string;
    readonly questions?: string[];
    readonly logs?: string[];
  }) {
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
        handler: createConfigPromptHook({
          env: options.env,
          log: (message) => options.logs?.push(message),
          // A test that expects no prompt asserts on the recorded questions
          // instead of throwing from here.
          prompt: async (question) => {
            options.questions?.push(question);
            return options.answer ?? "";
          },
        }),
      },
    ]);

    return runMessagingHook(WHATSAPP_CONFIG_PROMPT_HOOK, registry, { channelId: "whatsapp" });
  }

  it("offers both modes and names the default it falls back to (#8312)", async () => {
    const env: NodeJS.ProcessEnv = {};
    const questions: string[] = [];
    const logs: string[] = [];

    await expect(whatsappRun({ env, answer: "", questions, logs })).resolves.toMatchObject({
      outputs: {
        mode: {
          kind: "config",
          value: "self-chat",
        },
      },
    });
    expect(questions).toEqual(["  WhatsApp reply mode [self-chat/bot; default: self-chat]: "]);
    expect(env.WHATSAPP_MODE).toBe("self-chat");
    // The operator has to learn what bot mode changes before choosing it.
    expect(logs.join("\n")).toContain("hermes pairing approve whatsapp <code>");
  });

  it("records bot mode when the operator selects it (#8312)", async () => {
    const env: NodeJS.ProcessEnv = {};

    await expect(whatsappRun({ env, answer: "bot" })).resolves.toMatchObject({
      outputs: {
        mode: {
          kind: "config",
          value: "bot",
        },
      },
    });
    expect(env.WHATSAPP_MODE).toBe("bot");
  });

  it("keeps the sandbox on self-chat when the answer is not a supported mode (#8312)", async () => {
    const env: NodeJS.ProcessEnv = {};
    const logs: string[] = [];

    // Nothing is recorded, so the render falls back to the adapter default
    // rather than sealing a mode the bridge cannot serve.
    await expect(whatsappRun({ env, answer: "broadcast", logs })).resolves.toMatchObject({
      outputs: {},
    });
    expect(env.WHATSAPP_MODE).toBeUndefined();
    expect(logs.join("\n")).toContain("the sandbox replies only in your own self-chat");
  });

  it("accepts a mode supplied through the environment without prompting (#8312)", async () => {
    const env: NodeJS.ProcessEnv = { WHATSAPP_MODE: "bot" };
    const questions: string[] = [];
    const logs: string[] = [];

    await expect(whatsappRun({ env, questions, logs })).resolves.toMatchObject({
      outputs: {
        mode: {
          kind: "config",
          value: "bot",
        },
      },
    });
    // The documented non-interactive path must stay silent.
    expect(questions).toEqual([]);
    expect(logs.join("\n")).toContain("WhatsApp reply mode already set: bot");
  });
});
