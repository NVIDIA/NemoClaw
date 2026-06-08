// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelCredentialSpec,
  MessagingSerializableValue,
  MessagingTemplateString,
  SandboxMessagingInputReference,
} from "../../manifest";

const CREDENTIAL_PLACEHOLDER_PATTERN =
  /\{\{\s*credential\.([A-Za-z0-9_-]+)\.placeholder\s*\}\}/g;
const EXACT_TEMPLATE_PATTERN = /^\{\{\s*([^}]+?)\s*\}\}$/;
const TEMPLATE_REFERENCE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const DEFAULT_PROXY_HOST = "10.200.0.1";
const DEFAULT_PROXY_PORT = "3128";

type RenderTemplateValue = MessagingSerializableValue | undefined;

type DiscordGuildConfig = {
  readonly enabled: true;
  readonly requireMention?: boolean;
  readonly users?: readonly string[];
};

export interface RenderTemplateContext {
  readonly inputs: readonly SandboxMessagingInputReference[];
  readonly env?: Record<string, string | undefined>;
}

export function resolveSandboxNameTemplate(
  value: MessagingTemplateString,
  sandboxName: string,
): MessagingTemplateString {
  return value.replaceAll("{sandboxName}", sandboxName);
}

export function resolveCredentialTemplatesInValue(
  value: MessagingSerializableValue,
  credentials: readonly ChannelCredentialSpec[],
): MessagingSerializableValue {
  if (typeof value === "string") return resolveCredentialTemplatesInString(value, credentials);
  if (Array.isArray(value)) {
    return value.map((entry) => resolveCredentialTemplatesInValue(entry, credentials));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveCredentialTemplatesInValue(entry, credentials),
      ]),
    );
  }
  return value;
}

export function resolveCredentialTemplatesInLines(
  lines: readonly MessagingTemplateString[],
  credentials: readonly ChannelCredentialSpec[],
): MessagingTemplateString[] {
  return lines.map((line) => resolveCredentialTemplatesInString(line, credentials));
}

export function resolveRenderTemplatesInValue(
  value: MessagingSerializableValue,
  context: RenderTemplateContext,
): RenderTemplateValue {
  if (typeof value === "string") return resolveRenderTemplatesInString(value, context);
  if (Array.isArray(value)) {
    if (value.length === 0) return value;
    const resolved = value
      .map((entry) => resolveRenderTemplatesInValue(entry, context))
      .filter((entry): entry is MessagingSerializableValue => entry !== undefined);
    return resolved.length > 0 ? resolved : undefined;
  }
  if (value && typeof value === "object") {
    const sourceEntries = Object.entries(value);
    if (sourceEntries.length === 0) return value;
    const entries = sourceEntries
      .map(([key, entry]) => [key, resolveRenderTemplatesInValue(entry, context)] as const)
      .filter((entry): entry is readonly [string, MessagingSerializableValue] => entry[1] !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

export function resolveRenderTemplatesInLines(
  lines: readonly MessagingTemplateString[],
  context: RenderTemplateContext,
): MessagingTemplateString[] {
  return lines
    .map((line) => resolveRenderTemplatesInString(line, context))
    .filter((line): line is string => typeof line === "string" && line.length > 0);
}

export function isTruthyRenderTemplate(
  value: MessagingTemplateString | undefined,
  context: RenderTemplateContext,
): boolean {
  if (!value) return true;
  const resolved = resolveRenderTemplatesInString(value, context);
  if (resolved === undefined || resolved === null || resolved === false) return false;
  if (Array.isArray(resolved)) return resolved.length > 0;
  if (typeof resolved === "object") return Object.keys(resolved).length > 0;
  if (typeof resolved === "string") return resolved.trim().length > 0;
  return true;
}

export function collectTemplateReferencesInValue(
  value: MessagingSerializableValue,
): string[] {
  if (typeof value === "string") return collectTemplateReferencesInString(value);
  if (Array.isArray(value)) {
    return unique(value.flatMap((entry) => collectTemplateReferencesInValue(entry)));
  }
  if (value && typeof value === "object") {
    return unique(
      Object.values(value).flatMap((entry) => collectTemplateReferencesInValue(entry)),
    );
  }
  return [];
}

export function collectTemplateReferencesInLines(
  lines: readonly MessagingTemplateString[],
): string[] {
  return unique(lines.flatMap((line) => collectTemplateReferencesInString(line)));
}

function resolveCredentialTemplatesInString(
  value: MessagingTemplateString,
  credentials: readonly ChannelCredentialSpec[],
): MessagingTemplateString {
  return value.replace(CREDENTIAL_PLACEHOLDER_PATTERN, (match, credentialId: string) => {
    const credential = credentials.find((entry) => entry.id === credentialId);
    return credential?.placeholder ?? match;
  });
}

function resolveRenderTemplatesInString(
  value: MessagingTemplateString,
  context: RenderTemplateContext,
): RenderTemplateValue {
  const exact = value.match(EXACT_TEMPLATE_PATTERN);
  if (exact?.[1]) return resolveTemplateReference(exact[1].trim(), context);

  let omitted = false;
  const resolved = value.replace(TEMPLATE_REFERENCE_PATTERN, (match, reference: string) => {
    const replacement = resolveTemplateReference(reference.trim(), context);
    if (replacement === undefined || replacement === null) {
      omitted = true;
      return "";
    }
    if (Array.isArray(replacement)) return replacement.map(String).join(",");
    if (typeof replacement === "object") return JSON.stringify(replacement);
    return String(replacement);
  });
  return omitted ? undefined : resolved;
}

function resolveTemplateReference(
  reference: string,
  context: RenderTemplateContext,
): RenderTemplateValue {
  if (reference === "proxyUrl") return proxyUrl(context.env);
  if (reference === "discordProxyUrl") return undefined;
  if (reference === "discord.guilds") return nonEmptyObject(discordGuilds(context));
  if (reference === "discord.hasGuilds") return Object.keys(discordGuilds(context)).length > 0;
  if (reference === "discord.guildIds.csv") return nonEmptyCsv(Object.keys(discordGuilds(context)));
  if (reference === "discord.allowedUsers.values") return nonEmptyArray(discordAllowedUsers(context));
  if (reference === "discord.allowedUsers.csv") return nonEmptyCsv(discordAllowedUsers(context));
  if (reference === "discord.allowedUsers.dmPolicy") {
    return discordAllowedUsers(context).length > 0 ? "allowlist" : undefined;
  }
  if (reference === "discord.allowAllUsers") {
    return Object.keys(discordGuilds(context)).length > 0 && discordAllowedUsers(context).length === 0
      ? true
      : undefined;
  }
  if (reference === "discord.requireMention") return discordRequireMention(context);

  const allowedIds = reference.match(/^allowedIds\.([A-Za-z0-9_-]+)\.(values|csv|dmPolicy|groupPolicy|channels)$/);
  if (allowedIds?.[1] && allowedIds[2]) {
    return resolveAllowedIdsTemplate(allowedIds[1], allowedIds[2], context);
  }

  if (reference === "telegramConfig.requireMention") {
    return parseBoolean(stateValue(context, "telegramConfig.requireMention"));
  }

  const wechatConfig = reference.match(/^wechatConfig\.(accountId|baseUrl|userId)$/);
  if (wechatConfig?.[1]) return nonEmptyString(stateValue(context, `wechatConfig.${wechatConfig[1]}`));

  if (reference === "slackConfig.allowedChannels.csv") return nonEmptyCsv(slackAllowedChannels(context));

  return `{{${reference}}}`;
}

function resolveAllowedIdsTemplate(
  channel: string,
  selector: string,
  context: RenderTemplateContext,
): RenderTemplateValue {
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

function collectTemplateReferencesInString(value: MessagingTemplateString): string[] {
  return unique(
    [...value.matchAll(TEMPLATE_REFERENCE_PATTERN)]
      .map((match) => match[1]?.trim())
      .filter((reference): reference is string => typeof reference === "string" && reference.length > 0),
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
