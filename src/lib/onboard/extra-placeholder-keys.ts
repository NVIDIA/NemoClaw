// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
