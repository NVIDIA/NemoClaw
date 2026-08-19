// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema-owned identity for the WeChat account-file build output.
 *
 * The manifest, hook registration, and standalone managed-startup validator all
 * consume this dependency-free contract. Keeping it free of imports is required
 * because the validator also runs directly under Node's stripped-types loader.
 */
export const WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT = {
  channelId: "wechat",
  planHookId: "wechat-seed-openclaw-account",
  handlerId: "wechat.seedOpenClawAccount",
  outputId: "openclawWeixinAccountFile",
  kind: "build-file",
  required: true,
  mode: "0600",
} as const;

export const WECHAT_SEED_OPENCLAW_ACCOUNT_HOOK_ID = WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.handlerId;
export const WECHAT_SEED_OPENCLAW_ACCOUNT_PLAN_HOOK_ID =
  WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.planHookId;
export const WECHAT_OPENCLAW_ACCOUNT_FILE_OUTPUT_ID =
  WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.outputId;

export const WECHAT_TOKEN_PLACEHOLDER = "openshell:resolve:env:WECHAT_BOT_TOKEN";

export interface WechatManagedStartupPlaceholderAuthorization {
  readonly path: readonly string[];
  readonly value: string;
}

export function authorizeWechatAccountFilePlaceholders(
  value: unknown,
): readonly WechatManagedStartupPlaceholderAuthorization[] {
  const content = isPlainDataObject(value) ? ownDataPropertyValue(value, "content") : undefined;
  if (
    !isPlainDataObject(value) ||
    !hasExactlyOwnDataProperties(value, ["content", "mode", "path"]) ||
    !isWechatAccountFilePath(ownDataPropertyValue(value, "path")) ||
    ownDataPropertyValue(value, "mode") !== WECHAT_OPENCLAW_ACCOUNT_FILE_CONTRACT.mode ||
    !isPlainDataObject(content) ||
    !hasOnlyOwnDataProperties(content, ["baseUrl", "savedAt", "token", "userId"]) ||
    !hasOwnDataProperty(content, "savedAt") ||
    !hasOwnDataProperty(content, "token") ||
    ownDataPropertyValue(content, "token") !== WECHAT_TOKEN_PLACEHOLDER ||
    !isNonEmptyString(ownDataPropertyValue(content, "savedAt")) ||
    !isOptionalNonEmptyString(content, "baseUrl") ||
    !isOptionalNonEmptyString(content, "userId")
  ) {
    return [];
  }
  return [{ path: ["content", "token"], value: WECHAT_TOKEN_PLACEHOLDER }];
}

export function wechatAccountFilePath(accountId: string): string {
  return `openclaw-weixin/accounts/${accountId}.json`;
}

export function assertSafeWechatAccountId(accountId: string): void {
  if (!isSafeWechatAccountId(accountId)) {
    throw new Error("WeChat account id contains unsafe filename characters.");
  }
}

function isWechatAccountFilePath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const prefix = "openclaw-weixin/accounts/";
  const suffix = ".json";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const accountId = value.slice(prefix.length, -suffix.length);
  return accountId === accountId.trim() && isSafeWechatAccountId(accountId);
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataPropertyValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hasOwnDataProperty(value: Record<string, unknown>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor;
}

function hasExactlyOwnDataProperties(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.getOwnPropertyNames(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyOwnDataProperties(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.getOwnPropertyNames(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalNonEmptyString(value: Record<string, unknown>, key: string): boolean {
  return !hasOwnDataProperty(value, key) || isNonEmptyString(ownDataPropertyValue(value, key));
}
