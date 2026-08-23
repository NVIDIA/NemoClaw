// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { authorizeTeamsOpenClawWebhookField } from "./channels/teams/contract";
import {
  authorizeWechatAccountFilePlaceholders,
  WECHAT_TOKEN_PLACEHOLDER,
} from "./channels/wechat/contract";
import { authorizeMessagingManagedStartupFields } from "./managed-startup-placeholders";

const TEAMS_WEBHOOK = { path: "/api/messages", port: 3978 };
const TEAMS_ENTRY = {
  channelId: "teams",
  renderId: "teams-openclaw-channel",
  hookId: "teams-openclaw-channel",
  handler: "common.staticOutputs",
  kind: "json-fragment",
  agent: "openclaw",
  target: "openclaw.json",
  path: "channels.msteams",
  value: { webhook: TEAMS_WEBHOOK },
};
const WECHAT_VALUE = {
  path: "openclaw-weixin/accounts/managed-startup.json",
  mode: "0600",
  content: {
    savedAt: "2026-08-23T00:00:00.000Z",
    token: WECHAT_TOKEN_PLACEHOLDER,
  },
};
const WECHAT_ENTRY = {
  channelId: "wechat",
  hookId: "wechat-seed-openclaw-account",
  handler: "wechat.seedOpenClawAccount",
  outputId: "openclawWeixinAccountFile",
  kind: "build-file",
  required: true,
  value: WECHAT_VALUE,
};

function nullPrototype<T extends Record<string, unknown>>(value: T): T {
  return Object.assign(Object.create(null), value) as T;
}

describe("managed-startup messaging field authorization", () => {
  it("accepts exact null-prototype Teams and WeChat contracts", () => {
    const webhook = nullPrototype({ ...TEAMS_WEBHOOK });
    const teamsEntry = nullPrototype({
      ...TEAMS_ENTRY,
      value: nullPrototype({ webhook }),
    });
    const content = nullPrototype({ ...WECHAT_VALUE.content });
    const wechatValue = nullPrototype({ ...WECHAT_VALUE, content });
    const wechatEntry = nullPrototype({ ...WECHAT_ENTRY, value: wechatValue });

    expect(authorizeTeamsOpenClawWebhookField(teamsEntry)).toEqual([
      { path: ["value", "webhook"], value: webhook },
    ]);
    expect(authorizeWechatAccountFilePlaceholders(wechatValue)).toEqual([
      { path: ["content", "token"], value: WECHAT_TOKEN_PLACEHOLDER },
    ]);
    expect(authorizeMessagingManagedStartupFields(teamsEntry, "agentRender")).toEqual([
      { path: ["value", "webhook"], value: webhook },
    ]);
    expect(authorizeMessagingManagedStartupFields(wechatEntry, "buildSteps")).toEqual([
      { path: ["value", "content", "token"], value: WECHAT_TOKEN_PLACEHOLDER },
    ]);
  });

  it("rejects inherited Teams and WeChat fields", () => {
    expect(authorizeTeamsOpenClawWebhookField(Object.create(TEAMS_ENTRY))).toEqual([]);
    expect(authorizeWechatAccountFilePlaceholders(Object.create(WECHAT_VALUE))).toEqual([]);
    expect(
      authorizeMessagingManagedStartupFields(Object.create(TEAMS_ENTRY), "agentRender"),
    ).toEqual([]);
    expect(
      authorizeMessagingManagedStartupFields(Object.create(WECHAT_ENTRY), "buildSteps"),
    ).toEqual([]);
  });

  it("rejects accessors without invoking their getters", () => {
    let teamsGetterCalls = 0;
    const teamsEntry = { ...TEAMS_ENTRY };
    Object.defineProperty(teamsEntry, "value", {
      enumerable: true,
      get() {
        teamsGetterCalls += 1;
        return TEAMS_ENTRY.value;
      },
    });
    let wechatGetterCalls = 0;
    const wechatEntry = { ...WECHAT_ENTRY };
    Object.defineProperty(wechatEntry, "value", {
      enumerable: true,
      get() {
        wechatGetterCalls += 1;
        return WECHAT_ENTRY.value;
      },
    });

    expect(authorizeTeamsOpenClawWebhookField(teamsEntry)).toEqual([]);
    expect(authorizeMessagingManagedStartupFields(teamsEntry, "agentRender")).toEqual([]);
    expect(authorizeMessagingManagedStartupFields(wechatEntry, "buildSteps")).toEqual([]);
    expect(teamsGetterCalls).toBe(0);
    expect(wechatGetterCalls).toBe(0);
  });

  it("rejects surplus fields inside authorized credential values", () => {
    const teamsEntry = {
      ...TEAMS_ENTRY,
      value: { webhook: { ...TEAMS_WEBHOOK, token: "unexpected" } },
    };
    const wechatValue = {
      ...WECHAT_VALUE,
      content: { ...WECHAT_VALUE.content, note: "unexpected" },
    };
    const wechatEntry = { ...WECHAT_ENTRY, value: wechatValue };

    expect(authorizeTeamsOpenClawWebhookField(teamsEntry)).toEqual([]);
    expect(authorizeWechatAccountFilePlaceholders(wechatValue)).toEqual([]);
    expect(authorizeMessagingManagedStartupFields(teamsEntry, "agentRender")).toEqual([]);
    expect(authorizeMessagingManagedStartupFields(wechatEntry, "buildSteps")).toEqual([]);
  });

  it("rejects malformed authorization entries", () => {
    expect(authorizeTeamsOpenClawWebhookField(null)).toEqual([]);
    expect(authorizeTeamsOpenClawWebhookField([])).toEqual([]);
    expect(authorizeWechatAccountFilePlaceholders("invalid")).toEqual([]);
    expect(authorizeWechatAccountFilePlaceholders({ ...WECHAT_VALUE, mode: "0644" })).toEqual([]);
    expect(authorizeMessagingManagedStartupFields({}, "agentRender")).toEqual([]);
    expect(authorizeMessagingManagedStartupFields({}, "buildSteps")).toEqual([]);
  });
});
