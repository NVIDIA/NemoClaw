// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MessagingHookRegistry, runMessagingHook } from "../../../hooks";
import { wechatManifest } from "../manifest";
import { createWechatHealthCheckHook, WECHAT_HEALTH_CHECK_HOOK_ID } from "./health-check";
import { createWechatIlinkLoginHook, WECHAT_ILINK_LOGIN_HOOK_ID } from "./ilink-login";
import {
  buildWechatSeedOpenClawAccountOutputs,
  createWechatSeedOpenClawAccountHook,
  WECHAT_PLUGIN_SPEC,
  WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
} from "./seed-openclaw-account";

describe("WeChat hook implementations", () => {
  it("requires injected host QR dependencies in phase 1", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: WECHAT_ILINK_LOGIN_HOOK_ID,
        handler: createWechatIlinkLoginHook(),
      },
    ]);
    const hook = wechatManifest.hooks[0];

    if (!hook) throw new Error("missing WeChat host QR hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "wechat",
      }),
    ).rejects.toThrow("requires an injected runLogin implementation");
  });

  it("runs host QR enrollment and stages token plus non-secret account metadata", async () => {
    const env: NodeJS.ProcessEnv = {};
    const saved: Array<{ readonly key: string; readonly value: string }> = [];
    const registry = new MessagingHookRegistry([
      {
        id: WECHAT_ILINK_LOGIN_HOOK_ID,
        handler: createWechatIlinkLoginHook({
          env,
          log: () => {},
          saveCredential: (key, value) => saved.push({ key, value }),
          runLogin: async () => ({
            kind: "ok",
            credentials: {
              token: "wechat-token",
              accountId: "wechat-account",
              baseUrl: "https://ilinkai.wechat.example",
              userId: "wechat-user",
            },
          }),
        }),
      },
    ]);
    const hook = wechatManifest.hooks[0];

    if (!hook) throw new Error("missing WeChat host QR hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "wechat",
        inputs: {
          allowedIds: "friend-one",
        },
      }),
    ).resolves.toMatchObject({
      handlerId: WECHAT_ILINK_LOGIN_HOOK_ID,
      outputs: {
        botToken: {
          kind: "secret",
          value: "wechat-token",
        },
        accountId: {
          kind: "config",
          value: "wechat-account",
        },
        allowedIds: {
          kind: "config",
          value: "friend-one,wechat-user",
        },
      },
    });
    expect(saved).toEqual([{ key: "WECHAT_BOT_TOKEN", value: "wechat-token" }]);
    expect(env).toMatchObject({
      WECHAT_BOT_TOKEN: "wechat-token",
      WECHAT_ACCOUNT_ID: "wechat-account",
      WECHAT_BASE_URL: "https://ilinkai.wechat.example",
      WECHAT_USER_ID: "wechat-user",
      WECHAT_ALLOWED_IDS: "friend-one,wechat-user",
    });
  });

  it("turns QR failures into hook failures without writing credentials", async () => {
    const env: NodeJS.ProcessEnv = {};
    const saved: Array<{ readonly key: string; readonly value: string }> = [];
    const registry = new MessagingHookRegistry([
      {
        id: WECHAT_ILINK_LOGIN_HOOK_ID,
        handler: createWechatIlinkLoginHook({
          env,
          log: () => {},
          saveCredential: (key, value) => saved.push({ key, value }),
          runLogin: async () => ({ kind: "timeout" }),
        }),
      },
    ]);
    const hook = wechatManifest.hooks[0];

    if (!hook) throw new Error("missing WeChat host QR hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "wechat",
      }),
    ).rejects.toThrow("WeChat host QR login failed: QR login timed out.");
    expect(saved).toEqual([]);
    expect(env.WECHAT_BOT_TOKEN).toBeUndefined();
  });

  it("rejects unsafe WeChat account ids before using them as build-file names", () => {
    for (const accountId of ["../../openclaw", "nested/account", "control\u0001id"]) {
      expect(() =>
        buildWechatSeedOpenClawAccountOutputs({
          "wechatConfig.accountId": accountId,
        }),
      ).toThrow("unsafe filename characters");
    }
  });

  it("declares a health-check hook that requires captured account metadata", async () => {
    const hook = wechatManifest.hooks.find((entry) => entry.id === "wechat-health-check");
    const registry = new MessagingHookRegistry([
      {
        id: WECHAT_HEALTH_CHECK_HOOK_ID,
        handler: createWechatHealthCheckHook(),
      },
    ]);

    if (!hook) throw new Error("missing WeChat health-check hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "wechat",
        inputs: {
          "wechatConfig.accountId": "wechat-account",
        },
      }),
    ).resolves.toMatchObject({
      handlerId: WECHAT_HEALTH_CHECK_HOOK_ID,
      outputs: {},
    });
    await expect(
      runMessagingHook(hook, registry, {
        channelId: "wechat",
      }),
    ).rejects.toThrow("WeChat health check requires wechatConfig.accountId.");
  });

  it("generates OpenClaw account seed build-file outputs from captured metadata", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
        handler: createWechatSeedOpenClawAccountHook({
          now: () => "2026-05-25T00:00:00.000Z",
        }),
      },
    ]);
    const hook = wechatManifest.hooks.find(
      (entry) => entry.id === "wechat-seed-openclaw-account",
    );

    if (!hook) throw new Error("missing WeChat seed hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "wechat",
        inputs: {
          "wechatConfig.accountId": "wechat-account",
          "wechatConfig.baseUrl": "https://ilinkai.wechat.example",
          "wechatConfig.userId": "wechat-user",
          "credential.wechatBotToken.placeholder": "openshell:resolve:env:WECHAT_BOT_TOKEN",
        },
      }),
    ).resolves.toMatchObject({
      handlerId: WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
      outputs: {
        openclawWeixinAccountFile: {
          kind: "build-file",
          value: {
            path: "openclaw-weixin/accounts/wechat-account.json",
            content: {
              token: "openshell:resolve:env:WECHAT_BOT_TOKEN",
              savedAt: "2026-05-25T00:00:00.000Z",
              baseUrl: "https://ilinkai.wechat.example",
              userId: "wechat-user",
            },
          },
        },
        openclawConfigPatch: {
          kind: "build-file",
          value: {
            merge: {
              plugins: {
                installs: {
                  "openclaw-weixin": {
                    spec: WECHAT_PLUGIN_SPEC,
                  },
                },
              },
              channels: {
                "openclaw-weixin": {
                  channelConfigUpdatedAt: "2026-05-25T00:00:00.000Z",
                  accounts: {
                    "wechat-account": {
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
