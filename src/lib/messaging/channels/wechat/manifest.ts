// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const wechatManifest = {
  schemaVersion: 1,
  id: "wechat",
  displayName: "WeChat",
  description: "WeChat (personal) bot messaging",
  enrollmentHelp:
    "Captured automatically via a host-side QR scan during onboard — pair the bot by scanning the QR with WeChat on your phone (Discover → Scan). DM-only.",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "host-qr",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "WECHAT_BOT_TOKEN",
      prompt: {
        label: "WeChat Bot Token",
        help: "Captured automatically via a host-side QR scan during onboard — pair the bot by scanning the QR with WeChat on your phone (Discover → Scan). DM-only.",
      },
    },
    {
      id: "accountId",
      kind: "config",
      required: true,
      envKey: "WECHAT_ACCOUNT_ID",
      statePath: "wechatConfig.accountId",
    },
    {
      id: "baseUrl",
      kind: "config",
      required: false,
      envKey: "WECHAT_BASE_URL",
      statePath: "wechatConfig.baseUrl",
    },
    {
      id: "userId",
      kind: "config",
      required: false,
      envKey: "WECHAT_USER_ID",
      statePath: "wechatConfig.userId",
    },
    {
      id: "allowedIds",
      kind: "config",
      required: false,
      envKey: "WECHAT_ALLOWED_IDS",
      statePath: "allowedIds.wechat",
      prompt: {
        label: "WeChat User ID(s) (DM allowlist)",
        help: "Optional: restrict who can DM the bot. The WeChat user id of the operator who scanned is added automatically; supply additional ids as a comma-separated list.",
        emptyValueMessage: "bot will require manual pairing",
      },
    },
  ],
  credentials: [
    {
      id: "wechatBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-wechat-bridge",
      providerEnvKey: "WECHAT_BOT_TOKEN",
      placeholder: "openshell:resolve:env:WECHAT_BOT_TOKEN",
    },
  ],
  policyPresets: [{ name: "wechat", policyKeys: ["wechat_bridge"] }],
  render: [
    {
      id: "wechat-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "WEIXIN_TOKEN={{credential.wechatBotToken.placeholder}}",
        "WEIXIN_ACCOUNT_ID={{wechatConfig.accountId}}",
        "WEIXIN_BASE_URL={{wechatConfig.baseUrl}}",
        "WEIXIN_ALLOWED_USERS={{allowedIds.wechat.csv}}",
      ],
    },
  ],
  state: {
    persist: {
      wechatConfig: ["accountId", "baseUrl", "userId"],
      allowedIds: ["allowedIds"],
    },
    rebuildHydration: [
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
    ],
  },
  hooks: [
    {
      id: "wechat-host-qr",
      phase: "enroll",
      handler: "wechat.ilinkLogin",
      inputs: ["allowedIds"],
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
        {
          id: "accountId",
          kind: "config",
          required: true,
        },
        {
          id: "baseUrl",
          kind: "config",
        },
        {
          id: "userId",
          kind: "config",
        },
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "wechat-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "allowedIds",
          kind: "config",
        },
      ],
    },
    {
      id: "wechat-seed-openclaw-account",
      phase: "post-agent-install",
      handler: "wechat.seedOpenClawAccount",
      agents: ["openclaw"],
      inputs: [
        "wechatConfig.accountId",
        "wechatConfig.baseUrl",
        "wechatConfig.userId",
        "credential.wechatBotToken.placeholder",
      ],
      outputs: [
        {
          id: "openclawWeixinAccountsIndex",
          kind: "build-file",
          required: true,
        },
        {
          id: "openclawWeixinAccountFile",
          kind: "build-file",
          required: true,
        },
        {
          id: "openclawConfigPatch",
          kind: "build-file",
          required: true,
        },
      ],
      onFailure: "abort",
    },
    {
      id: "wechat-health-check",
      phase: "health-check",
      handler: "wechat.healthCheck",
      inputs: ["wechatConfig.accountId"],
      onFailure: "abort",
    },
  ],
} as const satisfies ChannelManifest;
