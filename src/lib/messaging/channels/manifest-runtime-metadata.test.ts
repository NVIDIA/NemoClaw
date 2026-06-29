// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { planStateUpdates } from "../compiler/engines/state-update-engine";
import type { ChannelManifest } from "../manifest";
import {
  discordManifest,
  slackManifest,
  teamsManifest,
  telegramManifest,
  wechatManifest,
  whatsappManifest,
} from "./index";
import { listOpenClawManagedChannelNames, listOpenClawRuntimeChannelMetadata } from "./metadata";

type ExpectedStateUpdate =
  | {
      readonly kind: "persist-inputs";
      readonly stateKey: string;
      readonly inputIds: readonly string[];
    }
  | {
      readonly kind: "rebuild-hydration";
      readonly statePath: string;
      readonly env: string;
    };

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

function normalizeRuntimeMetadata(
  entries: ReturnType<typeof listOpenClawRuntimeChannelMetadata>,
): Array<{ channelId: string; configKeys: string[]; logPatterns: string[] }> {
  return entries
    .map((entry) => ({
      channelId: entry.channelId,
      configKeys: sortedStrings(entry.configKeys),
      logPatterns: sortedStrings(entry.logPatterns),
    }))
    .sort((left, right) => left.channelId.localeCompare(right.channelId));
}

function normalizeStateUpdates(updates: ReturnType<typeof planStateUpdates>): Array<
  | {
      readonly channelId: string;
      readonly kind: "persist-inputs";
      readonly stateKey: string;
      readonly inputIds: string[];
    }
  | {
      readonly channelId: string;
      readonly kind: "rebuild-hydration";
      readonly statePath: string;
      readonly env: string;
    }
> {
  return updates
    .map((update) =>
      update.kind === "persist-inputs"
        ? { ...update, inputIds: sortedStrings(update.inputIds) }
        : update,
    )
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function expectOpenClawRuntimeVisibility(
  manifest: ChannelManifest,
  configKeys: readonly string[],
  logPatterns: readonly string[],
  channelName = configKeys[0],
): void {
  expect(sortedStrings(listOpenClawManagedChannelNames({ manifests: [manifest] }))).toEqual(
    sortedStrings([channelName]),
  );
  expect(
    normalizeRuntimeMetadata(listOpenClawRuntimeChannelMetadata({ manifests: [manifest] })),
  ).toEqual([
    {
      channelId: manifest.id,
      configKeys: sortedStrings(configKeys),
      logPatterns: sortedStrings(logPatterns),
    },
  ]);
}

function expectStateUpdates(
  manifest: ChannelManifest,
  updates: readonly ExpectedStateUpdate[],
): void {
  expect(normalizeStateUpdates(planStateUpdates(manifest))).toEqual(
    normalizeStateUpdates(
      updates.map((update) => ({
        channelId: manifest.id,
        ...update,
      })),
    ),
  );
}

describe("built-in channel derived runtime metadata", () => {
  it("derives OpenClaw runtime visibility from manifest render intent", () => {
    expectOpenClawRuntimeVisibility(telegramManifest, ["telegram"], ["telegram"]);
    expectOpenClawRuntimeVisibility(discordManifest, ["discord"], ["discord"]);
    expectOpenClawRuntimeVisibility(slackManifest, ["slack"], ["slack"]);
    expectOpenClawRuntimeVisibility(
      wechatManifest,
      ["openclaw-weixin"],
      ["wechat", "openclaw-weixin"],
    );
    expectOpenClawRuntimeVisibility(whatsappManifest, ["whatsapp"], ["whatsapp"]);
    expectOpenClawRuntimeVisibility(teamsManifest, ["msteams"], ["msteams", "teams"], "msteams");
  });

  it("derives state updates from config input state paths", () => {
    expectStateUpdates(telegramManifest, [
      {
        kind: "persist-inputs",
        stateKey: "allowedIds",
        inputIds: ["allowedIds"],
      },
      {
        kind: "persist-inputs",
        stateKey: "telegramConfig",
        inputIds: ["requireMention", "groupPolicy"],
      },
      {
        kind: "rebuild-hydration",
        statePath: "allowedIds.telegram",
        env: "TELEGRAM_ALLOWED_IDS",
      },
      {
        kind: "rebuild-hydration",
        statePath: "telegramConfig.requireMention",
        env: "TELEGRAM_REQUIRE_MENTION",
      },
      {
        kind: "rebuild-hydration",
        statePath: "telegramConfig.groupPolicy",
        env: "TELEGRAM_GROUP_POLICY",
      },
    ]);
    expectStateUpdates(discordManifest, [
      {
        kind: "persist-inputs",
        stateKey: "discordGuilds",
        inputIds: ["serverId", "requireMention", "userId"],
      },
      {
        kind: "rebuild-hydration",
        statePath: "discordGuilds.serverId",
        env: "DISCORD_SERVER_ID",
      },
      {
        kind: "rebuild-hydration",
        statePath: "discordGuilds.requireMention",
        env: "DISCORD_REQUIRE_MENTION",
      },
      {
        kind: "rebuild-hydration",
        statePath: "discordGuilds.userIds",
        env: "DISCORD_USER_ID",
      },
    ]);
    expectStateUpdates(slackManifest, [
      {
        kind: "persist-inputs",
        stateKey: "allowedIds",
        inputIds: ["allowedUsers"],
      },
      {
        kind: "persist-inputs",
        stateKey: "slackConfig",
        inputIds: ["allowedChannels"],
      },
      {
        kind: "rebuild-hydration",
        statePath: "allowedIds.slack",
        env: "SLACK_ALLOWED_USERS",
      },
      {
        kind: "rebuild-hydration",
        statePath: "slackConfig.allowedChannels",
        env: "SLACK_ALLOWED_CHANNELS",
      },
    ]);
    expectStateUpdates(wechatManifest, [
      {
        kind: "persist-inputs",
        stateKey: "wechatConfig",
        inputIds: ["accountId", "baseUrl", "userId"],
      },
      {
        kind: "persist-inputs",
        stateKey: "allowedIds",
        inputIds: ["allowedIds"],
      },
      {
        kind: "rebuild-hydration",
        statePath: "wechatConfig.accountId",
        env: "WECHAT_ACCOUNT_ID",
      },
      {
        kind: "rebuild-hydration",
        statePath: "wechatConfig.baseUrl",
        env: "WECHAT_BASE_URL",
      },
      {
        kind: "rebuild-hydration",
        statePath: "wechatConfig.userId",
        env: "WECHAT_USER_ID",
      },
      {
        kind: "rebuild-hydration",
        statePath: "allowedIds.wechat",
        env: "WECHAT_ALLOWED_IDS",
      },
    ]);
    expectStateUpdates(whatsappManifest, [
      {
        kind: "persist-inputs",
        stateKey: "allowedIds",
        inputIds: ["allowedIds"],
      },
      {
        kind: "rebuild-hydration",
        statePath: "allowedIds.whatsapp",
        env: "WHATSAPP_ALLOWED_IDS",
      },
    ]);
    expectStateUpdates(teamsManifest, [
      {
        kind: "persist-inputs",
        stateKey: "teamsConfig",
        inputIds: ["appId", "tenantId", "webhookPort", "requireMention"],
      },
      {
        kind: "persist-inputs",
        stateKey: "allowedIds",
        inputIds: ["allowedUsers"],
      },
      {
        kind: "rebuild-hydration",
        statePath: "teamsConfig.appId",
        env: "MSTEAMS_APP_ID",
      },
      {
        kind: "rebuild-hydration",
        statePath: "teamsConfig.tenantId",
        env: "MSTEAMS_TENANT_ID",
      },
      {
        kind: "rebuild-hydration",
        statePath: "allowedIds.teams",
        env: "TEAMS_ALLOWED_USERS",
      },
      {
        kind: "rebuild-hydration",
        statePath: "teamsConfig.webhookPort",
        env: "MSTEAMS_PORT",
      },
      {
        kind: "rebuild-hydration",
        statePath: "teamsConfig.requireMention",
        env: "TEAMS_REQUIRE_MENTION",
      },
    ]);
  });
});
