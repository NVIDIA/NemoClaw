// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookInputMap,
  MessagingHookRegistration,
} from "../../../hooks";

export const WECHAT_ILINK_LOGIN_HOOK_ID = "wechat.ilinkLogin";
export const WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID = "wechat.seedOpenClawAccount";

const FAKE_WECHAT_ACCOUNT_ID = "fake-wechat-account";
const FAKE_WECHAT_BASE_URL = "https://ilinkai.wechat.example";
const FAKE_WECHAT_USER_ID = "fake-wechat-user";
const FAKE_WECHAT_TOKEN_PLACEHOLDER = "openshell:resolve:env:WECHAT_BOT_TOKEN";
const FAKE_WECHAT_SAVED_AT = "2026-01-01T00:00:00.000Z";
const WECHAT_PLUGIN_ID = "openclaw-weixin";
const WECHAT_PLUGIN_INSTALL_PATH = "/sandbox/.openclaw/extensions/openclaw-weixin";
const WECHAT_PLUGIN_SPEC = "@tencent-weixin/openclaw-weixin@2.4.2";

export const fakeWechatIlinkLoginHook: MessagingHookHandler = () => ({
  outputs: {
    botToken: {
      kind: "secret",
      value: "fake-wechat-token",
    },
    accountId: {
      kind: "config",
      value: FAKE_WECHAT_ACCOUNT_ID,
    },
    baseUrl: {
      kind: "config",
      value: FAKE_WECHAT_BASE_URL,
    },
    userId: {
      kind: "config",
      value: FAKE_WECHAT_USER_ID,
    },
  },
});

export const fakeWechatSeedOpenClawAccountHook: MessagingHookHandler = (context) => {
  const accountId = inputString(
    context.inputs,
    "wechatConfig.accountId",
    FAKE_WECHAT_ACCOUNT_ID,
  );
  const baseUrl = inputString(context.inputs, "wechatConfig.baseUrl", FAKE_WECHAT_BASE_URL);
  const userId = inputString(context.inputs, "wechatConfig.userId", FAKE_WECHAT_USER_ID);
  const token = inputString(
    context.inputs,
    "credential.wechatBotToken.placeholder",
    FAKE_WECHAT_TOKEN_PLACEHOLDER,
  );

  return {
    outputs: {
      openclawWeixinAccountsIndex: {
        kind: "build-file",
        value: {
          path: "openclaw-weixin/accounts.json",
          mode: "0600",
          content: [accountId],
        },
      },
      openclawWeixinAccountFile: {
        kind: "build-file",
        value: {
          path: `openclaw-weixin/accounts/${accountId}.json`,
          mode: "0600",
          content: {
            token,
            savedAt: FAKE_WECHAT_SAVED_AT,
            baseUrl,
            userId,
          },
        },
      },
      openclawConfigPatch: {
        kind: "build-file",
        value: {
          path: "openclaw.json",
          merge: {
            plugins: {
              installs: {
                [WECHAT_PLUGIN_ID]: {
                  source: "npm",
                  spec: WECHAT_PLUGIN_SPEC,
                  installPath: WECHAT_PLUGIN_INSTALL_PATH,
                },
              },
              load: {
                paths: [WECHAT_PLUGIN_INSTALL_PATH],
              },
              entries: {
                [WECHAT_PLUGIN_ID]: {
                  enabled: true,
                },
              },
            },
            channels: {
              [WECHAT_PLUGIN_ID]: {
                channelConfigUpdatedAt: FAKE_WECHAT_SAVED_AT,
                accounts: {
                  [accountId]: {
                    enabled: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
};

function inputString(
  inputs: MessagingHookInputMap | undefined,
  key: string,
  fallback: string,
): string {
  const value = inputs?.[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

export const FAKE_WECHAT_HOOK_REGISTRATIONS: readonly MessagingHookRegistration[] = [
  {
    id: WECHAT_ILINK_LOGIN_HOOK_ID,
    handler: fakeWechatIlinkLoginHook,
  },
  {
    id: WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
    handler: fakeWechatSeedOpenClawAccountHook,
  },
] as const;
