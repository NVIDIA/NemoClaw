// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  envConfigKey,
  getEnvConfigValue,
  getStructuredConfigValue,
  getStructuredPath,
  type RenderedChannelConfigParserContext,
  type RenderedConfigSource,
  type RenderedConfigVisibilityKey,
  type RenderedChannelConfigParser,
  structuredConfigKey,
} from "../rendered-config-parser-utils";

const OPENCLAW_ACCOUNT_PATH = ["channels", "telegram", "accounts", "default"] as const;
const OPENCLAW_GROUPS_PATH = ["channels", "telegram", "groups"] as const;
const DEFAULT_OPENCLAW_GROUP_POLICY = "open";

export const telegramRenderedConfigParser: RenderedChannelConfigParser = {
  listConfigVisibilityKeys(context) {
    if (context.agentId === "openclaw") {
      const keys = [
        structuredConfigKey("allowedIds", "openclaw.json", [
          "channels",
          "telegram",
          "accounts",
          "default",
          "allowFrom",
        ]),
        structuredConfigKey("groupPolicy", "openclaw.json", [
          "channels",
          "telegram",
          "accounts",
          "default",
          "groupPolicy",
        ]),
      ];
      if (openClawGroupPolicyFromInputs(context) === "open") {
        keys.push(
          structuredConfigKey(
            "requireMention",
            "openclaw.json",
            OPENCLAW_GROUPS_PATH,
            "openclawGroupRequireMention",
          ),
        );
      }
      return keys;
    }
    if (context.agentId === "hermes") {
      return [
        envConfigKey("allowedIds", "~/.hermes/.env", "TELEGRAM_ALLOWED_USERS"),
        structuredConfigKey("requireMention", "~/.hermes/config.yaml", [
          "telegram",
          "require_mention",
        ]),
      ];
    }
    return [];
  },

  getValue(key, source) {
    if (key.key === "openclawGroupRequireMention") {
      return getOpenClawGroupRequireMention(key, source);
    }
    return key.kind === "env"
      ? getEnvConfigValue(source, key.envKey)
      : getStructuredConfigValue(source, key.path);
  },
};

function openClawGroupPolicyFromInputs(context: RenderedChannelConfigParserContext): string {
  const inputValue = context.inputs.find((input) => input.inputId === "groupPolicy")?.value;
  if (typeof inputValue === "string" && inputValue.trim()) return inputValue.trim();
  const defaultValue = context.manifest.inputs.find((input) => input.id === "groupPolicy");
  return defaultValue?.kind === "config" && defaultValue.defaultValue
    ? defaultValue.defaultValue
    : DEFAULT_OPENCLAW_GROUP_POLICY;
}

function getOpenClawGroupRequireMention(
  key: RenderedConfigVisibilityKey,
  source: RenderedConfigSource,
): boolean | boolean[] | undefined {
  const accountGroupPolicy =
    source.kind === "structured"
      ? getStructuredPath(source.value, [...OPENCLAW_ACCOUNT_PATH, "groupPolicy"])
      : undefined;
  if (accountGroupPolicy !== "open") {
    return undefined;
  }

  const groups = getStructuredConfigValue(source, key.path);
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) return false;

  const values = Object.values(groups)
    .map((group) =>
      group && typeof group === "object" && !Array.isArray(group)
        ? getStructuredPath(group, ["requireMention"])
        : undefined,
    )
    .filter((value): value is boolean => typeof value === "boolean");
  if (values.length === 0) return false;
  return [...new Set(values)].sort().length === 1 ? values[0] : [...new Set(values)].sort();
}
