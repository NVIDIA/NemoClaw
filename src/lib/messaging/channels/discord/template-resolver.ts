// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RenderTemplateContext } from "../../compiler/engines/template";
import {
  allowedIds,
  type BuiltInRenderTemplateResolver,
  nonEmptyArray,
  nonEmptyCsv,
  nonEmptyObject,
  nonEmptyString,
  parseBoolean,
  parseList,
  resolvedRenderTemplateReference,
  stateValue,
} from "../template-resolver-utils";

const DEFAULT_PROXY_HOST = "10.200.0.1";
const DEFAULT_PROXY_PORT = "3128";

type DiscordGuildConfig = {
  readonly requireMention?: boolean;
  readonly users?: readonly string[];
};

export const resolveDiscordTemplateReference: BuiltInRenderTemplateResolver = (
  reference,
  context,
) => {
  if (reference === "discordProxyUrl")
    return resolvedRenderTemplateReference(proxyUrl(context.env));

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
        Object.keys(discordGuilds(context)).length > 0 && discordAllowedUsers(context).length === 0
          ? true
          : undefined,
      );
    case "discord.requireMention":
      return resolvedRenderTemplateReference(discordRequireMention(context));
    default:
      return undefined;
  }
};

function discordGuilds(context: RenderTemplateContext): Record<string, DiscordGuildConfig> {
  const serverIds = parseList(stateValue(context, "discordGuilds.serverId"));
  if (serverIds.length === 0) return {};
  const users = parseList(stateValue(context, "discordGuilds.userIds"));
  const requireMention = parseBoolean(stateValue(context, "discordGuilds.requireMention")) ?? true;
  return Object.fromEntries(
    serverIds.map((serverId) => [
      serverId,
      {
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

function proxyUrl(env: RenderTemplateContext["env"]): string {
  const host = nonEmptyString(env?.NEMOCLAW_PROXY_HOST) ?? DEFAULT_PROXY_HOST;
  const port = nonEmptyString(env?.NEMOCLAW_PROXY_PORT) ?? DEFAULT_PROXY_PORT;
  return `http://${host}:${port}`;
}
