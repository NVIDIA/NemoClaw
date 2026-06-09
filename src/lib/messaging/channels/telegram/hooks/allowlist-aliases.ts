// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";

export const TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID = "telegram.allowlistAliases";

export const TELEGRAM_ALLOWED_IDS_ENV = "TELEGRAM_ALLOWED_IDS";
export const TELEGRAM_ALLOWED_IDS_ALIAS_ENVS = [
  "TELEGRAM_AUTHORIZED_CHAT_IDS",
  "TELEGRAM_CHAT_ID",
] as const;

export interface TelegramAllowlistAliasesHookOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export function createTelegramAllowlistAliasesHook(
  options: TelegramAllowlistAliasesHookOptions = {},
): MessagingHookHandler {
  return async () => {
    const env = options.env ?? process.env;
    const value = mergeTelegramAllowlistAliases(env);
    const outputs: Record<string, MessagingHookOutputMap[string]> = {};
    if (value) {
      outputs.allowedIds = {
        kind: "config",
        value,
      };
    }
    return { outputs };
  };
}

export function createTelegramAllowlistAliasesHookRegistration(
  options: TelegramAllowlistAliasesHookOptions = {},
): MessagingHookRegistration {
  return {
    id: TELEGRAM_ALLOWLIST_ALIASES_HOOK_ID,
    handler: createTelegramAllowlistAliasesHook(options),
  };
}

export function mergeTelegramAllowlistAliases(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const values = [
    env[TELEGRAM_ALLOWED_IDS_ENV],
    ...TELEGRAM_ALLOWED_IDS_ALIAS_ENVS.map((key) => env[key]),
  ];
  const merged = mergeAllowlistValues(values);
  if (!merged) return null;
  env[TELEGRAM_ALLOWED_IDS_ENV] = merged;
  return merged;
}

function mergeAllowlistValues(values: readonly unknown[]): string | null {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.replace(/[\r\n]/g, "").trim();
    if (!normalized) continue;
    for (const entry of normalized.split(",")) {
      const id = entry.trim();
      if (!id || seen.has(id)) continue;
      ids.push(id);
      seen.add(id);
    }
  }
  return ids.length > 0 ? ids.join(",") : null;
}
