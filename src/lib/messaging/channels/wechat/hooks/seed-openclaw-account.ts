// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookInputMap,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";
import { normalizeWechatIlinkBaseUrl } from "../ilink-base-url.ts";

export const WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID = "wechat.seedOpenClawAccount";
export const WECHAT_SEED_OPENCLAW_ACCOUNT_PLAN_HOOK_ID = "wechat-seed-openclaw-account";
export const WECHAT_OPENCLAW_ACCOUNT_FILE_OUTPUT_ID = "openclawWeixinAccountFile";
export const WECHAT_TOKEN_PLACEHOLDER = "openshell:resolve:env:WECHAT_BOT_TOKEN";
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
        mode: "0600",
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

export interface WechatManagedStartupPlaceholderAuthorization {
  readonly path: readonly string[];
  readonly value: string;
}

export function authorizeWechatManagedStartupPlaceholders(
  step: unknown,
): readonly WechatManagedStartupPlaceholderAuthorization[] {
  if (!isPlainDataObject(step)) return [];
  const value = ownDataPropertyValue(step, "value");
  if (
    ownDataPropertyValue(step, "channelId") !== "wechat" ||
    ownDataPropertyValue(step, "kind") !== "build-file" ||
    ownDataPropertyValue(step, "hookId") !== WECHAT_SEED_OPENCLAW_ACCOUNT_PLAN_HOOK_ID ||
    ownDataPropertyValue(step, "handler") !== WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID ||
    ownDataPropertyValue(step, "outputId") !== WECHAT_OPENCLAW_ACCOUNT_FILE_OUTPUT_ID ||
    ownDataPropertyValue(step, "required") !== true ||
    !isPlainDataObject(value) ||
    !isWechatAccountFilePath(ownDataPropertyValue(value, "path"))
  ) {
    return [];
  }
  return [{ path: ["value", "content", "token"], value: WECHAT_TOKEN_PLACEHOLDER }];
}

function wechatAccountFilePath(accountId: string): string {
  return `openclaw-weixin/accounts/${accountId}.json`;
}

function isWechatAccountFilePath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const prefix = "openclaw-weixin/accounts/";
  const suffix = ".json";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const accountId = value.slice(prefix.length, -suffix.length);
  return accountId === accountId.trim() && isSafeWechatAccountId(accountId);
}

function assertSafeWechatAccountId(accountId: string): void {
  if (!isSafeWechatAccountId(accountId)) {
    throw new Error("WeChat account id contains unsafe filename characters.");
  }
}

function isSafeWechatAccountId(accountId: string): boolean {
  return (
    accountId.length > 0 &&
    accountId !== "." &&
    accountId !== ".." &&
    !/[\\/\0-\x1F\x7F]/.test(accountId) &&
    !accountId.includes("..")
  );
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownDataPropertyValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
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
