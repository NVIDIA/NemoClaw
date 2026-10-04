// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  envConfigKey,
  getEnvConfigValue,
  getStructuredConfigValue,
  type RenderedChannelConfigParser,
  type RenderedChannelConfigParserContext,
  type RenderedConfigSource,
  type RenderedConfigVisibilityKey,
  structuredConfigKey,
} from "../rendered-config-parser-utils";

const OPENCLAW_ACCOUNT_IDS_KEY = "openclawWeixinAccountIds";

export const wechatRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    if (context.agentId === "openclaw") return openClawConfigVisibilityKeys(context);
    if (context.agentId === "hermes") {
      return [
        envConfigKey("accountId", "~/.hermes/.env", "WEIXIN_ACCOUNT_ID"),
        envConfigKey("baseUrl", "~/.hermes/.env", "WEIXIN_BASE_URL"),
        envConfigKey("allowedIds", "~/.hermes/.env", "WEIXIN_ALLOWED_USERS"),
      ];
    }
    return [];
  },

  getValue(key, source) {
    if (key.key === OPENCLAW_ACCOUNT_IDS_KEY) return openClawWeixinAccountIds(source, key);
    return key.kind === "env"
      ? getEnvConfigValue(source, key.envKey)
      : getStructuredConfigValue(source, key.path);
  },
};

function openClawConfigVisibilityKeys(
  context: RenderedChannelConfigParserContext,
): readonly RenderedConfigVisibilityKey[] {
  const keys: RenderedConfigVisibilityKey[] = [
    structuredConfigKey(
      "accountId",
      "openclaw.json",
      ["channels", "openclaw-weixin", "accounts"],
      OPENCLAW_ACCOUNT_IDS_KEY,
    ),
  ];
  const accountId = safeAccountId(inputValue(context, "accountId"));
  if (!accountId) return keys;
  const accountTarget = `~/.openclaw/openclaw-weixin/accounts/${accountId}.json`;
  keys.push(
    structuredConfigKey("baseUrl", accountTarget, ["baseUrl"]),
    structuredConfigKey("userId", accountTarget, ["userId"]),
  );
  return keys;
}

function openClawWeixinAccountIds(
  source: RenderedConfigSource,
  key: RenderedConfigVisibilityKey,
): string[] | undefined {
  const value = getStructuredConfigValue(source, key.path);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const accountIds = Object.keys(value);
  return accountIds.length > 0 ? accountIds : undefined;
}

function inputValue(
  context: RenderedChannelConfigParserContext,
  inputId: string,
): string | undefined {
  const value = context.inputs.find((input) => input.inputId === inputId)?.value;
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function safeAccountId(value: string | undefined): string | undefined {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    return undefined;
  }
  return value;
}
