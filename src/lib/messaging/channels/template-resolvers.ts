// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type RenderTemplateContext,
  type RenderTemplateReferenceResolution,
  resolvedRenderTemplateReference,
} from "../compiler/engines/template";
import type { MessagingSerializableValue } from "../manifest";

const DEFAULT_PROXY_HOST = "10.200.0.1";
const DEFAULT_PROXY_PORT = "3128";

type BuiltInRenderTemplateResolver = (
  reference: string,
  context: RenderTemplateContext,
) => RenderTemplateReferenceResolution | undefined;

type DiscordGuildConfig = {
  readonly enabled: true;
  readonly requireMention?: boolean;
  readonly users?: readonly string[];
};

const BUILT_IN_TEMPLATE_REFERENCE_RESOLVERS: Record<string, BuiltInRenderTemplateResolver> = {
  allowedIds: resolveAllowedIdsTemplateReference,
  discord: resolveDiscordTemplateReference,
  discordProxyUrl: resolveDiscordProxyUrlTemplateReference,
  proxyUrl: resolveProxyUrlTemplateReference,
  slackConfig: resolveSlackConfigTemplateReference,
  telegramConfig: resolveTelegramConfigTemplateReference,
  wechatConfig: resolveWechatConfigTemplateReference,
};

export function createBuiltInRenderTemplateResolver(): BuiltInRenderTemplateResolver {
  return (reference, context) =>
    BUILT_IN_TEMPLATE_REFERENCE_RESOLVERS[templateReferenceKey(reference)]?.(
      reference,
      context,
    );
}

function templateReferenceKey(reference: string): string {
  const separator = reference.indexOf(".");
  return separator === -1 ? reference : reference.slice(0, separator);
}

function resolveProxyUrlTemplateReference(
  reference: string,
  context: RenderTemplateContext,
): RenderTemplateReferenceResolution | undefined {
  if (reference !== "proxyUrl") return undefined;
  return resolvedRenderTemplateReference(proxyUrl(context.env));
}

function resolveDiscordProxyUrlTemplateReference(
  reference: string,
): RenderTemplateReferenceResolution | undefined {
  if (reference !== "discordProxyUrl") return undefined;
  return resolvedRenderTemplateReference(undefined);
}

function resolveDiscordTemplateReference(
  reference: string,
  context: RenderTemplateContext,
): RenderTemplateReferenceResolution | undefined {
  switch (reference) {
    case "discord.guilds":
      return resolvedRenderTemplateReference(nonEmptyObject(discordGuilds(context)));
    case "discord.hasGuilds":
      return resolvedRenderTemplateReference(Object.keys(discordGuilds(context)).length > 0);
    case "discord.guildIds.csv":
      return resolvedRenderTemplateReference(nonEmptyCsv(Object.keys(discordGuilds(context))));
    case "discord.allowedUsers.values":
      return resolvedRenderTemplateReference(nonEmptyArray(discordAllowedUsers(context)));
    case "discord.allowedUsers.csv":
      return resolvedRenderTemplateReference(nonEmptyCsv(discordAllowedUsers(context)));
    case "discord.allowedUsers.dmPolicy":
      return resolvedRenderTemplateReference(
        discordAllowedUsers(context).length > 0 ? "allowlist" : undefined,
      );
    case "discord.allowAllUsers":
      return resolvedRenderTemplateReference(
        Object.keys(discordGuilds(context)).length > 0 &&
          discordAllowedUsers(context).length === 0
          ? true
          : undefined,
      );
    case "discord.requireMention":
      return resolvedRenderTemplateReference(discordRequireMention(context));
    default:
      return undefined;
  }
}

function resolveAllowedIdsTemplateReference(
  reference: string,
  context: RenderTemplateContext,
): RenderTemplateReferenceResolution | undefined {
  const allowedIds = reference.match(
    /^allowedIds[.]([A-Za-z0-9_-]+)[.](values|csv|dmPolicy|groupPolicy|channels)$/,
  );
  if (!allowedIds?.[1] || !allowedIds[2]) return undefined;
  return resolvedRenderTemplateReference(
    resolveAllowedIdsTemplate(allowedIds[1], allowedIds[2], context),
  );
}

function resolveTelegramConfigTemplateReference(
  reference: string,
  context: RenderTemplateContext,
): RenderTemplateReferenceResolution | undefined {
  if (reference !== "telegramConfig.requireMention") return undefined;
  return resolvedRenderTemplateReference(
    parseBoolean(stateValue(context, "telegramConfig.requireMention")),
  );
}

function resolveWechatConfigTemplateReference(
  reference: string,
  context: RenderTemplateContext,
): RenderTemplateReferenceResolution | undefined {
  const wechatConfig = reference.match(/^wechatConfig[.](accountId|baseUrl|userId)$/);
  if (!wechatConfig?.[1]) return undefined;
  return resolvedRenderTemplateReference(
    nonEmptyString(stateValue(context, "wechatConfig." + wechatConfig[1])),
  );
}

function resolveSlackConfigTemplateReference(
  reference: string,
  context: RenderTemplateContext,
): RenderTemplateReferenceResolution | undefined {
  if (reference !== "slackConfig.allowedChannels.csv") return undefined;
  return resolvedRenderTemplateReference(nonEmptyCsv(slackAllowedChannels(context)));
}

function resolveAllowedIdsTemplate(
  channel: string,
  selector: string,
  context: RenderTemplateContext,
): MessagingSerializableValue | undefined {
  const ids = allowedIds(context, channel);
  if (selector === "values") return nonEmptyArray(ids);
  if (selector === "csv") return nonEmptyCsv(ids);
  if (selector === "dmPolicy") return ids.length > 0 ? "allowlist" : undefined;
  if (selector === "groupPolicy") {
    return ids.length > 0 || (channel === "slack" && slackAllowedChannels(context).length > 0)
      ? "allowlist"
      : undefined;
  }
  if (selector === "channels" && channel === "slack") return slackChannelConfig(context, ids);
  return undefined;
}

function proxyUrl(env: RenderTemplateContext["env"]): string {
  const host = nonEmptyString(env?.NEMOCLAW_PROXY_HOST) ?? DEFAULT_PROXY_HOST;
  const port = nonEmptyString(env?.NEMOCLAW_PROXY_PORT) ?? DEFAULT_PROXY_PORT;
  return `http://${host}:${port}`;
}

function slackChannelConfig(
  context: RenderTemplateContext,
  users: readonly string[],
): Record<string, MessagingSerializableValue> | undefined {
  const allowedChannels = slackAllowedChannels(context);
  const entry: Record<string, MessagingSerializableValue> = {
    enabled: true,
    requireMention: true,
    ...(users.length > 0 ? { users: [...users] } : {}),
  };
  if (allowedChannels.length > 0) {
    return Object.fromEntries(allowedChannels.map((channelId) => [channelId, { ...entry }]));
  }
  return users.length > 0 ? { "*": entry } : undefined;
}

function discordGuilds(context: RenderTemplateContext): Record<string, DiscordGuildConfig> {
  const serverIds = parseList(stateValue(context, "discordGuilds.serverId"));
  if (serverIds.length === 0) return {};
  const users = parseList(stateValue(context, "discordGuilds.userIds"));
  const requireMention = parseBoolean(stateValue(context, "discordGuilds.requireMention")) ?? true;
  return Object.fromEntries(
    serverIds.map((serverId) => [
      serverId,
      {
        enabled: true,
        requireMention,
        ...(users.length > 0 ? { users } : {}),
      },
    ]),
  );
}

function discordAllowedUsers(context: RenderTemplateContext): string[] {
  const users = new Set(allowedIds(context, "discord"));
  for (const guild of Object.values(discordGuilds(context))) {
    for (const user of guild.users ?? []) users.add(String(user));
  }
  return [...users];
}

function discordRequireMention(context: RenderTemplateContext): boolean {
  for (const guild of Object.values(discordGuilds(context))) {
    if (typeof guild.requireMention === "boolean") return guild.requireMention;
  }
  return true;
}

function allowedIds(context: RenderTemplateContext, channel: string): string[] {
  const ids = parseList(stateValue(context, `allowedIds.${channel}`));
  if (channel !== "wechat") return ids;
  const userId = nonEmptyString(stateValue(context, "wechatConfig.userId"));
  return userId && !ids.includes(userId) ? [userId, ...ids] : ids;
}

function slackAllowedChannels(context: RenderTemplateContext): string[] {
  return parseList(stateValue(context, "slackConfig.allowedChannels"));
}

function stateValue(context: RenderTemplateContext, path: string): MessagingSerializableValue | undefined {
  const stateInput = context.inputs.find((input) => input.statePath === path);
  if (stateInput?.value !== undefined) return stateInput.value;
  const inputId = path.split(".").at(-1);
  return context.inputs.find((input) => input.inputId === inputId)?.value;
}

function parseList(value: MessagingSerializableValue | undefined): string[] {
  if (Array.isArray(value)) return unique(value.map(String).map(cleanString).filter(Boolean));
  const text = cleanString(value);
  if (!text) return [];
  return unique(text.split(",").map(cleanString).filter(Boolean));
}

function parseBoolean(value: MessagingSerializableValue | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = cleanString(value)?.toLowerCase();
  if (text === "1" || text === "true" || text === "yes" || text === "on") return true;
  if (text === "0" || text === "false" || text === "no" || text === "off") return false;
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return cleanString(value) || undefined;
}

function cleanString(value: unknown): string {
  return String(value ?? "").replace(/\r/g, "").trim();
}

function nonEmptyArray(values: readonly string[]): string[] | undefined {
  return values.length > 0 ? [...values] : undefined;
}

function nonEmptyCsv(values: readonly string[]): string | undefined {
  return values.length > 0 ? values.join(",") : undefined;
}

function nonEmptyObject<T extends Record<string, unknown>>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
