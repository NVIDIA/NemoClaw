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

export function canonicalPlaceholderKeys(): Set<string> {
  const channels = listChannels();
  return new Set<string>(
    channels.flatMap((c) => getChannelTokenKeys(c)).concat(webSearch.BRAVE_API_KEY_ENV),
  );
}

function findExtendedCanonicalPrefix(
  candidate: string,
  canonicalKeys: ReadonlySet<string>,
): string | null {
  for (const canon of canonicalKeys) {
    if (candidate.length > canon.length + 1 && candidate.startsWith(`${canon}_`)) {
      return canon;
    }
  }
  return null;
}

export function parseExtraPlaceholderKeys(
  raw: string | undefined | null,
  canonicalKeys: ReadonlySet<string> = new Set(),
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
    if (canonicalKeys.has(candidate)) {
      warnings.push(
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "${candidate}" — collides with a canonical channel envKey`,
      );
      continue;
    }
    if (!findExtendedCanonicalPrefix(candidate, canonicalKeys)) {
      warnings.push(
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "${candidate}" — must extend a canonical channel envKey (e.g. TELEGRAM_BOT_TOKEN_AGENT_A); arbitrary host secrets such as GITHUB_TOKEN are refused so they cannot leak into the sandbox provider gateway`,
      );
      continue;
    }
    if (seen.has(candidate)) continue;
    if (keys.length >= EXTRA_PLACEHOLDER_KEYS_MAX) {
      warnings.push(
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: capped at ${EXTRA_PLACEHOLDER_KEYS_MAX} entries; remaining tokens ignored`,
      );
      break;
    }
    seen.add(candidate);
    keys.push(candidate);
  }
  return { keys, warnings };
}

export function extraPlaceholderProviderSlug(envKey: string): string {
  return envKey.toLowerCase().replace(/_/g, "-");
}

export function registerExtraPlaceholderProviders(
  sandboxName: string,
  messagingTokenDefs: MessagingTokenDefShape[],
  log: (message: string) => void = (m) => console.warn(`  ${m}`),
): string[] {
  const parsed = parseExtraPlaceholderKeys(
    process.env[EXTRA_PLACEHOLDER_KEYS_ENV],
    canonicalPlaceholderKeys(),
  );
  for (const warning of parsed.warnings) log(warning);
  for (const envKey of parsed.keys) {
    // Match the brave-search precedence in src/lib/onboard.ts: the credential
    // store wins so a same-named host env var cannot override an out-of-process
    // credential that the operator has staged through `nemoclaw credentials
    // set`. Collapse the empty-string result from normalizeCredentialValue to
    // null so callers see one unambiguous "missing" sentinel.
    const token = getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;
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
