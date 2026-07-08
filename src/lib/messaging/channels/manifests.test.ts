// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getChannelTokenKeys, KNOWN_CHANNELS, knownChannelNames } from "../../sandbox/channels";
import { planStateUpdates } from "../compiler/engines/state-update-engine";
import {
  COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
  COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
} from "../hooks/common";
import type {
  ChannelHookSpec,
  ChannelInputSpec,
  ChannelManifest,
  ChannelRenderSpec,
  MessagingAgentId,
} from "../manifest";
import {
  BUILT_IN_CHANNEL_MANIFESTS,
  createBuiltInChannelManifestRegistry,
  discordManifest,
  getBuiltInRenderedConfigParser,
  slackManifest,
  teamsManifest,
  telegramManifest,
  wechatManifest,
  whatsappManifest,
} from "./index";
import {
  SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID,
  SLACK_SOCKET_MODE_GATEWAY_STATUS_HOOK_HANDLER_ID,
  SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID,
} from "./slack/hooks";
import {
  TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID,
  TELEGRAM_GATEWAY_CONFLICT_STATUS_HOOK_HANDLER_ID,
} from "./telegram/hooks";

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

function findHook(manifest: ChannelManifest, hookId: string): ChannelHookSpec {
  const hook = manifest.hooks.find((entry) => entry.id === hookId);
  if (!hook) throw new Error(`missing hook ${manifest.id}.${hookId}`);
  return hook;
}

function renderJson(manifest: ChannelManifest): string {
  return JSON.stringify(manifest.render);
}

function expectEnvRenderLines(
  manifest: ChannelManifest,
  renderId: string,
  lines: readonly string[],
): void {
  const render = findRender(manifest, renderId);
  expect(render).toMatchObject({
    kind: "env-lines",
    agent: "hermes",
    target: "~/.hermes/.env",
  });
  if (render.kind !== "env-lines") throw new Error(`${manifest.id}.${renderId} is not env-lines`);
  expect(render.lines).toEqual(lines);
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

function expectSlackSocketModeGatewayConflictHook(): void {
  expect(slackManifest.hooks).toContainEqual({
    id: "slack-socket-mode-gateway-conflict",
    phase: "pre-enable",
    handler: SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID,
    onFailure: "abort",
  });
}

function expectOpenClawBridgeHealthHook(
  manifest: ChannelManifest,
  hookId: string,
  handler: string,
): void {
  const hook = findHook(manifest, hookId);
  expect(hook).toMatchObject({
    id: hookId,
    phase: "health-check",
    handler,
    agents: ["openclaw"],
    onFailure: "abort",
  });
  expect(hook.outputs).toBeUndefined();
}

function expectConcreteStatusHook(
  manifest: ChannelManifest,
  hookId: string,
  handler: string,
  outputId: string,
): void {
  expect(findHook(manifest, hookId)).toMatchObject({
    id: hookId,
    phase: "status",
    handler,
    outputs: [
      {
        id: outputId,
        kind: "status",
      },
    ],
  });
}

function expectOpenClawRuntimeVisibility(
  manifest: ChannelManifest,
  configKeys: readonly string[],
  logPatterns: readonly string[],
  channelName = configKeys[0],
): void {
  expect(manifest.runtime?.openclaw?.channelName).toBe(channelName);
  expect(manifest.runtime?.openclaw?.visibility).toEqual({
    configKeys,
    logPatterns,
  });
}

function expectOpenClawNodePreload(manifest: ChannelManifest, module: string): void {
  expect(manifest.runtime?.openclaw?.nodePreloads ?? []).toEqual(
    expect.arrayContaining([expect.objectContaining({ module })]),
  );
}

describe("built-in channel manifests", () => {
  it("registers the phase-1 built-in manifests without consuming them in workflows", () => {
    const registry = createBuiltInChannelManifestRegistry();

    expect(BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => manifest.id)).toEqual(knownChannelNames());
    expect(registry.list().map((manifest) => manifest.id)).toEqual(knownChannelNames());
    expect(registry.listAvailable({ agent: "openclaw" }).map((manifest) => manifest.id)).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
    ]);
    expect(registry.listAvailable({ agent: "hermes" }).map((manifest) => manifest.id)).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
    ]);
  });

  it("keeps built-in manifests fully JSON-serializable", () => {
    expect(JSON.parse(JSON.stringify(BUILT_IN_CHANNEL_MANIFESTS))).toEqual(
      BUILT_IN_CHANNEL_MANIFESTS,
    );
  });

  it("keeps rendered config parsers aligned with built-in manifests", () => {
    expect(
      BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => [
        manifest.id,
        Boolean(getBuiltInRenderedConfigParser(manifest.id)),
      ]),
    ).toEqual(BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => [manifest.id, true]));
  });

  it("keeps rendered config parser keys limited to manifest config inputs", () => {
    const agentIds: readonly MessagingAgentId[] = ["openclaw", "hermes"];
    const secretLikePattern = /(?:token|secret|password|client_secret|client-secret)/i;
    expect(
      BUILT_IN_CHANNEL_MANIFESTS.flatMap((manifest) => {
        const configInputIds: ReadonlySet<string> = new Set(
          manifest.inputs.filter((input) => input.kind === "config").map((input) => input.id),
        );
        const parser = getBuiltInRenderedConfigParser(manifest.id);
        return agentIds.flatMap((agentId) =>
          (parser?.listConfigVisibilityKeys({ manifest, agentId, inputs: [] }) ?? [])
            .filter(
              (key) =>
                !configInputIds.has(key.inputId) ||
                secretLikePattern.test(key.envKey ?? "") ||
                secretLikePattern.test(key.target),
            )
            .map((key) => `${manifest.id}.${agentId}.${key.inputId}:${key.envKey ?? key.target}`),
        );
      }),
    ).toEqual([]);
  });

  it("keeps input compatibility aliases out of built-in manifests", () => {
    for (const manifest of BUILT_IN_CHANNEL_MANIFESTS) {
      for (const input of manifest.inputs) {
        expect(Object.hasOwn(input, "envAliases")).toBe(false);
      }
    }
  });

  it("keeps built-in config inputs durable by default", () => {
    const configInputs = BUILT_IN_CHANNEL_MANIFESTS.flatMap((manifest) =>
      manifest.inputs
        .filter((input) => input.kind === "config")
        .map((input) => ({ manifest, input })),
    );

    for (const { manifest, input } of configInputs) {
      expect(input.statePath, `${manifest.id}.${input.id}`).toBeTruthy();
    }
  });

  it("keeps phase-1 manifest and hook files free of production side-effect imports", () => {
    const manifestPaths = [
      "src/lib/messaging/channels/telegram/manifest.ts",
      "src/lib/messaging/channels/telegram/hooks/gateway-conflict-status.ts",
      "src/lib/messaging/channels/telegram/hooks/openclaw-bridge-health.ts",
      "src/lib/messaging/channels/discord/manifest.ts",
      "src/lib/messaging/channels/discord/hooks/index.ts",
      "src/lib/messaging/channels/discord/hooks/openclaw-bridge-health.ts",
      "src/lib/messaging/channels/wechat/manifest.ts",
      "src/lib/messaging/channels/wechat/hooks/health-check.ts",
      "src/lib/messaging/channels/wechat/hooks/ilink-login.ts",
      "src/lib/messaging/channels/wechat/hooks/index.ts",
      "src/lib/messaging/channels/wechat/hooks/seed-openclaw-account.ts",
      "src/lib/messaging/channels/openclaw-bridge-health.ts",
      "src/lib/messaging/channels/slack/manifest.ts",
      "src/lib/messaging/channels/slack/hooks/openclaw-bridge-health.ts",
      "src/lib/messaging/channels/slack/hooks/socket-mode-gateway-conflict.ts",
      "src/lib/messaging/channels/slack/hooks/socket-mode-gateway-status.ts",
      "src/lib/messaging/channels/slack/hooks/validate-credentials.ts",
      "src/lib/messaging/channels/whatsapp/manifest.ts",
      "src/lib/messaging/channels/teams/manifest.ts",
      "src/lib/messaging/channels/teams/hooks/host-forward-port-conflict.ts",
      "src/lib/messaging/hooks/common/config-prompt.ts",
      "src/lib/messaging/hooks/common/token-paste.ts",
    ];
    const forbiddenImports = [
      "credentials/store",
      "state/registry",
      "adapters/openshell",
      "host-qr-handlers",
      "../ext/",
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
      teams: teamsManifest,
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
    });
    expect(findInput(slackManifest, "appToken").prompt).toMatchObject({
      label: KNOWN_CHANNELS.slack.appTokenLabel,
      help: KNOWN_CHANNELS.slack.appTokenHelp,
    });
    expect(findInput(wechatManifest, "botToken").prompt).toEqual({
      label: KNOWN_CHANNELS.wechat.label,
      help: KNOWN_CHANNELS.wechat.help,
    });
    expect(findInput(teamsManifest, "clientSecret").prompt).toEqual({
      label: KNOWN_CHANNELS.teams.label,
      help: KNOWN_CHANNELS.teams.help,
    });
  });

  it("declares Telegram env keys, policy, and OpenClaw/Hermes render intent", () => {
    const botToken = findInput(telegramManifest, "botToken");
    const allowedIds = findInput(telegramManifest, "allowedIds");
    const requireMention = findInput(telegramManifest, "requireMention");
    const groupPolicy = findInput(telegramManifest, "groupPolicy");
    expect(getChannelTokenKeys(KNOWN_CHANNELS.telegram)).toEqual(["TELEGRAM_BOT_TOKEN"]);
    expect(botToken.envKey).toBe("TELEGRAM_BOT_TOKEN");
    expect(allowedIds.envKey).toBe("TELEGRAM_ALLOWED_IDS");
    expect(requireMention.envKey).toBe("TELEGRAM_REQUIRE_MENTION");
    expect(requireMention).toMatchObject({ kind: "config", defaultValue: "1" });
    expect(groupPolicy).toMatchObject({
      kind: "config",
      envKey: "TELEGRAM_GROUP_POLICY",
      statePath: "telegramConfig.groupPolicy",
      defaultValue: "open",
      validValues: ["open", "allowlist", "disabled"],
    });
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
    expectEnvRenderLines(telegramManifest, "telegram-hermes-env", [
      "TELEGRAM_BOT_TOKEN={{credential.telegramBotToken.placeholder}}",
      "TELEGRAM_ALLOWED_USERS={{allowedIds.telegram.csv}}",
    ]);
    expect(renderJson(telegramManifest)).toContain('"path":"channels.telegram"');
    expect(renderJson(telegramManifest)).toContain('"accounts"');
    expect(renderJson(telegramManifest)).toContain("groupPolicy");
    expect(renderJson(telegramManifest)).toContain("channels.telegram.groups");
    expect(renderJson(telegramManifest)).toContain("telegramConfig.requireMention");
    expect(renderJson(telegramManifest)).toContain("telegramConfig.groupPolicy");
    expect(renderJson(telegramManifest)).toContain("telegramConfig.openclawGroups");
    expect(renderJson(telegramManifest)).toContain("platforms.telegram");
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
    expect(telegramManifest.hooks).toContainEqual({
      id: "telegram-openclaw-config-prompt",
      phase: "enroll",
      handler: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
      agents: ["openclaw"],
      outputs: [
        {
          id: "groupPolicy",
          kind: "config",
        },
      ],
    });
    expectReachabilityHook(telegramManifest, ["botToken"]);
    expectOpenClawNodePreload(telegramManifest, "telegram-diagnostics");
    expect(JSON.stringify(telegramManifest.runtime?.openclaw)).toContain("telegram-diagnostics");
    expectOpenClawBridgeHealthHook(
      telegramManifest,
      "telegram-openclaw-bridge-health",
      "telegram.openclawBridgeHealth",
    );
    expectOpenClawRuntimeVisibility(telegramManifest, ["telegram"], ["telegram"]);
    expectConcreteStatusHook(
      telegramManifest,
      "telegram-gateway-conflict-status",
      TELEGRAM_GATEWAY_CONFLICT_STATUS_HOOK_HANDLER_ID,
      "bridgeHealth",
    );
  });

  it("declares Discord guild and allowlist render intent for both agents", () => {
    const botToken = findInput(discordManifest, "botToken");
    const serverId = findInput(discordManifest, "serverId");
    const requireMention = findInput(discordManifest, "requireMention");
    const userId = findInput(discordManifest, "userId");
    expect(getChannelTokenKeys(KNOWN_CHANNELS.discord)).toEqual(["DISCORD_BOT_TOKEN"]);
    expect(botToken.envKey).toBe("DISCORD_BOT_TOKEN");
    expect(serverId.envKey).toBe("DISCORD_SERVER_ID");
    expect(requireMention.envKey).toBe("DISCORD_REQUIRE_MENTION");
    expect(requireMention).toMatchObject({ kind: "config", defaultValue: "1" });
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
    expect(renderJson(discordManifest)).toContain('"path":"discord"');
    expect(renderJson(discordManifest)).toContain('"require_mention"');
    expect(renderJson(discordManifest)).toContain('"path":"platforms.discord"');
    expectEnvRenderLines(discordManifest, "discord-hermes-env", [
      "DISCORD_BOT_TOKEN={{credential.discordBotToken.placeholder}}",
      "NEMOCLAW_DISCORD_GUILD_IDS={{discord.guildIds.csv}}",
      "DISCORD_ALLOWED_USERS={{discord.allowedUsers.csv}}",
      "DISCORD_ALLOW_ALL_USERS={{discord.allowAllUsers}}",
    ]);
    expect(renderJson(discordManifest)).toContain('"path":"channels.discord"');
    expect(renderJson(discordManifest)).toContain('"accounts"');
    expect(renderJson(discordManifest)).toContain("channels.discord");
    expect(renderJson(discordManifest)).toContain("discord.guilds");
    expect(renderJson(discordManifest)).toContain("require_mention");
    expectTokenPasteEnrollHook(discordManifest, ["botToken"]);
    expectConfigPromptEnrollHook(discordManifest, ["serverId", "requireMention", "userId"]);
    expectOpenClawBridgeHealthHook(
      discordManifest,
      "discord-openclaw-bridge-health",
      "discord.openclawBridgeHealth",
    );
    expectOpenClawRuntimeVisibility(discordManifest, ["discord"], ["discord"]);
  });

  it("declares Slack Bolt-compatible placeholders and allowlist render intent", () => {
    const botToken = findInput(slackManifest, "botToken");
    const appToken = findInput(slackManifest, "appToken");
    const allowedUsers = findInput(slackManifest, "allowedUsers");
    const allowedChannels = findInput(slackManifest, "allowedChannels");
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
        primary: true,
      },
      {
        id: "slackAppToken",
        sourceInput: "appToken",
        providerName: "{sandboxName}-slack-app",
        providerEnvKey: "SLACK_APP_TOKEN",
        placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      },
    ]);
    expectEnvRenderLines(slackManifest, "slack-hermes-env", [
      "SLACK_BOT_TOKEN={{credential.slackBotToken.placeholder}}",
      "SLACK_APP_TOKEN={{credential.slackAppToken.placeholder}}",
      "SLACK_ALLOWED_USERS={{allowedIds.slack.csv}}",
      "SLACK_ALLOWED_CHANNELS={{slackConfig.allowedChannels.csv}}",
    ]);
    expect(renderJson(slackManifest)).toContain('"path":"channels.slack"');
    expect(renderJson(slackManifest)).toContain('"accounts"');
    expect(renderJson(slackManifest)).toContain("allowedIds.slack.channels");
    expectSlackSocketModeGatewayConflictHook();
    expectOpenClawNodePreload(slackManifest, "slack-channel-guard");
    expect(JSON.stringify(slackManifest.runtime?.openclaw)).toContain("slack-channel-guard");
    expect(JSON.stringify(slackManifest.runtime?.openclaw)).toContain("SLACK_BOT_TOKEN");
    expectTokenPasteEnrollHook(slackManifest, ["botToken", "appToken"]);
    expectConfigPromptEnrollHook(slackManifest, ["allowedUsers", "allowedChannels"]);
    expectSlackCredentialValidationHook(["botToken", "appToken"]);
    expectOpenClawBridgeHealthHook(
      slackManifest,
      "slack-openclaw-bridge-health",
      "slack.openclawBridgeHealth",
    );
    expectOpenClawRuntimeVisibility(slackManifest, ["slack"], ["slack"]);
    expectConcreteStatusHook(
      slackManifest,
      "slack-socket-mode-gateway-status",
      SLACK_SOCKET_MODE_GATEWAY_STATUS_HOOK_HANDLER_ID,
      "gatewayOverlaps",
    );
    expect(planStateUpdates(slackManifest)).toEqual([
      {
        channelId: "slack",
        kind: "persist-inputs",
        stateKey: "allowedIds",
        inputIds: ["allowedUsers"],
      },
      {
        channelId: "slack",
        kind: "persist-inputs",
        stateKey: "slackConfig",
        inputIds: ["allowedChannels"],
      },
      {
        channelId: "slack",
        kind: "rebuild-hydration",
        statePath: "allowedIds.slack",
        env: "SLACK_ALLOWED_USERS",
      },
      {
        channelId: "slack",
        kind: "rebuild-hydration",
        statePath: "slackConfig.allowedChannels",
        env: "SLACK_ALLOWED_CHANNELS",
      },
    ]);
  });

  it("declares WeChat host-QR hooks, state hydration, provider binding, and Hermes env intent", () => {
    const botToken = findInput(wechatManifest, "botToken");
    const accountId = findInput(wechatManifest, "accountId");
    const baseUrl = findInput(wechatManifest, "baseUrl");
    const userId = findInput(wechatManifest, "userId");
    const allowedIds = findInput(wechatManifest, "allowedIds");
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
    expect(planStateUpdates(wechatManifest)).toEqual([
      {
        channelId: "wechat",
        kind: "persist-inputs",
        stateKey: "wechatConfig",
        inputIds: ["accountId", "baseUrl", "userId"],
      },
      {
        channelId: "wechat",
        kind: "persist-inputs",
        stateKey: "allowedIds",
        inputIds: ["allowedIds"],
      },
      {
        channelId: "wechat",
        kind: "rebuild-hydration",
        statePath: "wechatConfig.accountId",
        env: "WECHAT_ACCOUNT_ID",
      },
      {
        channelId: "wechat",
        kind: "rebuild-hydration",
        statePath: "wechatConfig.baseUrl",
        env: "WECHAT_BASE_URL",
      },
      {
        channelId: "wechat",
        kind: "rebuild-hydration",
        statePath: "wechatConfig.userId",
        env: "WECHAT_USER_ID",
      },
      {
        channelId: "wechat",
        kind: "rebuild-hydration",
        statePath: "allowedIds.wechat",
        env: "WECHAT_ALLOWED_IDS",
      },
    ]);
    expectEnvRenderLines(wechatManifest, "wechat-hermes-env", [
      "WEIXIN_TOKEN={{credential.wechatBotToken.placeholder}}",
      "WEIXIN_ACCOUNT_ID={{wechatConfig.accountId}}",
      "WEIXIN_BASE_URL={{wechatConfig.baseUrl}}",
      "WEIXIN_ALLOWED_USERS={{allowedIds.wechat.csv}}",
    ]);
    expect(renderJson(wechatManifest)).toContain("platforms.weixin");
    expect(renderJson(wechatManifest)).toContain("WEIXIN_TOKEN");
    expect(renderJson(wechatManifest)).toContain("credential.wechatBotToken.placeholder");
    expect(wechatManifest.agentPackages).toContainEqual({
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
      pin: true,
      integrity:
        "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==",
      tarballUrl:
        "https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.3.tgz",
      required: true,
    });
    expect(wechatManifest.hooks.map((hook) => hook.handler)).toEqual([
      "wechat.ilinkLogin",
      "common.configPrompt",
      "wechat.seedOpenClawAccount",
      "wechat.healthCheck",
    ]);
    expectOpenClawNodePreload(wechatManifest, "wechat-diagnostics");
    expect(JSON.stringify(wechatManifest.runtime?.openclaw)).toContain("wechat-diagnostics");
    expectConfigPromptEnrollHook(wechatManifest, ["allowedIds"]);
    const seedHook = wechatManifest.hooks.find(
      (hook) => hook.id === "wechat-seed-openclaw-account",
    );
    expect(seedHook?.outputs).toEqual(
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
    expect(wechatManifest.hooks.find((hook) => hook.id === "wechat-health-check")).toMatchObject({
      id: "wechat-health-check",
      phase: "health-check",
      handler: "wechat.healthCheck",
      inputs: ["wechatConfig.accountId"],
      onFailure: "abort",
    });
    expectOpenClawRuntimeVisibility(
      wechatManifest,
      ["openclaw-weixin"],
      ["wechat", "openclaw-weixin"],
    );
  });

  it("declares WhatsApp as in-sandbox QR with optional allowlist config", () => {
    const openclawRender = findRender(whatsappManifest, "whatsapp-openclaw-channel");
    const hermesRender = findRender(whatsappManifest, "whatsapp-hermes-env");

    expect(getChannelTokenKeys(KNOWN_CHANNELS.whatsapp)).toEqual([]);
    expect(whatsappManifest.auth.mode).toBe("in-sandbox-qr");
    expect(whatsappManifest.inputs).toEqual([
      expect.objectContaining({
        id: "allowedIds",
        kind: "config",
        envKey: "WHATSAPP_ALLOWED_IDS",
        statePath: "allowedIds.whatsapp",
      }),
    ]);
    expect(whatsappManifest.credentials).toEqual([]);
    expect(whatsappManifest.policyPresets).toEqual(["whatsapp"]);
    expect(openclawRender).toMatchObject({
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
    });
    expect(JSON.stringify(openclawRender)).toContain('"path":"channels.whatsapp"');
    expect(JSON.stringify(openclawRender)).toContain('"accounts"');
    expect(hermesRender).toMatchObject({
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
    });
    expectEnvRenderLines(whatsappManifest, "whatsapp-hermes-env", [
      "WHATSAPP_ENABLED=true",
      "WHATSAPP_MODE=bot",
      "WHATSAPP_ALLOWED_USERS={{allowedIds.whatsapp.csv}}",
    ]);
    expect(renderJson(whatsappManifest)).toContain("platforms.whatsapp");
    expect(renderJson(whatsappManifest)).not.toContain("WHATSAPP_BOT_TOKEN");
    expect(renderJson(whatsappManifest)).not.toContain("openshell:resolve:env:WHATSAPP");
    expectOpenClawNodePreload(whatsappManifest, "whatsapp-qr-compact");
    expect(JSON.stringify(whatsappManifest.runtime?.openclaw)).toContain("whatsapp-qr-compact");
    expectOpenClawRuntimeVisibility(whatsappManifest, ["whatsapp"], ["whatsapp"]);
  });

  it("declares Microsoft Teams Bot Framework config for both agents", () => {
    const appId = findInput(teamsManifest, "appId");
    const clientSecret = findInput(teamsManifest, "clientSecret");
    const tenantId = findInput(teamsManifest, "tenantId");
    const allowedUsers = findInput(teamsManifest, "allowedUsers");
    const webhookPort = findInput(teamsManifest, "webhookPort");
    const requireMention = findInput(teamsManifest, "requireMention");

    expect(() => findInput(teamsManifest, "groupPolicy")).toThrow(
      /missing input teams\.groupPolicy/,
    );
    expect(getChannelTokenKeys(KNOWN_CHANNELS.teams)).toEqual(["MSTEAMS_APP_PASSWORD"]);
    expect(teamsManifest.description).toContain("experimental");
    expect(appId.envKey).toBe("MSTEAMS_APP_ID");
    expect(clientSecret.envKey).toBe("MSTEAMS_APP_PASSWORD");
    expect(clientSecret.statePath).toBeUndefined();
    expect(tenantId.envKey).toBe("MSTEAMS_TENANT_ID");
    expect(allowedUsers.envKey).toBe("TEAMS_ALLOWED_USERS");
    expect(allowedUsers.required).toBe(false);
    expect(webhookPort.envKey).toBe("MSTEAMS_PORT");
    expect(webhookPort).toMatchObject({ kind: "config", defaultValue: "3978" });
    expect(requireMention.envKey).toBe("TEAMS_REQUIRE_MENTION");
    expect(requireMention.validValues).toEqual(["0", "1"]);
    expect(requireMention).toMatchObject({ kind: "config", defaultValue: "1" });
    expect(KNOWN_CHANNELS.teams.allowIdsMode).toBe("dm");
    expect(teamsManifest.credentials).toEqual([
      {
        id: "teamsClientSecret",
        sourceInput: "clientSecret",
        providerName: "{sandboxName}-teams-bridge",
        providerEnvKey: "MSTEAMS_APP_PASSWORD",
        placeholder: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
        primary: true,
      },
    ]);
    expect(policyPresetNames(teamsManifest)).toEqual(["teams"]);
    expect(teamsManifest.hostForward).toEqual({
      port: "{{teamsConfig.webhookPort}}",
      label: "Microsoft Teams webhook",
    });
    expect(findHook(teamsManifest, "teams-host-forward-port-conflict")).toMatchObject({
      phase: "pre-enable",
      handler: "teams.hostForwardPortConflict",
      inputs: ["webhookPort"],
      onFailure: "abort",
    });
    expectConcreteStatusHook(
      teamsManifest,
      "teams-host-forward-port-status",
      "teams.hostForwardPortStatus",
      "hostForwardPortOverlaps",
    );
    expectEnvRenderLines(teamsManifest, "teams-hermes-env", [
      "TEAMS_CLIENT_ID={{teamsConfig.appId}}",
      "TEAMS_CLIENT_SECRET={{credential.teamsClientSecret.placeholder}}",
      "TEAMS_TENANT_ID={{teamsConfig.tenantId}}",
      "TEAMS_ALLOWED_USERS={{allowedIds.teams.csv}}",
      "TEAMS_PORT={{teamsConfig.webhookPort}}",
    ]);
    expect(renderJson(teamsManifest)).toContain('"path":"channels.msteams"');
    expect(renderJson(teamsManifest)).toContain('"path":"plugins.entries.msteams"');
    expect(renderJson(teamsManifest)).toContain('"path":"platforms.teams"');
    expect(renderJson(teamsManifest)).toContain("credential.teamsClientSecret.placeholder");
    expect(renderJson(teamsManifest)).toContain("teamsConfig.webhookPort");
    expect(renderJson(teamsManifest)).toContain('"streaming":{"mode":"off"}');
    expect(renderJson(teamsManifest)).toContain('"groupPolicy":"open"');
    expect(renderJson(teamsManifest)).not.toContain("groupAllowFrom");
    expectTokenPasteEnrollHook(teamsManifest, ["clientSecret"]);
    expect(findHook(teamsManifest, "teams-config-prompt")).toMatchObject({
      phase: "enroll",
      handler: COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
      outputs: [
        {
          id: "appId",
          kind: "config",
          required: true,
        },
        {
          id: "tenantId",
          kind: "config",
          required: true,
        },
        {
          id: "allowedUsers",
          kind: "config",
        },
        {
          id: "webhookPort",
          kind: "config",
        },
        {
          id: "requireMention",
          kind: "config",
        },
      ],
    });
    expectOpenClawRuntimeVisibility(teamsManifest, ["msteams"], ["msteams", "teams"], "msteams");
    expectOpenClawNodePreload(teamsManifest, "msteams-message-hints");
    expect(teamsManifest.agentPackages).toContainEqual({
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/msteams@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.6.10":
          "sha512-GjHnCPvjbnI0C7mEFcdT2uKDH4/WwOe2dZBfQiWxBtkE76m6TNG0J9dJjD4mc8/pk8rXSO0cWw+KV9jzWtF9VA==",
      },
      tarballUrlByVersion: {
        "2026.6.10": "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.6.10.tgz",
      },
      required: true,
    });
    expect(teamsManifest.agentPackages).toContainEqual({
      id: "hermesTeamsAppsPackage",
      agent: "hermes",
      manager: "hermes-uv-pip",
      spec: "microsoft-teams-apps==2.0.13.4",
      required: true,
    });
    expect(teamsManifest.agentPackages).toContainEqual({
      id: "hermesAiohttpPackage",
      agent: "hermes",
      manager: "hermes-uv-pip",
      spec: "aiohttp==3.14.1",
      required: true,
    });
    expect(planStateUpdates(teamsManifest)).toEqual([
      {
        channelId: "teams",
        kind: "persist-inputs",
        stateKey: "teamsConfig",
        inputIds: ["appId", "tenantId", "webhookPort", "requireMention"],
      },
      {
        channelId: "teams",
        kind: "persist-inputs",
        stateKey: "allowedIds",
        inputIds: ["allowedUsers"],
      },
      {
        channelId: "teams",
        kind: "rebuild-hydration",
        statePath: "teamsConfig.appId",
        env: "MSTEAMS_APP_ID",
      },
      {
        channelId: "teams",
        kind: "rebuild-hydration",
        statePath: "teamsConfig.tenantId",
        env: "MSTEAMS_TENANT_ID",
      },
      {
        channelId: "teams",
        kind: "rebuild-hydration",
        statePath: "allowedIds.teams",
        env: "TEAMS_ALLOWED_USERS",
      },
      {
        channelId: "teams",
        kind: "rebuild-hydration",
        statePath: "teamsConfig.webhookPort",
        env: "MSTEAMS_PORT",
      },
      {
        channelId: "teams",
        kind: "rebuild-hydration",
        statePath: "teamsConfig.requireMention",
        env: "TEAMS_REQUIRE_MENTION",
      },
    ]);
  });
});
