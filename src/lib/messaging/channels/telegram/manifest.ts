// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const telegramManifest = {
  schemaVersion: 1,
  id: "telegram",
  displayName: "Telegram",
  description: "Telegram bot messaging",
  enrollmentNotes: [
    "For Telegram group chats, disable privacy mode in @BotFather (/setprivacy -> your bot -> Disable).",
    "After changing privacy mode, remove and re-add the bot to each group before testing @mentions.",
  ],
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "TELEGRAM_BOT_TOKEN",
      prompt: {
        label: "Telegram Bot Token",
        help: "Create a bot via @BotFather on Telegram, then copy the token.",
      },
    },
    {
      id: "allowedIds",
      kind: "config",
      required: false,
      envKey: "TELEGRAM_ALLOWED_IDS",
      statePath: "allowedIds.telegram",
      prompt: {
        label: "Telegram User ID (for DM access)",
        help: "Send /start to @userinfobot on Telegram to get your numeric user ID.",
        emptyValueMessage: "bot will require manual pairing",
      },
    },
    {
      id: "requireMention",
      kind: "config",
      required: false,
      envKey: "TELEGRAM_REQUIRE_MENTION",
      statePath: "telegramConfig.requireMention",
      validValues: ["0", "1"],
      prompt: {
        label: "Telegram group mention mode",
        help: "Controls Telegram group-chat behavior only — reply only when @mentioned vs. to all group messages. Direct messages are unaffected by this setting and remain subject to pairing and TELEGRAM_ALLOWED_IDS.",
      },
    },
  ],
  credentials: [
    {
      id: "telegramBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-telegram-bridge",
      providerEnvKey: "TELEGRAM_BOT_TOKEN",
      placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    },
  ],
  policyPresets: [
    {
      name: "telegram",
      policyKeys: ["telegram_bot"],
      agentPolicyKeys: {
        hermes: ["telegram"],
      },
    },
  ],
  render: [
    {
      id: "telegram-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.telegram",
        value: {
          enabled: true,
          accounts: {
            default: {
              botToken: "{{credential.telegramBotToken.placeholder}}",
              enabled: true,
              healthMonitor: {
                enabled: false,
              },
              proxy: "{{proxyUrl}}",
              groupPolicy: "open",
              dmPolicy: "{{allowedIds.telegram.dmPolicy}}",
              allowFrom: "{{allowedIds.telegram.values}}",
            },
          },
        },
      },
    },
    {
      id: "telegram-openclaw-groups",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      when: "{{telegramConfig.requireMention}}",
      fragment: {
        path: "channels.telegram.groups",
        value: {
          "*": {
            requireMention: "{{telegramConfig.requireMention}}",
          },
        },
      },
    },
    {
      id: "telegram-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.telegram",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "telegram-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "TELEGRAM_BOT_TOKEN={{credential.telegramBotToken.placeholder}}",
        "TELEGRAM_ALLOWED_USERS={{allowedIds.telegram.csv}}",
      ],
    },
    {
      id: "telegram-hermes-config",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "telegram",
        value: {
          require_mention: "{{telegramConfig.requireMention}}",
        },
      },
    },
    {
      id: "telegram-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.telegram",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      visibility: {
        configKeys: ["telegram"],
        logPatterns: ["telegram"],
      },
      nodePreloads: [
        {
          module: "telegram-diagnostics",
          injectInto: ["boot", "connect"],
          optional: false,
          installMessage:
            "[channels] Installing Telegram diagnostics (provider readiness + inference errors)",
          installedMessage: "[channels] Telegram diagnostics installed (NODE_OPTIONS updated)",
        },
      ],
    },
  },
  state: {
    persist: {
      allowedIds: ["allowedIds"],
      telegramConfig: ["requireMention"],
    },
    rebuildHydration: [
      {
        statePath: "allowedIds.telegram",
        env: "TELEGRAM_ALLOWED_IDS",
      },
      {
        statePath: "telegramConfig.requireMention",
        env: "TELEGRAM_REQUIRE_MENTION",
      },
    ],
  },
  hooks: [
    {
      id: "telegram-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "telegram-allowlist-aliases",
      phase: "enroll",
      handler: "telegram.allowlistAliases",
      outputs: [
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
    },
    {
      id: "telegram-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "requireMention",
          kind: "config",
        },
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
    },
    {
      id: "telegram-get-me-reachability",
      phase: "reachability-check",
      handler: "telegram.getMeReachability",
      inputs: ["botToken"],
      onFailure: "skip-channel",
    },
    {
      id: "telegram-openclaw-bridge-health",
      phase: "health-check",
      handler: "telegram.openclawBridgeHealth",
      agents: ["openclaw"],
      onFailure: "abort",
    },
    {
      id: "telegram-gateway-conflict-status",
      phase: "status",
      handler: "telegram.gatewayConflictStatus",
      outputs: [
        {
          id: "bridgeHealth",
          kind: "status",
        },
      ],
    },
  ],
} as const satisfies ChannelManifest;
