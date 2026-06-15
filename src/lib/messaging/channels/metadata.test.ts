// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChannelManifest, ChannelPolicyPresetReference } from "../manifest";
import {
  getMessagingChannelForCredentialEnvKey,
  getMessagingConfigEnvAliases,
  getMessagingCredentialEnvKeysByChannel,
  getMessagingPolicyKeyAliases,
  getMessagingPolicyKeysByChannel,
  getMessagingPolicyPresetValidationWarnings,
  getMessagingProviderSuffixesByChannel,
  listAvailableMessagingChannelIds,
  listMessagingConfigEnvKeys,
  listMessagingPackageInstallSpecs,
  listMessagingProviderNamesForChannel,
  listOpenClawRuntimeChannelMetadata,
  listRequiredCreateTimeMessagingPolicyPresetNames,
} from "./metadata";

describe("built-in messaging channel metadata", () => {
  it("lists available channels by agent from manifests", () => {
    expect(listAvailableMessagingChannelIds({ agent: "openclaw" })).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
    ]);
    expect(listAvailableMessagingChannelIds({ agent: "hermes" })).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
    ]);
  });

  it("resolves credential env keys, env-key ownership, and provider names", () => {
    expect(getMessagingCredentialEnvKeysByChannel()).toMatchObject({
      telegram: ["TELEGRAM_BOT_TOKEN"],
      discord: ["DISCORD_BOT_TOKEN"],
      wechat: ["WECHAT_BOT_TOKEN"],
      slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
      whatsapp: [],
    });
    expect(getMessagingChannelForCredentialEnvKey("SLACK_APP_TOKEN")).toBe("slack");
    expect(getMessagingChannelForCredentialEnvKey("WHATSAPP_ALLOWED_IDS")).toBeNull();
    expect(getMessagingProviderSuffixesByChannel()).toMatchObject({
      telegram: ["-telegram-bridge"],
      discord: ["-discord-bridge"],
      wechat: ["-wechat-bridge"],
      slack: ["-slack-bridge", "-slack-app"],
    });
    expect(listMessagingProviderNamesForChannel("demo", "slack")).toEqual([
      "demo-slack-bridge",
      "demo-slack-app",
    ]);
  });

  it("resolves config env keys and aliases from manifest inputs", () => {
    expect(listMessagingConfigEnvKeys()).toEqual([
      "TELEGRAM_ALLOWED_IDS",
      "TELEGRAM_REQUIRE_MENTION",
      "DISCORD_SERVER_ID",
      "DISCORD_REQUIRE_MENTION",
      "DISCORD_USER_ID",
      "WECHAT_ACCOUNT_ID",
      "WECHAT_BASE_URL",
      "WECHAT_USER_ID",
      "WECHAT_ALLOWED_IDS",
      "SLACK_ALLOWED_USERS",
      "SLACK_ALLOWED_CHANNELS",
      "WHATSAPP_ALLOWED_IDS",
    ]);
    expect(getMessagingConfigEnvAliases()).toEqual({
      DISCORD_SERVER_ID: ["DISCORD_SERVER_IDS"],
      DISCORD_USER_ID: ["DISCORD_ALLOWED_IDS"],
    });
  });

  it("resolves policy aliases, OpenClaw runtime keys, and package specs", () => {
    expect(getMessagingPolicyKeyAliases()).toMatchObject({
      telegram: ["telegram_bot", "telegram"],
      discord: ["discord"],
      wechat: ["wechat_bridge"],
      slack: ["slack"],
      whatsapp: ["whatsapp"],
    });
    expect(getMessagingPolicyKeysByChannel({ agent: "hermes" })).toMatchObject({
      telegram: ["telegram"],
      discord: ["discord"],
      wechat: ["wechat_bridge"],
      slack: ["slack"],
      whatsapp: ["whatsapp"],
    });
    expect(listRequiredCreateTimeMessagingPolicyPresetNames()).toEqual(["slack"]);
    expect(getMessagingPolicyPresetValidationWarnings().discord).toContain(
      "https://discord.com/api/v10/gateway or validate the configured",
    );
    expect(
      Object.fromEntries(
        listOpenClawRuntimeChannelMetadata().map((entry) => [entry.channelId, entry.configKeys]),
      ),
    ).toMatchObject({
      telegram: ["telegram"],
      discord: ["discord"],
      wechat: ["openclaw-weixin"],
      slack: ["slack"],
      whatsapp: ["whatsapp"],
    });
    expect(
      Object.fromEntries(
        listMessagingPackageInstallSpecs({ agent: "openclaw" }).map((entry) => [
          entry.channelId,
          entry.spec,
        ]),
      ),
    ).toMatchObject({
      discord: "npm:@openclaw/discord@{{openclaw.version}}",
      wechat: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
      slack: "npm:@openclaw/slack@{{openclaw.version}}",
      whatsapp: "npm:@openclaw/whatsapp@{{openclaw.version}}",
    });
    expect(listMessagingPackageInstallSpecs({ agent: "hermes" })).toEqual([]);
  });

  it("merges duplicate policy preset metadata by preset name", () => {
    const manifests: ChannelManifest[] = [
      manifestWithPreset("alpha", {
        name: "shared",
        policyKeys: ["alpha_key"],
        agentPolicyKeys: { hermes: ["alpha_hermes"] },
        validationWarningLines: ["alpha warning"],
      }),
      manifestWithPreset("beta", {
        name: "shared",
        policyKeys: ["beta_key"],
        validationWarningLines: ["beta warning"],
      }),
    ];

    expect(getMessagingPolicyKeyAliases({ manifests }).shared).toEqual([
      "alpha_key",
      "alpha_hermes",
      "beta_key",
    ]);
    expect(getMessagingPolicyPresetValidationWarnings({ manifests }).shared).toEqual([
      "alpha warning",
      "beta warning",
    ]);
  });

  it("lists package installs from manifest agent package metadata", () => {
    const manifests: ChannelManifest[] = [
      {
        ...manifestWithPreset("alpha", "alpha"),
        agentPackages: [
          {
            id: "alphaPackage",
            agent: "openclaw",
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/alpha@{{openclaw.version}}",
          },
        ],
      },
    ];

    expect(listMessagingPackageInstallSpecs({ manifests })[0]?.agents).toEqual(["openclaw"]);
    expect(listMessagingPackageInstallSpecs({ manifests, agent: "hermes" })).toEqual([]);
  });
});

function manifestWithPreset(id: string, preset: ChannelPolicyPresetReference): ChannelManifest {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    supportedAgents: ["openclaw", "hermes"],
    auth: { mode: "none" },
    inputs: [],
    credentials: [],
    policyPresets: [preset],
    render: [],
    state: {},
    hooks: [],
  };
}
