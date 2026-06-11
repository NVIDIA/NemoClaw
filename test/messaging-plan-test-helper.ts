// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_BUILDER = String.raw`
import {
  MessagingSetupApplier,
  MessagingWorkflowPlanner,
  createBuiltInChannelManifestRegistry,
  createBuiltInMessagingHookRegistry,
  createBuiltInRenderTemplateResolver,
} from "./src/lib/messaging/index.ts";

const agent = process.env.NEMOCLAW_TEST_MESSAGING_PLAN_AGENT;
const channels = JSON.parse(process.env.NEMOCLAW_TEST_MESSAGING_PLAN_CHANNELS_JSON || "[]");
const credentialAvailability = JSON.parse(
  process.env.NEMOCLAW_TEST_MESSAGING_CREDENTIAL_AVAILABILITY_JSON || "{}",
);

async function main() {
  const planner = new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      wechat: {
        seedOpenClawAccount: {
          now: () => "2026-01-01T00:00:00.000Z",
        },
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
  const plan = await planner.buildPlan({
    sandboxName: "test-sandbox",
    agent,
    workflow: "rebuild",
    isInteractive: false,
    configuredChannels: channels,
    credentialAvailability,
  });
  process.stdout.write(MessagingSetupApplier.encodePlan(plan));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
`;

export type MessagingPlanAgent = "openclaw" | "hermes";

export function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

export function withLegacyMessagingPlanEnv(
  env: Record<string, string>,
  agent: MessagingPlanAgent,
): Record<string, string> {
  if (env.NEMOCLAW_MESSAGING_PLAN_B64) return env;
  const channels = decodeJsonEnv<string[]>(env, "NEMOCLAW_MESSAGING_CHANNELS_B64", []);
  if (!Array.isArray(channels) || channels.length === 0) return env;

  const normalizedEnv = {
    ...env,
    ...legacyMessagingConfigEnv(env),
  };
  return {
    ...env,
    NEMOCLAW_MESSAGING_PLAN_B64: buildMessagingPlanB64(normalizedEnv, agent, channels),
  };
}

export function buildMessagingPlanB64(
  env: Record<string, string>,
  agent: MessagingPlanAgent,
  channels: readonly string[],
): string {
  const result = spawnSync("npx", ["tsx", "-e", PLAN_BUILDER], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      ...env,
      NEMOCLAW_TEST_MESSAGING_PLAN_AGENT: agent,
      NEMOCLAW_TEST_MESSAGING_PLAN_CHANNELS_JSON: JSON.stringify([...new Set(channels)]),
      NEMOCLAW_TEST_MESSAGING_CREDENTIAL_AVAILABILITY_JSON: JSON.stringify(
        credentialAvailability(),
      ),
    },
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to build ${agent} messaging test plan (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function legacyMessagingConfigEnv(env: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  const allowedIds = decodeJsonEnv<Record<string, unknown>>(
    env,
    "NEMOCLAW_MESSAGING_ALLOWED_IDS_B64",
    {},
  );
  assignCsv(next, "TELEGRAM_ALLOWED_IDS", allowedIds.telegram);
  assignCsv(next, "SLACK_ALLOWED_USERS", allowedIds.slack);
  assignCsv(next, "WECHAT_ALLOWED_IDS", allowedIds.wechat);
  assignCsv(next, "WHATSAPP_ALLOWED_IDS", allowedIds.whatsapp);

  const telegramConfig = decodeJsonEnv<Record<string, unknown>>(
    env,
    "NEMOCLAW_TELEGRAM_CONFIG_B64",
    {},
  );
  assignMentionMode(next, "TELEGRAM_REQUIRE_MENTION", telegramConfig.requireMention);

  const discordGuilds = decodeJsonEnv<Record<string, unknown>>(
    env,
    "NEMOCLAW_DISCORD_GUILDS_B64",
    {},
  );
  assignDiscordConfig(next, allowedIds.discord, discordGuilds);

  const wechatConfig = decodeJsonEnv<Record<string, unknown>>(
    env,
    "NEMOCLAW_WECHAT_CONFIG_B64",
    {},
  );
  assignString(next, "WECHAT_ACCOUNT_ID", wechatConfig.accountId);
  assignString(next, "WECHAT_BASE_URL", wechatConfig.baseUrl);
  assignString(next, "WECHAT_USER_ID", wechatConfig.userId);

  const slackConfig = decodeJsonEnv<Record<string, unknown>>(env, "NEMOCLAW_SLACK_CONFIG_B64", {});
  assignCsv(next, "SLACK_ALLOWED_CHANNELS", slackConfig.allowedChannels);

  return next;
}

function assignDiscordConfig(
  target: Record<string, string>,
  allowedUsers: unknown,
  guilds: Record<string, unknown>,
): void {
  const guildIds = Object.keys(guilds).filter((guildId) => guildId.trim().length > 0);
  assignCsv(target, "DISCORD_SERVER_ID", guildIds);

  const users = uniqueStrings([
    ...stringList(allowedUsers),
    ...Object.values(guilds).flatMap((entry) => (isRecord(entry) ? stringList(entry.users) : [])),
  ]);
  assignCsv(target, "DISCORD_USER_ID", users);

  for (const guildId of guildIds) {
    const guild = guilds[guildId];
    if (!isRecord(guild)) continue;
    if (typeof guild.requireMention === "boolean" || typeof guild.requireMention === "string") {
      assignMentionMode(target, "DISCORD_REQUIRE_MENTION", guild.requireMention);
      return;
    }
  }
}

function assignMentionMode(target: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "boolean") {
    target[key] = value ? "1" : "0";
    return;
  }
  assignString(target, key, value);
}

function assignString(target: Record<string, string>, key: string, value: unknown): void {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return;
  }
  const normalized = String(value).replace(/\r/g, "").trim();
  if (normalized) target[key] = normalized;
}

function assignCsv(target: Record<string, string>, key: string, value: unknown): void {
  const values = stringList(value);
  if (values.length > 0) target[key] = values.join(",");
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map((entry) => String(entry).trim()).filter(Boolean));
  }
  if (typeof value === "string") {
    return uniqueStrings(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function decodeJsonEnv<T>(env: Record<string, string>, name: string, fallback: T): T {
  const encoded = env[name];
  if (!encoded) return fallback;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialAvailability(): Record<string, boolean> {
  const keys = [
    "botToken",
    "appToken",
    "telegram.botToken",
    "discord.botToken",
    "wechat.botToken",
    "slack.botToken",
    "slack.appToken",
    "telegramBotToken",
    "discordBotToken",
    "wechatBotToken",
    "slackBotToken",
    "slackAppToken",
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "WECHAT_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
  ];
  return Object.fromEntries(keys.map((key) => [key, true]));
}
