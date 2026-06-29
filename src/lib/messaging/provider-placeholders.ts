// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const OPENSHELL_ENV_PLACEHOLDER_PREFIX = "openshell:resolve:env:";
const OPENSHELL_SCOPED_PLACEHOLDER_RE = /^(xoxb|xapp)-OPENSHELL-RESOLVE-ENV-(.+)$/;
const PLACEHOLDER_CONTROL_CHAR_RE = /[\u0000\r\n\t]/;

export function normalizeProviderPlaceholderForEnvKey(
  value: string,
  envKey: string,
): string | null {
  if (PLACEHOLDER_CONTROL_CHAR_RE.test(value)) return null;
  if (value.startsWith(OPENSHELL_ENV_PLACEHOLDER_PREFIX)) {
    return placeholderSuffixMatchesEnvKey(
      value.slice(OPENSHELL_ENV_PLACEHOLDER_PREFIX.length),
      envKey,
    )
      ? `${OPENSHELL_ENV_PLACEHOLDER_PREFIX}${envKey}`
      : null;
  }
  const scopedMatch = value.match(OPENSHELL_SCOPED_PLACEHOLDER_RE);
  const scopedPrefix = scopedMatch?.[1];
  const scopedSuffix = scopedMatch?.[2];
  if (!scopedPrefix || !scopedSuffix || !placeholderSuffixMatchesEnvKey(scopedSuffix, envKey)) {
    return null;
  }
  return `${scopedPrefix}-OPENSHELL-RESOLVE-ENV-${envKey}`;
}

export function isProviderPlaceholderForEnvKey(value: string, envKey: string): boolean {
  return normalizeProviderPlaceholderForEnvKey(value, envKey) !== null;
}

function placeholderSuffixMatchesEnvKey(suffix: string, envKey: string): boolean {
  if (suffix === envKey) return true;
  const revisionMatch = suffix.match(/^v[0-9]+_(.+)$/);
  return revisionMatch?.[1] === envKey;
}
