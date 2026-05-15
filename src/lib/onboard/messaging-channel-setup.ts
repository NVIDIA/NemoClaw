// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getCredential,
  normalizeCredentialValue,
  prompt,
  saveCredential,
} from "../credentials/store";
import { normalizeMessagingChannelConfigValue } from "../messaging-channel-config";
import { channelHasStaticToken, type ChannelDef } from "../sandbox/channels";
import { dispatchHostQrLogin } from "./host-qr-dispatch";

type ChannelEntry = { name: string } & ChannelDef;

const getMessagingToken = (envKey: string): string | null =>
  getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

const getMessagingConfigValue = (envKey: string): string | null =>
  normalizeMessagingChannelConfigValue(envKey, process.env[envKey]);

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
    if (channelHasStaticToken(ch) && getMessagingToken(ch.envKey)) {
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
    if (ch.appTokenEnvKey) {
      const existingAppToken = getMessagingToken(ch.appTokenEnvKey);
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
  }
}
