// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const discordManifest = {
  schemaVersion: 1,
  id: "discord",
  displayName: "Discord",
  description: "Discord bot messaging",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "DISCORD_BOT_TOKEN",
      formatPattern: "^(?!<your-discord-bot-token>$)\\S+$",
      formatHint: "Replace the documentation placeholder with your real Discord bot token.",
      prompt: {
        label: "Discord Bot Token",
        help: "Discord Developer Portal → Applications → Bot → Reset/Copy Token.",
      },
    },
    {
      id: "serverId",
      kind: "config",
      required: false,
      envKey: "DISCORD_SERVER_ID",
      statePath: "discordGuilds.serverId",
      prompt: {
        label: "Discord Server ID (for guild workspace access)",
        help: "Enable Developer Mode in Discord, then right-click your server and copy the Server ID.",
        emptyValueMessage: "guild channels stay disabled",
      },
    },
    {
      id: "requireMention",
      kind: "config",
      required: false,
      envKey: "DISCORD_REQUIRE_MENTION",
      statePath: "discordGuilds.requireMention",
      promptWhenInput: "serverId",
      validValues: ["0", "1"],
      defaultValue: "1",
      prompt: {
        label: "Discord mention mode",
        help: "Choose whether the bot should reply only when @mentioned or to all messages in this server.",
      },
    },
    {
      id: "userId",
      kind: "config",
      required: false,
      envKey: "DISCORD_USER_ID",
      statePath: "discordGuilds.userIds",
      promptWhenInput: "serverId",
      prompt: {
        label: "Discord User ID (optional guild allowlist)",
        help: "Optional: enable Developer Mode in Discord, then right-click your user/avatar and copy the User ID. Leave blank to allow any member of the configured server to message the bot.",
        emptyValueMessage: "any member in the configured server can message the bot",
      },
    },
  ],
  credentials: [
    {
      id: "discordBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-discord-bridge",
      providerEnvKey: "DISCORD_BOT_TOKEN",
      placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    },
  ],
  policyPresets: [
    {
      name: "discord",
      // The Discord policy owns the credential binding that sets
      // DISCORD_BOT_TOKEN to a revision-scoped placeholder. The sandbox process
      // reads that environment at boot, so applying this preset afterwards is too late.
      requiredAtCreate: true,
      validationWarningLines: [
        "For Discord preset validation, do not use curl as the success signal:",
        "curl is not in the preset binary allowlist, so curl probes can fail even",
        "when the policy is working. Validate the configured messaging bridge/gateway path.",
        'DNS-only checks such as dns.resolve("gateway.discord.gg")',
        "can also be inconclusive behind a proxy.",
        "The agent-specific gateway probe prints an HTTP status when it reaches Discord.",
        "Any HTTP response confirms reachability. A transport error or OpenShell policy",
        "denial means validation failed.",
      ],
      validationWarningLinesByAgent: {
        openclaw: [
          "OpenClaw validation uses its Node runtime:",
          `node -e "require('node:https').get('https://discord.com/api/v10/gateway',r=>console.log(r.statusCode)).on('error',e=>{console.error(e.message);process.exitCode=1})"`,
        ],
        hermes: [
          "Hermes validation uses its virtual-environment Python runtime:",
          `nemohermes <name> exec -- /opt/hermes/.venv/bin/python -c "import urllib.error, urllib.request; u='https://discord.com/api/v10/gateway';\ntry: print(urllib.request.urlopen(u, timeout=20).status)\nexcept urllib.error.HTTPError as error: print(error.code)"`,
        ],
      },
    },
  ],
  render: [
    {
      id: "discord-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.discord",
        value: {
          enabled: true,
          accounts: {
            default: {
              // OpenShell sets DISCORD_BOT_TOKEN to the current revision-scoped
              // placeholder. Persisting the canonical placeholder here shadows
              // that process value and is rejected by the credential endpoint.
              enabled: true,
              healthMonitor: {
                enabled: false,
              },
              proxy: "{{discordProxyUrl}}",
              dmPolicy: "{{discord.allowedUsers.dmPolicy}}",
              allowFrom: "{{discord.allowedUsers.values}}",
            },
          },
        },
      },
    },
    {
      id: "discord-openclaw-guilds",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      when: "{{discord.hasGuilds}}",
      fragment: {
        path: "channels.discord",
        value: {
          groupPolicy: "allowlist",
          guilds: "{{discord.guilds}}",
        },
      },
    },
    {
      id: "discord-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.discord",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "discord-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "NEMOCLAW_DISCORD_GUILD_IDS={{discord.guildIds.csv}}",
        "DISCORD_ALLOWED_USERS={{discord.allowedUsers.csv}}",
        "DISCORD_ALLOW_ALL_USERS={{discord.allowAllUsers}}",
      ],
    },
    {
      id: "discord-hermes-config",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "discord",
        value: {
          require_mention: "{{discord.requireMention}}",
          free_response_channels: "",
          allowed_channels: "",
          auto_thread: true,
          reactions: true,
          channel_prompts: {},
        },
      },
    },
    {
      id: "discord-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.discord",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "discord",
      visibility: {
        configKeys: ["discord"],
        logPatterns: ["discord"],
      },
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/discord@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-tZfdC1YA8oVLvc2BK1w0F6rUljS5ugCOp2uWe0vPsbG1fbzVVIO4V32RoqZznGHe5u2R9u4n1aV5Z/qa1m2oFg==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.7.1.tgz",
      },
      required: true,
    },
  ],
  hooks: [
    {
      id: "discord-openclaw-bridge-health",
      phase: "health-check",
      handler: "discord.openclawBridgeHealth",
      agents: ["openclaw"],
      onFailure: "abort",
    },
    {
      id: "discord-token-paste",
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
      id: "discord-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "serverId",
          kind: "config",
        },
        {
          id: "requireMention",
          kind: "config",
        },
        {
          id: "userId",
          kind: "config",
        },
      ],
    },
  ],
} as const satisfies ChannelManifest;
