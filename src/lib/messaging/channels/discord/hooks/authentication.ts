// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";
import {
  createTokenPasteHook,
  type TokenPasteHookOptions,
} from "../../../hooks/common/token-paste";
import { getVersion } from "../../../../core/version";
import { cliName } from "../../../../onboard/branding";

export const DISCORD_TOKEN_PASTE_HOOK_HANDLER_ID = "discord.tokenPaste";
const IDENTITY_URL = "https://discord.com/api/v10/users/@me";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_IDENTITY_BYTES = 16_384;

export interface DiscordAuthenticationHookOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

type Authentication = "accepted" | "rejected" | "rate_limited" | "unverified";

export function createDiscordAuthenticationHook(
  options: DiscordAuthenticationHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    const token = context.inputs?.botToken;
    const result =
      typeof token === "string" && token.trim() ? await authenticate(token, options) : "unverified";
    const log = options.log ?? console.log;
    if (result === "accepted") {
      log("  ✓ Discord accepted the bot token.");
      return {};
    }
    const reason =
      result === "rejected"
        ? "Discord rejected the bot token (HTTP 401). Replace DISCORD_BOT_TOKEN with a bot token from the Discord Developer Portal."
        : result === "rate_limited"
          ? "Discord rate-limited token verification. Wait before retrying."
          : "Discord authentication could not be verified. Check access to discord.com and retry.";
    const message = `Discord remains inactive. ${reason} Run ${cliName()} <sandbox-name> channels add discord to retry enrollment.`;
    log(`  ⚠ ${message}`);
    throw new Error(message);
  };
}

export function createDiscordTokenPasteHookRegistration(
  options: DiscordAuthenticationHookOptions = {},
  tokenPasteOptions: TokenPasteHookOptions = {},
): MessagingHookRegistration {
  const verify = createDiscordAuthenticationHook(options);
  return {
    id: DISCORD_TOKEN_PASTE_HOOK_HANDLER_ID,
    handler: createTokenPasteHook({
      ...tokenPasteOptions,
      beforePersist: async (context, outputs) => {
        await verify({
          ...context,
          inputs: { ...context.inputs, botToken: outputs.botToken?.value ?? null },
        });
      },
    }),
  };
}

async function authenticate(
  token: string,
  options: DiscordAuthenticationHookOptions,
): Promise<Authentication> {
  const controller = new AbortController();
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.min(options.timeoutMs, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<Authentication> => {
        const response = await (options.fetch ?? fetch)(IDENTITY_URL, {
          headers: {
            Authorization: `Bot ${token}`,
            "User-Agent": `DiscordBot (https://github.com/NVIDIA/NemoClaw, ${getVersion()})`,
            "Content-Type": "application/json",
          },
          redirect: "error",
          signal: controller.signal,
        });
        try {
          if (response.status === 401) return "rejected";
          if (response.status === 429) return "rate_limited";
          if (response.status !== 200 || !response.body) return "unverified";
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              length += chunk.value.length;
              if (length > MAX_IDENTITY_BYTES) return "unverified";
              chunks.push(chunk.value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          const user: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          return typeof user === "object" &&
            user !== null &&
            "bot" in user &&
            user.bot === true &&
            "id" in user &&
            typeof user.id === "string" &&
            /^\d+$/.test(user.id)
            ? "accepted"
            : "unverified";
        } finally {
          if (!response.body?.locked) await response.body?.cancel();
        }
      })(),
      new Promise<Authentication>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("unverified");
        }, timeoutMs);
      }),
    ]);
  } catch {
    return "unverified";
  } finally {
    clearTimeout(timer);
  }
}
