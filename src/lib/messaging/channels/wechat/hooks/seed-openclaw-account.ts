// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookInputMap,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";
import {
  assertSafeWechatAccountId,
  WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT,
  WECHAT_OPENCLAW_ACCOUNT_FILE_OUTPUT_ID,
  WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
  WECHAT_TOKEN_PLACEHOLDER,
  wechatAccountFilePath,
} from "../contract.ts";
import { normalizeWechatIlinkBaseUrl } from "../ilink-base-url.ts";

export {
  WECHAT_OPENCLAW_ACCOUNT_FILE_OUTPUT_ID,
  WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
  WECHAT_SEED_OPENCLAW_ACCOUNT_PLAN_HOOK_ID,
} from "../contract.ts";

export { WECHAT_TOKEN_PLACEHOLDER } from "../contract.ts";
export const WECHAT_PLUGIN_ID = "openclaw-weixin";
export const WECHAT_PLUGIN_INSTALL_PATH = "/sandbox/.openclaw/extensions/openclaw-weixin";

export interface WechatSeedOpenClawAccountHookOptions {
  readonly now?: () => Date | string;
  readonly pluginInstallPath?: string;
  readonly pluginSpec?: string;
}

export function createWechatSeedOpenClawAccountHook(
  options: WechatSeedOpenClawAccountHookOptions = {},
): MessagingHookHandler {
  return (context) => ({
    outputs: buildWechatSeedOpenClawAccountOutputs(context.inputs, options),
  });
}

export function createWechatSeedOpenClawAccountHookRegistration(
  options: WechatSeedOpenClawAccountHookOptions = {},
): MessagingHookRegistration {
  return {
    id: WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID,
    handler: createWechatSeedOpenClawAccountHook(options),
  };
}

export function buildWechatSeedOpenClawAccountOutputs(
  inputs: MessagingHookInputMap | undefined,
  options: WechatSeedOpenClawAccountHookOptions = {},
): MessagingHookOutputMap {
  const accountId = requiredInputString(inputs, "wechatConfig.accountId");
  assertSafeWechatAccountId(accountId);
  const baseUrl = normalizeWechatIlinkBaseUrl(optionalInputString(inputs, "wechatConfig.baseUrl"));
  const userId = optionalInputString(inputs, "wechatConfig.userId");
  const token =
    optionalInputString(inputs, "credential.wechatBotToken.placeholder") ||
    WECHAT_TOKEN_PLACEHOLDER;
  const savedAt = isoTimestamp(options.now);
  const pluginInstallPath = options.pluginInstallPath ?? WECHAT_PLUGIN_INSTALL_PATH;
  const pluginSpec = options.pluginSpec ?? "@tencent-weixin/openclaw-weixin@2.4.3";

  return {
    openclawWeixinAccountsIndex: {
      kind: "build-file",
      value: {
        path: "openclaw-weixin/accounts.json",
        mode: "0600",
        content: [accountId],
      },
    },
    [WECHAT_OPENCLAW_ACCOUNT_FILE_OUTPUT_ID]: {
      kind: "build-file",
      value: {
        path: wechatAccountFilePath(accountId),
        mode: WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.mode,
        content: {
          token,
          savedAt,
          ...(baseUrl ? { baseUrl } : {}),
          ...(userId ? { userId } : {}),
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
                spec: pluginSpec,
                installPath: pluginInstallPath,
              },
            },
            entries: {
              [WECHAT_PLUGIN_ID]: {
                enabled: true,
              },
            },
          },
          channels: {
            [WECHAT_PLUGIN_ID]: {
              enabled: true,
              channelConfigUpdatedAt: savedAt,
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
  };
}

function requiredInputString(inputs: MessagingHookInputMap | undefined, key: string): string {
  const value = optionalInputString(inputs, key);
  if (!value) {
    throw new Error(`WeChat account seeding requires ${key}.`);
  }
  return value;
}

function optionalInputString(inputs: MessagingHookInputMap | undefined, key: string): string {
  const value = inputs?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function isoTimestamp(now: WechatSeedOpenClawAccountHookOptions["now"]): string {
  const value = now?.() ?? new Date();
  return typeof value === "string" ? value : value.toISOString();
}
