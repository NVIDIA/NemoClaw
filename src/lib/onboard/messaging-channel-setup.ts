// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeCredentialValue,
  prompt,
  saveCredential,
} from "../credentials/store";
import {
  normalizeMessagingChannelConfigValue,
  resolveMessagingChannelConfigEnvValue,
} from "../messaging-channel-config";
import { channelHasStaticToken, type ChannelDef } from "../sandbox/channels";
import { dispatchHostQrLogin } from "./host-qr-dispatch";
import {
  getMessagingToken,
  isMessagingTokenFormatValid,
} from "./messaging-token";
import {
  formatSlackValidationFailure,
  type SlackTokenKind,
  validateSlackCredentials,
} from "./slack-validation";

type ChannelEntry = { name: string } & ChannelDef;

const getMessagingConfigValue = (envKey: string): string | null => {
  const resolved = resolveMessagingChannelConfigEnvValue(envKey, process.env);
  if (resolved.value) {
    if (!process.env[envKey]) process.env[envKey] = resolved.value;
    return resolved.value;
  }
  return normalizeMessagingChannelConfigValue(envKey, process.env[envKey]);
};

function getExistingMessagingToken(
  ch: ChannelEntry,
  envKey: string | undefined,
  label: "token" | "app token",
): string | null {
  const token = getMessagingToken(envKey);
  if (token && !isMessagingTokenFormatValid(ch, envKey, token)) {
    console.log(`  ✗ Invalid existing ${ch.name} ${label} ignored.`);
    return null;
  }
  return token;
}

type SlackTokenSlot = {
  envKey: string;
  kind: SlackTokenKind;
  label: "token" | "app token";
  promptLabel: string;
  help: string;
};

type CollectedSlackToken = {
  token: string;
  save: boolean;
  label: "token" | "app token";
};

function skipSlack(enabled: Set<string>, reason: string): null {
  console.log(`  Skipped slack (${reason})`);
  enabled.delete("slack");
  return null;
}

async function collectSlackToken(
  ch: ChannelEntry,
  slot: SlackTokenSlot,
  enabled: Set<string>,
): Promise<CollectedSlackToken | null> {
  const existing = getExistingMessagingToken(ch, slot.envKey, slot.label);
  if (existing) {
    return { token: existing, save: false, label: slot.label };
  }

  console.log("");
  console.log(`  ${slot.help}`);
  const token = normalizeCredentialValue(await prompt(`  ${slot.promptLabel}: `, { secret: true }));
  if (!token) {
    const reason =
      slot.kind === "app" ? "Socket Mode requires both tokens" : "no token entered";
    return skipSlack(enabled, reason);
  }

  if (!isMessagingTokenFormatValid(ch, slot.envKey, token)) {
    const formatHint =
      slot.kind === "app"
        ? ch.appTokenFormatHint || "Check the token and try again."
        : ch.tokenFormatHint || "Check the token and try again.";
    console.log(`  ✗ Invalid format. ${formatHint}`);
    return skipSlack(enabled, "invalid token format");
  }

  return { token, save: true, label: slot.label };
}

async function setupSlackTokens(ch: ChannelEntry, enabled: Set<string>): Promise<boolean> {
  if (!ch.envKey || !ch.appTokenEnvKey || !ch.appTokenHelp || !ch.appTokenLabel) {
    return false;
  }

  const bot = await collectSlackToken(
    ch,
    {
      envKey: ch.envKey,
      kind: "bot",
      label: "token",
      promptLabel: ch.label,
      help: ch.help,
    },
    enabled,
  );
  if (!bot) return false;

  const app = await collectSlackToken(
    ch,
    {
      envKey: ch.appTokenEnvKey,
      kind: "app",
      label: "app token",
      promptLabel: ch.appTokenLabel,
      help: ch.appTokenHelp,
    },
    enabled,
  );
  if (!app) return false;

  const validation = validateSlackCredentials({ botToken: bot.token, appToken: app.token });
  if (!validation.ok) {
    if (!bot.save && validation.credential === "bot") {
      console.log(`  ✗ Invalid existing ${ch.name} ${bot.label} ignored.`);
    }
    if (!app.save && validation.credential === "app") {
      console.log(`  ✗ Invalid existing ${ch.name} ${app.label} ignored.`);
    }
    const prefix = validation.kind === "rejected" ? "✗" : "⚠";
    console.log(`  ${prefix} ${formatSlackValidationFailure(validation)}`);
    skipSlack(
      enabled,
      validation.kind === "rejected"
        ? "invalid Slack credentials"
        : "Slack API validation unavailable",
    );
    return false;
  }
  if (validation.skipped && validation.message) {
    console.log(`  ⚠ ${validation.message}`);
  }

  if (bot.save) {
    saveCredential(ch.envKey, bot.token);
    process.env[ch.envKey] = bot.token;
    console.log(`  ✓ ${ch.name} token saved`);
  } else {
    console.log(`  ✓ ${ch.name} — already configured`);
  }
  if (app.save) {
    saveCredential(ch.appTokenEnvKey, app.token);
    process.env[ch.appTokenEnvKey] = app.token;
    console.log(`  ✓ ${ch.name} app token saved`);
  } else {
    console.log(`  ✓ ${ch.name} app token — already configured`);
  }
  return true;
}

/**
 * Prompt for token + per-channel config (app token, server ID, mention
 * mode, allowlist IDs) for each selected messaging channel. Mutates
 * `process.env` for non-secret config and saves credentials via
 * `saveCredential`. Channels where the user declined or supplied an
 * invalid token are removed from `enabled`.
 *
 * Extracted from `setupMessagingChannels` in onboard.ts so the
 * per-channel interactive loop lives outside the top-level entrypoint
 * (src/lib/onboard.ts file-growth budget).
 */
export async function setupSelectedMessagingChannels(
  selected: readonly string[],
  enabled: Set<string>,
  messagingChannels: readonly ChannelEntry[],
): Promise<void> {
  for (const name of selected) {
    const ch = messagingChannels.find((c) => c.name === name);
    if (!ch) {
      console.log(`  Unknown channel: ${name}`);
      continue;
    }
    if (ch.name === "slack" && channelHasStaticToken(ch)) {
      const configured = await setupSlackTokens(ch, enabled);
      if (!configured) continue;
    } else if (channelHasStaticToken(ch) && getExistingMessagingToken(ch, ch.envKey, "token")) {
      console.log(`  ✓ ${ch.name} — already configured`);
    } else if (ch.loginMethod === "host-qr") {
      console.log("");
      console.log(`  ${ch.help}`);
      const outcome = await dispatchHostQrLogin(ch);
      if (!outcome.ok) {
        console.log(`  Skipped ${ch.name} (${outcome.reason})`);
        enabled.delete(ch.name);
        continue;
      }
      const suffix = outcome.summary ? ` (${outcome.summary})` : "";
      console.log(`  ✓ ${ch.name} token saved${suffix}`);
    } else if (ch.loginMethod === "in-sandbox-qr") {
      console.log("");
      console.log(`  ${ch.help}`);
      console.log(
        `  ✓ ${ch.name} enabled — complete QR pairing from inside the sandbox after rebuild.`,
      );
      // Surface the post-pair diagnostic hint here too — in-sandbox-qr
      // channels skipped the shared setupNotes block below by `continue`,
      // so users would never see the `channels status` guidance otherwise.
      for (const line of ch.setupNotes ?? []) {
        console.log(`  ${line}`);
      }
      continue;
    } else {
      if (!channelHasStaticToken(ch)) continue;
      console.log("");
      console.log(`  ${ch.help}`);
      const token = normalizeCredentialValue(await prompt(`  ${ch.label}: `, { secret: true }));
      if (token && ch.tokenFormat && !ch.tokenFormat.test(token)) {
        console.log(
          `  ✗ Invalid format. ${ch.tokenFormatHint || "Check the token and try again."}`,
        );
        console.log(`  Skipped ${ch.name} (invalid token format)`);
        enabled.delete(ch.name);
        continue;
      }
      if (token) {
        saveCredential(ch.envKey, token);
        process.env[ch.envKey] = token;
        console.log(`  ✓ ${ch.name} token saved`);
      } else {
        console.log(`  Skipped ${ch.name} (no token entered)`);
        enabled.delete(ch.name);
        continue;
      }
    }
    for (const line of ch.setupNotes ?? []) {
      console.log(`  ${line}`);
    }
    if (ch.name !== "slack" && ch.appTokenEnvKey) {
      const existingAppToken = getExistingMessagingToken(ch, ch.appTokenEnvKey, "app token");
      if (existingAppToken) {
        console.log(`  ✓ ${ch.name} app token — already configured`);
      } else {
        console.log("");
        console.log(`  ${ch.appTokenHelp}`);
        const appToken = normalizeCredentialValue(
          await prompt(`  ${ch.appTokenLabel}: `, { secret: true }),
        );
        if (appToken && ch.appTokenFormat && !ch.appTokenFormat.test(appToken)) {
          console.log(
            `  ✗ Invalid format. ${ch.appTokenFormatHint || "Check the token and try again."}`,
          );
          console.log(`  Skipped ${ch.name} app token (invalid token format)`);
          enabled.delete(ch.name);
          continue;
        }
        if (appToken) {
          saveCredential(ch.appTokenEnvKey, appToken);
          process.env[ch.appTokenEnvKey] = appToken;
          console.log(`  ✓ ${ch.name} app token saved`);
        } else {
          console.log(`  Skipped ${ch.name} app token (Socket Mode requires both tokens)`);
          enabled.delete(ch.name);
          continue;
        }
      }
    }
    if (ch.serverIdEnvKey) {
      const existingServerIds = getMessagingConfigValue(ch.serverIdEnvKey) || "";
      if (existingServerIds) {
        process.env[ch.serverIdEnvKey] = existingServerIds;
        console.log(`  ✓ ${ch.name} — server ID already set: ${existingServerIds}`);
      } else {
        console.log(`  ${ch.serverIdHelp}`);
        const serverId = (await prompt(`  ${ch.serverIdLabel}: `)).trim();
        if (serverId) {
          process.env[ch.serverIdEnvKey] = serverId;
          console.log(`  ✓ ${ch.name} server ID saved`);
        } else {
          console.log(`  Skipped ${ch.name} server ID (guild channels stay disabled)`);
        }
      }
    }
    // Mention-control prompt: fires for any channel that exposes a
    // requireMention env key. Discord gates the prompt behind a configured
    // server ID (mention control only makes sense in a guild). Telegram
    // has no serverIdEnvKey because mention control applies to every group
    // the bot is added to, so the prompt always fires there. See #1737.
    const requireMentionKey = ch.requireMentionEnvKey;
    if (requireMentionKey && (!ch.serverIdEnvKey || Boolean(process.env[ch.serverIdEnvKey]))) {
      const existingRequireMention = getMessagingConfigValue(requireMentionKey);
      if (existingRequireMention === "0" || existingRequireMention === "1") {
        process.env[requireMentionKey] = existingRequireMention;
        const mode = existingRequireMention === "0" ? "all messages" : "@mentions only";
        console.log(`  ✓ ${ch.name} — reply mode already set: ${mode}`);
      } else {
        console.log(`  ${ch.requireMentionHelp}`);
        const answer = (await prompt("  Reply only when @mentioned? [Y/n]: ")).trim().toLowerCase();
        const value = answer === "n" || answer === "no" ? "0" : "1";
        process.env[requireMentionKey] = value;
        const mode = value === "0" ? "all messages" : "@mentions only";
        console.log(`  ✓ ${ch.name} reply mode saved: ${mode}`);
      }
    }
    // Prompt for user/sender ID when the channel supports allowlisting
    if (ch.userIdEnvKey && (!ch.serverIdEnvKey || process.env[ch.serverIdEnvKey])) {
      const existingIds = getMessagingConfigValue(ch.userIdEnvKey) || "";
      if (existingIds) {
        process.env[ch.userIdEnvKey] = existingIds;
        console.log(`  ✓ ${ch.name} — allowed IDs already set: ${existingIds}`);
      } else {
        console.log(`  ${ch.userIdHelp}`);
        const userId = (await prompt(`  ${ch.userIdLabel}: `)).trim();
        if (userId) {
          process.env[ch.userIdEnvKey] = userId;
          console.log(`  ✓ ${ch.name} allowed IDs saved`);
        } else {
          const skippedReason =
            ch.allowIdsMode === "guild"
              ? "any member in the configured server can message the bot"
              : "bot will require manual pairing";
          console.log(`  Skipped ${ch.name} user ID (${skippedReason})`);
        }
      }
    }
    if (ch.channelIdEnvKey && (!ch.serverIdEnvKey || process.env[ch.serverIdEnvKey])) {
      const existingChannelIds = getMessagingConfigValue(ch.channelIdEnvKey) || "";
      if (existingChannelIds) {
        process.env[ch.channelIdEnvKey] = existingChannelIds;
        console.log(`  ✓ ${ch.name} — channel IDs already set: ${existingChannelIds}`);
      } else {
        console.log(`  ${ch.channelIdHelp}`);
        const channelIds = (await prompt(`  ${ch.channelIdLabel}: `)).trim();
        if (channelIds) {
          process.env[ch.channelIdEnvKey] = channelIds;
          console.log(`  ✓ ${ch.name} channel IDs saved`);
        } else {
          console.log(`  Skipped ${ch.name} channel IDs (channel @mentions stay disabled)`);
        }
      }
    }
  }
}
