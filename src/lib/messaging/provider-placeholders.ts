// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const OPENSHELL_ENV_PLACEHOLDER_PREFIX = "openshell:resolve:env:";
const OPENSHELL_SCOPED_PLACEHOLDER_RE = /^[A-Za-z0-9]+-OPENSHELL-RESOLVE-ENV-(.+)$/;

export function normalizeProviderPlaceholderForEnvKey(
  value: string,
  envKey: string,
): string | null {
  if (value.startsWith(OPENSHELL_ENV_PLACEHOLDER_PREFIX)) {
    return placeholderSuffixMatchesEnvKey(
      value.slice(OPENSHELL_ENV_PLACEHOLDER_PREFIX.length),
      envKey,
    )
      ? `${OPENSHELL_ENV_PLACEHOLDER_PREFIX}${envKey}`
      : null;
  }
  const scopedMatch = value.match(OPENSHELL_SCOPED_PLACEHOLDER_RE);
  if (!scopedMatch || !placeholderSuffixMatchesEnvKey(scopedMatch[1] as string, envKey)) {
    return null;
  }
  return value.replace(/-OPENSHELL-RESOLVE-ENV-.+$/, `-OPENSHELL-RESOLVE-ENV-${envKey}`);
}

export function isProviderPlaceholderForEnvKey(value: string, envKey: string): boolean {
  return normalizeProviderPlaceholderForEnvKey(value, envKey) !== null;
}

function placeholderSuffixMatchesEnvKey(suffix: string, envKey: string): boolean {
  if (suffix === envKey) return true;
  const revisionMatch = suffix.match(/^v[0-9]+_(.+)$/);
  return revisionMatch?.[1] === envKey;
}
