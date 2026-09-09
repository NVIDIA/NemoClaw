// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential, normalizeCredentialValue } from "../credentials/store";
import * as webSearch from "../inference/web-search";
import { getChannelTokenKeys, listChannels } from "../sandbox/channels";

interface MessagingTokenDefShape {
  name: string;
  envKey: string;
  token: string | null;
  providerType?: string;
  additionalCredentials?: Array<{ envKey: string; token: string | null }>;
}

export interface ExtraPlaceholderCredentialSources {
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly getCredential: (envKey: string) => string | null;
  readonly normalizeCredentialValue: (value: string | undefined) => string;
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
    channels
      .flatMap((c) => getChannelTokenKeys(c))
      .concat(webSearch.BRAVE_API_KEY_ENV, webSearch.TAVILY_API_KEY_ENV),
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
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "${candidate}" — collides with a canonical credential environment-variable name`,
      );
      continue;
    }
    if (!findExtendedCanonicalPrefix(candidate, canonicalKeys)) {
      warnings.push(
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "${candidate}" — must extend a canonical credential environment-variable name; arbitrary host secrets such as GITHUB_TOKEN are refused so they cannot leak into the sandbox provider gateway`,
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

export function registerExtraPlaceholderProviders(
  messagingTokenDefs: MessagingTokenDefShape[],
  log: (message: string) => void = (m) => console.warn(`  ${m}`),
  sources: ExtraPlaceholderCredentialSources = {
    env: process.env,
    getCredential,
    normalizeCredentialValue,
  },
): string[] {
  const canonicalKeys = canonicalPlaceholderKeys();
  const parsed = parseExtraPlaceholderKeys(sources.env[EXTRA_PLACEHOLDER_KEYS_ENV], canonicalKeys);
  const acceptedKeys: string[] = [];
  for (const warning of parsed.warnings) log(warning);
  for (const envKey of parsed.keys) {
    // Match web-search precedence: the credential store wins over host env.
    const token =
      sources.getCredential(envKey) ||
      sources.normalizeCredentialValue(sources.env[envKey]) ||
      null;
    const canonicalEnvKey = findExtendedCanonicalPrefix(envKey, canonicalKeys);
    const canonicalProvider = messagingTokenDefs.find(
      (definition) => definition.envKey === canonicalEnvKey,
    );
    if (!canonicalProvider) {
      log(
        `${EXTRA_PLACEHOLDER_KEYS_ENV}: ignoring "${envKey}" — its canonical credential is not part of the selected sandbox plan`,
      );
      continue;
    }
    canonicalProvider.additionalCredentials ??= [];
    canonicalProvider.additionalCredentials.push({ envKey, token });
    acceptedKeys.push(envKey);
  }
  return acceptedKeys;
}

export function appendExtraPlaceholderKeysEnvArg(
  envArgs: string[],
  extraKeys: readonly string[],
  formatEnvAssignment: (key: string, value: string) => string,
): void {
  if (extraKeys.length === 0) return;
  // OpenShell's Docker supervisor deserializes OPENSHELL_SANDBOX_COMMAND with
  // split_whitespace(). Commas preserve this list as one env assignment when
  // the Docker GPU compatibility path transports the command through that
  // variable; both host and sandbox parsers accept comma separators.
  envArgs.push(formatEnvAssignment(EXTRA_PLACEHOLDER_KEYS_ENV, extraKeys.join(",")));
}
