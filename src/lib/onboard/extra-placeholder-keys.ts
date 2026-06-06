// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential, normalizeCredentialValue } from "../credentials/store";
import { getChannelTokenKeys, listChannels } from "../sandbox/channels";
import * as webSearch from "../inference/web-search";

interface MessagingTokenDefShape {
  name: string;
  envKey: string;
  token: string | null;
  providerType?: string;
}

export const EXTRA_PLACEHOLDER_KEYS_ENV = "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS";

export const EXTRA_PLACEHOLDER_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export const EXTRA_PLACEHOLDER_KEYS_MAX = 32;

export interface ExtraPlaceholderKeysResult {
  readonly keys: readonly string[];
  readonly warnings: readonly string[];
}

export function parseExtraPlaceholderKeys(
  raw: string | undefined | null,
  reservedKeys: ReadonlySet<string> = new Set(),
): ExtraPlaceholderKeysResult {
  if (!raw || !raw.trim()) {
    return { keys: [], warnings: [] };
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  const keys: string[] = [];
  const tokens = raw.split(/[\s,]+/).filter((t) => t.length > 0);
  for (const candidate of tokens) {
    if (!EXTRA_PLACEHOLDER_KEY_PATTERN.test(candidate)) {
      warnings.push(
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "${candidate}" — must match /^[A-Z][A-Z0-9_]{0,127}$/`,
      );
      continue;
    }
    if (reservedKeys.has(candidate)) {
      warnings.push(
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "${candidate}" — collides with a canonical channel envKey`,
      );
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    keys.push(candidate);
    if (keys.length >= EXTRA_PLACEHOLDER_KEYS_MAX) {
      warnings.push(
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: capped at ${EXTRA_PLACEHOLDER_KEYS_MAX} entries; remaining tokens ignored`,
      );
      break;
    }
  }
  return { keys, warnings };
}

export function extraPlaceholderProviderSlug(envKey: string): string {
  return envKey.toLowerCase().replace(/_/g, "-");
}

export function reservedPlaceholderKeysFromChannels(): Set<string> {
  const channels = listChannels();
  return new Set<string>(
    channels.flatMap((c) => getChannelTokenKeys(c)).concat(webSearch.BRAVE_API_KEY_ENV),
  );
}

export function registerExtraPlaceholderProviders(
  sandboxName: string,
  messagingTokenDefs: MessagingTokenDefShape[],
  log: (message: string) => void = (m) => console.warn(`  ${m}`),
): string[] {
  const parsed = parseExtraPlaceholderKeys(
    process.env[EXTRA_PLACEHOLDER_KEYS_ENV],
    reservedPlaceholderKeysFromChannels(),
  );
  for (const warning of parsed.warnings) log(warning);
  for (const envKey of parsed.keys) {
    const token = normalizeCredentialValue(process.env[envKey]) || getCredential(envKey);
    messagingTokenDefs.push({
      name: `${sandboxName}-extra-${extraPlaceholderProviderSlug(envKey)}`,
      envKey,
      token,
      providerType: "generic",
    });
  }
  return [...parsed.keys];
}

export function appendExtraPlaceholderKeysEnvArg(
  envArgs: string[],
  extraKeys: readonly string[],
  formatEnvAssignment: (key: string, value: string) => string,
): void {
  if (extraKeys.length === 0) return;
  envArgs.push(formatEnvAssignment(EXTRA_PLACEHOLDER_KEYS_ENV, extraKeys.join(" ")));
}
