// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildDiscordConfig,
  buildMessagingEnvLines,
} from "../../../../agents/hermes/config/messaging-config.ts";
import { getChannelTokenKeys, KNOWN_CHANNELS, knownChannelNames } from "../../sandbox/channels";
import {
  COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
  COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
} from "../hooks/common";
import { SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID } from "./slack/hooks";
import { TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID } from "./telegram/hooks";
import type { ChannelInputSpec, ChannelManifest, ChannelRenderSpec } from "../manifest";
import {
  BUILT_IN_CHANNEL_MANIFESTS,
  createBuiltInChannelManifestRegistry,
  discordManifest,
  slackManifest,
  telegramManifest,
  wechatManifest,
  whatsappManifest,
} from "./index";

function findInput(manifest: ChannelManifest, inputId: string): ChannelInputSpec {
  const input = manifest.inputs.find((entry) => entry.id === inputId);
  if (!input) throw new Error(`missing input ${manifest.id}.${inputId}`);
  return input;
}

function findRender(manifest: ChannelManifest, renderId: string): ChannelRenderSpec {
  const render = manifest.render.find((entry) => entry.id === renderId);
  if (!render) throw new Error(`missing render ${manifest.id}.${renderId}`);
  return render;
}

function renderJson(manifest: ChannelManifest): string {
  return JSON.stringify(manifest.render);
}

function policyPresetNames(manifest: ChannelManifest): string[] {
  return (manifest.policyPresets ?? []).map((preset) =>
    typeof preset === "string" ? preset : preset.name,
  );
}

function expectTokenPasteEnrollHook(manifest: ChannelManifest, outputIds: readonly string[]): void {
  expect(manifest.hooks).toContainEqual({
    id: `${manifest.id}-token-paste`,
    phase: "enroll",
    handler: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
    outputs: outputIds.map((id) => ({
      id,
      kind: "secret",
      required: true,
    })),
    onFailure: "skip-channel",
  });
}

function expectConfigPromptEnrollHook(
  manifest: ChannelManifest,
  outputIds: readonly string[],
): void {
  expect(manifest.hooks).toContainEqual({
    id: `${manifest.id}-config-prompt`,
    phase: "enroll",
    handler: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
    outputs: outputIds.map((id) => ({
      id,
      kind: "config",
    })),
  });
}

function expectReachabilityHook(manifest: ChannelManifest, inputIds: readonly string[]): void {
  expect(manifest.hooks).toContainEqual({
    id: `${manifest.id}-get-me-reachability`,
    phase: "reachability-check",
    handler: `${manifest.id}.getMeReachability`,
    inputs: inputIds,
    onFailure: "skip-channel",
  });
}

function expectSlackCredentialValidationHook(inputIds: readonly string[]): void {
  expect(slackManifest.hooks).toContainEqual({
    id: "slack-credential-validation",
    phase: "reachability-check",
    handler: SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID,
    inputs: inputIds,
    onFailure: "skip-channel",
  });
}

describe("built-in channel manifests", () => {
  it("registers the phase-1 built-in manifests without consuming them in workflows", () => {
    const registry = createBuiltInChannelManifestRegistry();

    expect(BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => manifest.id)).toEqual(
      knownChannelNames(),
    );
    expect(registry.list().map((manifest) => manifest.id)).toEqual(knownChannelNames());
    expect(registry.listAvailable({ agent: "openclaw" }).map((manifest) => manifest.id)).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
    ]);
    expect(registry.listAvailable({ agent: "hermes" }).map((manifest) => manifest.id)).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
    ]);
  });

  it("keeps built-in manifests fully JSON-serializable", () => {
    expect(JSON.parse(JSON.stringify(BUILT_IN_CHANNEL_MANIFESTS))).toEqual(
      BUILT_IN_CHANNEL_MANIFESTS,
    );
  });

  it("keeps phase-1 manifest and hook files free of production side-effect imports", () => {
    const manifestPaths = [
      "src/lib/messaging/channels/telegram/manifest.ts",
      "src/lib/messaging/channels/discord/manifest.ts",
      "src/lib/messaging/channels/wechat/manifest.ts",
      "src/lib/messaging/channels/wechat/hooks/health-check.ts",
      "src/lib/messaging/channels/wechat/hooks/ilink-login.ts",
      "src/lib/messaging/channels/wechat/hooks/index.ts",
      "src/lib/messaging/channels/wechat/hooks/seed-openclaw-account.ts",
      "src/lib/messaging/channels/slack/manifest.ts",
      "src/lib/messaging/channels/slack/hooks/validate-credentials.ts",
      "src/lib/messaging/channels/whatsapp/manifest.ts",
      "src/lib/messaging/hooks/common/config-prompt.ts",
      "src/lib/messaging/hooks/common/token-paste.ts",
    ];
    const forbiddenImports = [
      "credentials/store",
      "state/registry",
      "adapters/openshell",
      "host-qr-handlers",
      "ext/wechat",
      "node:fs",
      "node:child_process",
    ];

    for (const manifestPath of manifestPaths) {
      const source = readFileSync(manifestPath, "utf8");
      for (const forbiddenImport of forbiddenImports) {
        expect(source).not.toContain(forbiddenImport);
      }
    }
  });

  it("matches current sandbox channel metadata for prompts, auth, and policy presets", () => {
    const manifests = {
      telegram: telegramManifest,
      discord: discordManifest,
      wechat: wechatManifest,
      slack: slackManifest,
      whatsapp: whatsappManifest,
    };

    for (const [channelId, manifest] of Object.entries(manifests)) {
      const legacy = KNOWN_CHANNELS[channelId];
      expect(manifest.description).toBe(legacy.description);
      expect(policyPresetNames(manifest)).toEqual([channelId]);
      expect(manifest.supportedAgents).toEqual(["openclaw", "hermes"]);
      expect(manifest.auth.mode).toBe(legacy.loginMethod ?? "token-paste");
    }

    expect(findInput(telegramManifest, "botToken").prompt).toEqual({
      label: KNOWN_CHANNELS.telegram.label,
      help: KNOWN_CHANNELS.telegram.help,
    });
    expect(findInput(discordManifest, "botToken").prompt).toEqual({
      label: KNOWN_CHANNELS.discord.label,
      help: KNOWN_CHANNELS.discord.help,
    });
    expect(findInput(slackManifest, "botToken").prompt).toMatchObject({
      label: KNOWN_CHANNELS.slack.label,
      help: KNOWN_CHANNELS.slack.help,
      placeholder: "xoxb-...",
    });
    expect(findInput(slackManifest, "appToken").prompt).toMatchObject({
      label: KNOWN_CHANNELS.slack.appTokenLabel,
      help: KNOWN_CHANNELS.slack.appTokenHelp,
      placeholder: "xapp-...",
    });
    expect(findInput(wechatManifest, "botToken").prompt).toEqual({
      label: KNOWN_CHANNELS.wechat.label,
      help: KNOWN_CHANNELS.wechat.help,
    });
  });

  it("declares Telegram env keys, policy, and OpenClaw/Hermes render intent", () => {
    const botToken = findInput(telegramManifest, "botToken");
    const allowedIds = findInput(telegramManifest, "allowedIds");
    const requireMention = findInput(telegramManifest, "requireMention");
    const hermesLines = buildMessagingEnvLines(
      new Set(["telegram"]),
      { telegram: ["123456789"] },
      {},
      {},
      {},
    );

    expect(getChannelTokenKeys(KNOWN_CHANNELS.telegram)).toEqual(["TELEGRAM_BOT_TOKEN"]);
    expect(botToken.envKey).toBe("TELEGRAM_BOT_TOKEN");
    expect(allowedIds.envKey).toBe("TELEGRAM_ALLOWED_IDS");
    expect(requireMention.envKey).toBe("TELEGRAM_REQUIRE_MENTION");
    expect(KNOWN_CHANNELS.telegram.allowIdsMode).toBe("dm");
    expect(telegramManifest.credentials).toEqual([
      {
        id: "telegramBotToken",
        sourceInput: "botToken",
        providerName: "{sandboxName}-telegram-bridge",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      },
    ]);
    expect(hermesLines).toContain(
      "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    );
    expect(hermesLines).toContain("TELEGRAM_ALLOWED_USERS=123456789");
    expect(renderJson(telegramManifest)).toContain("channels.telegram.accounts.default");
    expect(renderJson(telegramManifest)).toContain("groupPolicy");
    expect(renderJson(telegramManifest)).toContain("channels.telegram.groups");
    expect(renderJson(telegramManifest)).toContain("telegramConfig.requireMention");
    expectTokenPasteEnrollHook(telegramManifest, ["botToken"]);
    expect(telegramManifest.hooks).toContainEqual({
      id: "telegram-allowlist-aliases",
      phase: "enroll",
      handler: TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID,
      outputs: [
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
    });
    expectConfigPromptEnrollHook(telegramManifest, ["requireMention", "allowedIds"]);
    expectReachabilityHook(telegramManifest, ["botToken"]);
  });

  it("declares Discord guild and allowlist render intent for both agents", () => {
    const botToken = findInput(discordManifest, "botToken");
    const serverId = findInput(discordManifest, "serverId");
    const requireMention = findInput(discordManifest, "requireMention");
    const userId = findInput(discordManifest, "userId");
    const hermesLines = buildMessagingEnvLines(
      new Set(["discord"]),
      {},
      {
        "1491590992753590594": {
          requireMention: false,
          users: ["1005536447329222676"],
        },
      },
      {},
      {},
    );

    expect(getChannelTokenKeys(KNOWN_CHANNELS.discord)).toEqual(["DISCORD_BOT_TOKEN"]);
    expect(botToken.envKey).toBe("DISCORD_BOT_TOKEN");
    expect(serverId.envKey).toBe("DISCORD_SERVER_ID");
    expect(requireMention.envKey).toBe("DISCORD_REQUIRE_MENTION");
    expect(userId.envKey).toBe("DISCORD_USER_ID");
    expect(KNOWN_CHANNELS.discord.allowIdsMode).toBe("guild");
    expect(discordManifest.credentials).toEqual([
      {
        id: "discordBotToken",
        sourceInput: "botToken",
        providerName: "{sandboxName}-discord-bridge",
        providerEnvKey: "DISCORD_BOT_TOKEN",
        placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
      },
    ]);
    expect(buildDiscordConfig({ "1491590992753590594": { requireMention: false } })).toEqual({
      require_mention: false,
      free_response_channels: "",
      allowed_channels: "",
      auto_thread: true,
      reactions: true,
      channel_prompts: {},
    });
    expect(hermesLines).toContain(
      "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN",
    );
    expect(hermesLines).toContain("NEMOCLAW_DISCORD_GUILD_IDS=1491590992753590594");
    expect(hermesLines).toContain("DISCORD_ALLOWED_USERS=1005536447329222676");
    expect(renderJson(discordManifest)).toContain("channels.discord.accounts.default");
    expect(renderJson(discordManifest)).toContain("channels.discord");
    expect(renderJson(discordManifest)).toContain("discord.guilds");
    expect(renderJson(discordManifest)).toContain("require_mention");
    expectTokenPasteEnrollHook(discordManifest, ["botToken"]);
    expectConfigPromptEnrollHook(discordManifest, ["serverId", "requireMention", "userId"]);
  });

  it("declares Slack Bolt-compatible placeholders and allowlist render intent", () => {
    const botToken = findInput(slackManifest, "botToken");
    const appToken = findInput(slackManifest, "appToken");
    const allowedUsers = findInput(slackManifest, "allowedUsers");
    const allowedChannels = findInput(slackManifest, "allowedChannels");
    const hermesLines = buildMessagingEnvLines(
      new Set(["slack"]),
      { slack: ["U0123456789"] },
      {},
      {},
      {},
    );

    expect(getChannelTokenKeys(KNOWN_CHANNELS.slack)).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);
    expect(botToken.envKey).toBe("SLACK_BOT_TOKEN");
    expect(appToken.envKey).toBe("SLACK_APP_TOKEN");
    expect(allowedUsers.envKey).toBe("SLACK_ALLOWED_USERS");
    expect(allowedChannels.envKey).toBe("SLACK_ALLOWED_CHANNELS");
    expect(allowedChannels.statePath).toBe("slackConfig.allowedChannels");
    expect(allowedChannels.prompt).toEqual({
      label: "Slack Channel IDs (comma-separated allowlist)",
      help: "Optional: enter comma-separated Slack channel IDs where the bot may answer @mentions. Channel IDs look like C012AB3CD.",
      emptyValueMessage: "channel @mentions stay unrestricted by channel ID",
    });
    expect(KNOWN_CHANNELS.slack.allowIdsMode).toBe("dm");
    expect(slackManifest.credentials).toEqual([
      {
        id: "slackBotToken",
        sourceInput: "botToken",
        providerName: "{sandboxName}-slack-bridge",
        providerEnvKey: "SLACK_BOT_TOKEN",
        placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      },
      {
        id: "slackAppToken",
        sourceInput: "appToken",
        providerName: "{sandboxName}-slack-app",
        providerEnvKey: "SLACK_APP_TOKEN",
        placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      },
    ]);
    expect(hermesLines).toContain(
      "SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    );
    expect(hermesLines).toContain(
      "SLACK_APP_TOKEN=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    );
    expect(hermesLines).toContain("SLACK_ALLOWED_USERS=U0123456789");
    expect(renderJson(slackManifest)).toContain("channels.slack.accounts.default");
    expect(renderJson(slackManifest)).toContain("allowedIds.slack.channels");
    expectTokenPasteEnrollHook(slackManifest, ["botToken", "appToken"]);
    expectConfigPromptEnrollHook(slackManifest, ["allowedUsers", "allowedChannels"]);
    expectSlackCredentialValidationHook(["botToken", "appToken"]);
    expect(slackManifest.state).toEqual({
      persist: {
        allowedIds: ["allowedUsers"],
        slackConfig: ["allowedChannels"],
      },
      rebuildHydration: [
        {
          statePath: "allowedIds.slack",
          env: "SLACK_ALLOWED_USERS",
        },
        {
          statePath: "slackConfig.allowedChannels",
          env: "SLACK_ALLOWED_CHANNELS",
        },
      ],
    });
  });

  it("declares WeChat host-QR hooks, state hydration, provider binding, and Hermes env intent", () => {
    const botToken = findInput(wechatManifest, "botToken");
    const accountId = findInput(wechatManifest, "accountId");
    const baseUrl = findInput(wechatManifest, "baseUrl");
    const userId = findInput(wechatManifest, "userId");
    const allowedIds = findInput(wechatManifest, "allowedIds");
    const hermesLines = buildMessagingEnvLines(
      new Set(["wechat"]),
      { wechat: ["bot_other_friend"] },
      {},
      {
        accountId: "test_account_42",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "operator_self_id",
      },
      {},
    );

    expect(getChannelTokenKeys(KNOWN_CHANNELS.wechat)).toEqual(["WECHAT_BOT_TOKEN"]);
    expect(wechatManifest.auth.mode).toBe("host-qr");
    expect(botToken.envKey).toBe("WECHAT_BOT_TOKEN");
    expect(accountId.envKey).toBe("WECHAT_ACCOUNT_ID");
    expect(baseUrl.envKey).toBe("WECHAT_BASE_URL");
    expect(userId.envKey).toBe("WECHAT_USER_ID");
    expect(allowedIds.envKey).toBe("WECHAT_ALLOWED_IDS");
    expect(KNOWN_CHANNELS.wechat.allowIdsMode).toBe("dm");
    expect(wechatManifest.credentials).toEqual([
      {
        id: "wechatBotToken",
        sourceInput: "botToken",
        providerName: "{sandboxName}-wechat-bridge",
        providerEnvKey: "WECHAT_BOT_TOKEN",
        placeholder: "openshell:resolve:env:WECHAT_BOT_TOKEN",
      },
    ]);
    expect(wechatManifest.state.persist).toEqual({
      wechatConfig: ["accountId", "baseUrl", "userId"],
      allowedIds: ["allowedIds"],
    });
    expect(wechatManifest.state.rebuildHydration).toEqual([
      {
        statePath: "wechatConfig.accountId",
        env: "WECHAT_ACCOUNT_ID",
      },
      {
        statePath: "wechatConfig.baseUrl",
        env: "WECHAT_BASE_URL",
      },
      {
        statePath: "wechatConfig.userId",
        env: "WECHAT_USER_ID",
      },
      {
        statePath: "allowedIds.wechat",
        env: "WECHAT_ALLOWED_IDS",
      },
    ]);
    expect(hermesLines).toContain("WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN");
    expect(hermesLines).toContain("WEIXIN_ACCOUNT_ID=test_account_42");
    expect(hermesLines).toContain("WEIXIN_BASE_URL=https://ilinkai.wechat.com");
    expect(hermesLines).toContain("WEIXIN_ALLOWED_USERS=operator_self_id,bot_other_friend");
    expect(renderJson(wechatManifest)).toContain("WEIXIN_TOKEN");
    expect(renderJson(wechatManifest)).toContain("credential.wechatBotToken.placeholder");
    expect(wechatManifest.hooks.map((hook) => hook.handler)).toEqual([
      "wechat.ilinkLogin",
      "common.configPrompt",
      "wechat.seedOpenClawAccount",
      "wechat.healthCheck",
    ]);
    expectConfigPromptEnrollHook(wechatManifest, ["allowedIds"]);
    expect(wechatManifest.hooks[2]?.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openclawWeixinAccountFile",
          kind: "build-file",
        }),
        expect.objectContaining({
          id: "openclawConfigPatch",
          kind: "build-file",
        }),
      ]),
    );
    expect(wechatManifest.hooks[3]).toMatchObject({
      id: "wechat-health-check",
      phase: "health-check",
      handler: "wechat.healthCheck",
      inputs: ["wechatConfig.accountId"],
      onFailure: "abort",
    });
  });

  it("declares WhatsApp as in-sandbox QR with no host-side token bindings", () => {
    const openclawRender = findRender(whatsappManifest, "whatsapp-openclaw-account");
    const hermesRender = findRender(whatsappManifest, "whatsapp-hermes-env");
    const hermesLines = buildMessagingEnvLines(new Set(["whatsapp"]), {}, {}, {}, {});

    expect(getChannelTokenKeys(KNOWN_CHANNELS.whatsapp)).toEqual([]);
    expect(whatsappManifest.auth.mode).toBe("in-sandbox-qr");
    expect(whatsappManifest.inputs).toEqual([]);
    expect(whatsappManifest.credentials).toEqual([]);
    expect(whatsappManifest.policyPresets).toEqual(["whatsapp"]);
    expect(openclawRender).toMatchObject({
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
    });
    expect(JSON.stringify(openclawRender)).toContain("channels.whatsapp.accounts.default");
    expect(hermesRender).toMatchObject({
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
    });
    expect(hermesLines).toContain("WHATSAPP_ENABLED=true");
    expect(hermesLines).toContain("WHATSAPP_MODE=bot");
    expect(renderJson(whatsappManifest)).not.toContain("WHATSAPP_BOT_TOKEN");
    expect(renderJson(whatsappManifest)).not.toContain("openshell:resolve:env:WHATSAPP");
  });
});
