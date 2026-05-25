// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MessagingHookRegistry, runMessagingHook } from "../../../hooks";
import { wechatManifest } from "../manifest";
import {
  FAKE_WECHAT_HOOK_REGISTRATIONS,
  WECHAT_ILINK_LOGIN_HOOK_ID,
  WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
} from "./fakes";

describe("WeChat fake hook implementations", () => {
  it("uses fake registrations with the same handler ids declared by the manifest", () => {
    expect(FAKE_WECHAT_HOOK_REGISTRATIONS.map((registration) => registration.id)).toEqual([
      WECHAT_ILINK_LOGIN_HOOK_ID,
      WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
    ]);
    expect(wechatManifest.hooks.map((hook) => hook.handler)).toEqual([
      WECHAT_ILINK_LOGIN_HOOK_ID,
      WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
    ]);
  });

  it("shows the host-QR hook output shape without running real QR login", async () => {
    const registry = new MessagingHookRegistry(FAKE_WECHAT_HOOK_REGISTRATIONS);
    const hostQrHook = wechatManifest.hooks[0];

    if (!hostQrHook) throw new Error("missing WeChat host-QR hook");

    await expect(
      runMessagingHook(hostQrHook, registry, {
        channelId: "wechat",
      }),
    ).resolves.toMatchObject({
      handlerId: WECHAT_ILINK_LOGIN_HOOK_ID,
      outputs: {
        botToken: {
          kind: "secret",
        },
        accountId: {
          kind: "config",
          value: "fake-wechat-account",
        },
        baseUrl: {
          kind: "config",
        },
        userId: {
          kind: "config",
        },
      },
    });
  });

  it("shows the account-seed hook output shape without writing files", async () => {
    const registry = new MessagingHookRegistry(FAKE_WECHAT_HOOK_REGISTRATIONS);
    const seedHook = wechatManifest.hooks[1];

    if (!seedHook) throw new Error("missing WeChat seed hook");

    await expect(
      runMessagingHook(seedHook, registry, {
        channelId: "wechat",
        inputs: {
          "wechatConfig.accountId": "fake-wechat-account",
          "wechatConfig.baseUrl": "https://ilinkai.wechat.example",
          "wechatConfig.userId": "fake-wechat-user",
          "credential.wechatBotToken.placeholder": "openshell:resolve:env:WECHAT_BOT_TOKEN",
        },
      }),
    ).resolves.toMatchObject({
      handlerId: WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
      outputs: {
        openclawWeixinAccountsIndex: {
          kind: "build-file",
          value: {
            path: "openclaw-weixin/accounts.json",
            content: ["fake-wechat-account"],
          },
        },
        openclawWeixinAccountFile: {
          kind: "build-file",
          value: {
            path: "openclaw-weixin/accounts/fake-wechat-account.json",
            content: {
              token: "openshell:resolve:env:WECHAT_BOT_TOKEN",
              baseUrl: "https://ilinkai.wechat.example",
              userId: "fake-wechat-user",
            },
          },
        },
        openclawConfigPatch: {
          kind: "build-file",
          value: {
            path: "openclaw.json",
            merge: {
              plugins: {
                entries: {
                  "openclaw-weixin": {
                    enabled: true,
                  },
                },
              },
              channels: {
                "openclaw-weixin": {
                  accounts: {
                    "fake-wechat-account": {
                      enabled: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});
