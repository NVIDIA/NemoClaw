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
  listMessagingChannelsWithoutCredentials,
  listMessagingConfigEnvKeys,
  listMessagingPackageInstallSpecs,
  listMessagingProviderNamesForChannel,
  listOpenClawManagedChannelNames,
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
      "teams",
    ]);
    expect(listAvailableMessagingChannelIds({ agent: "hermes" })).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
    ]);
  });

  it("resolves credential env keys, env-key ownership, and provider names", () => {
    expect(getMessagingCredentialEnvKeysByChannel()).toMatchObject({
      telegram: ["TELEGRAM_BOT_TOKEN"],
      discord: ["DISCORD_BOT_TOKEN"],
      wechat: ["WECHAT_BOT_TOKEN"],
      slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
      whatsapp: [],
      teams: ["MSTEAMS_APP_PASSWORD"],
    });
    expect(getMessagingChannelForCredentialEnvKey("SLACK_APP_TOKEN")).toBe("slack");
    expect(getMessagingChannelForCredentialEnvKey("WHATSAPP_ALLOWED_IDS")).toBeNull();
    expect(getMessagingProviderSuffixesByChannel()).toMatchObject({
      telegram: ["-telegram-bridge"],
      discord: ["-discord-bridge"],
      wechat: ["-wechat-bridge"],
      slack: ["-slack-bridge", "-slack-app"],
      teams: ["-teams-bridge"],
    });
    expect(listMessagingProviderNamesForChannel("demo", "slack")).toEqual([
      "demo-slack-bridge",
      "demo-slack-app",
    ]);
    expect(listMessagingChannelsWithoutCredentials()).toEqual(["whatsapp"]);
  });

  it("resolves config env keys and aliases from manifest inputs", () => {
    expect(listMessagingConfigEnvKeys()).toEqual([
      "TELEGRAM_ALLOWED_IDS",
      "TELEGRAM_REQUIRE_MENTION",
      "TELEGRAM_GROUP_POLICY",
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
      "MSTEAMS_APP_ID",
      "MSTEAMS_TENANT_ID",
      "TEAMS_ALLOWED_USERS",
      "MSTEAMS_PORT",
      "TEAMS_REQUIRE_MENTION",
    ]);
    expect(getMessagingConfigEnvAliases()).toEqual({
      DISCORD_SERVER_ID: ["DISCORD_SERVER_IDS"],
      DISCORD_USER_ID: ["DISCORD_ALLOWED_IDS"],
      MSTEAMS_APP_ID: ["TEAMS_CLIENT_ID"],
      MSTEAMS_TENANT_ID: ["TEAMS_TENANT_ID"],
      TEAMS_ALLOWED_USERS: ["MSTEAMS_ALLOWED_USERS"],
      MSTEAMS_PORT: ["TEAMS_PORT"],
    });
  });

  it("resolves policy aliases, OpenClaw runtime keys, and package specs", () => {
    expect(getMessagingPolicyKeyAliases()).toMatchObject({
      telegram: ["telegram_bot", "telegram"],
      discord: ["discord"],
      wechat: ["wechat_bridge"],
      slack: ["slack"],
      whatsapp: ["whatsapp"],
      teams: ["teams"],
    });
    expect(getMessagingPolicyKeysByChannel({ agent: "hermes" })).toMatchObject({
      telegram: ["telegram"],
      discord: ["discord"],
      wechat: ["wechat_bridge"],
      slack: ["slack"],
      whatsapp: ["whatsapp"],
      teams: ["teams"],
    });
    expect(listRequiredCreateTimeMessagingPolicyPresetNames()).toEqual(["slack"]);
    expect(getMessagingPolicyPresetValidationWarnings().discord).toContain(
      "https://discord.com/api/v10/gateway or validate the configured",
    );
    expect(listOpenClawManagedChannelNames()).toEqual([
      "telegram",
      "discord",
      "openclaw-weixin",
      "slack",
      "whatsapp",
      "msteams",
    ]);
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
      teams: ["msteams"],
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
      teams: "npm:@openclaw/msteams@{{openclaw.version}}",
    });
    expect(listMessagingPackageInstallSpecs({ agent: "hermes" })).toEqual([
      {
        channelId: "teams",
        packageId: "hermesTeamsAppsPackage",
        agents: ["hermes"],
        manager: "hermes-uv-pip",
        spec: "microsoft-teams-apps==2.0.13.4",
      },
      {
        channelId: "teams",
        packageId: "hermesAiohttpPackage",
        agents: ["hermes"],
        manager: "hermes-uv-pip",
        spec: "aiohttp==3.14.1",
      },
    ]);
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

  it("derives OpenClaw managed channel names from explicit runtime metadata", () => {
    const manifests: ChannelManifest[] = [
      {
        ...manifestWithPreset("matrix", "matrix"),
        render: [
          {
            kind: "json-fragment",
            agent: "openclaw",
            target: "openclaw.json",
            fragment: { path: "channels.matrix", value: { enabled: true } },
          },
          {
            kind: "json-fragment",
            agent: "openclaw",
            target: "openclaw.json",
            fragment: { path: "channels.matrix.rooms", value: ["#ops"] },
          },
          {
            kind: "json-fragment",
            agent: "hermes",
            target: "~/.hermes/config.yaml",
            fragment: { path: "channels.hermesOnly", value: { enabled: true } },
          },
          {
            kind: "json-fragment",
            agent: "openclaw",
            target: "openclaw.json",
            fragment: { path: "plugins.entries.matrix", value: { enabled: true } },
          },
        ],
        runtime: {
          openclaw: {
            channelName: "matrix-runtime",
            visibility: {
              configKeys: ["matrix-runtime"],
              logPatterns: ["matrix"],
            },
          },
        },
      },
    ];

    expect(listOpenClawManagedChannelNames({ manifests })).toEqual(["matrix-runtime"]);
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

  it("lists channels that do not declare gateway credentials", () => {
    const manifests: ChannelManifest[] = [
      {
        ...manifestWithPreset("matrix", "matrix"),
        credentials: [
          {
            id: "matrixToken",
            sourceInput: "token",
            providerName: "{sandboxName}-matrix-bridge",
            providerEnvKey: "MATRIX_TOKEN",
            placeholder: "openshell:resolve:env:MATRIX_TOKEN",
          },
        ],
      },
      {
        ...manifestWithPreset("sessionOnly", "session-only"),
        credentials: [],
      },
    ];

    expect(listMessagingChannelsWithoutCredentials({ manifests })).toEqual(["sessionOnly"]);
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
