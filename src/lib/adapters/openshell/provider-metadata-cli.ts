// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderMetadata } from "./provider-adapter";

const MAX_PROVIDER_OUTPUT_BYTES = 16 * 1024;
const MAX_PROVIDER_NAME_LENGTH = 128;
const MAX_PROVIDER_TYPE_LENGTH = 64;
const MAX_PROVIDER_KEYS = 32;
const MAX_PROVIDER_KEY_LENGTH = 128;
const SAFE_PROVIDER_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const SAFE_PROVIDER_KEY = /^[A-Z_][A-Z0-9_]*$/;
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/gu;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const LEADING_FIELD_LABEL_RESET_PATTERN = /^(?:\x1B\[0m)*[ \t]*/u;
const UNSAFE_FIELD_VALUE_CONTROL_PATTERN = /[\x00-\x08\x0A-\x1F\x7F-\x9F]/u;

type ProviderField = "Name" | "Type" | "Credential keys" | "Config keys";

const PROVIDER_FIELD_PATTERN = /^\s*(Name|Type|Credential keys|Config keys):\s*(.*?)\s*$/i;
const CANONICAL_PROVIDER_FIELDS = new Map<string, ProviderField>([
  ["name", "Name"],
  ["type", "Type"],
  ["credential keys", "Credential keys"],
  ["config keys", "Config keys"],
]);

export function isValidCliOpenShellProviderIdentifier(
  value: string,
  maxLength = MAX_PROVIDER_NAME_LENGTH,
): boolean {
  return value.length > 0 && value.length <= maxLength && SAFE_PROVIDER_IDENTIFIER.test(value);
}

function parseProviderKeys(value: string): string[] | null {
  if (value === "<none>") return [];

  const keys = value.split(",").map((key) => key.trim());
  if (
    keys.length === 0 ||
    keys.length > MAX_PROVIDER_KEYS ||
    keys.some(
      (key) =>
        key.length === 0 || key.length > MAX_PROVIDER_KEY_LENGTH || !SAFE_PROVIDER_KEY.test(key),
    ) ||
    new Set(keys).size !== keys.length
  ) {
    return null;
  }
  return keys;
}

function hasUnsafeRawProviderFieldValue(rawLine: string): boolean {
  const separatorIndex = rawLine.indexOf(":");
  if (separatorIndex < 0) return true;
  const rawValue = rawLine.slice(separatorIndex + 1).replace(LEADING_FIELD_LABEL_RESET_PATTERN, "");
  return UNSAFE_FIELD_VALUE_CONTROL_PATTERN.test(rawValue);
}

/** Parse bounded, non-secret metadata from `openshell provider get`. */
export function parseCliOpenShellProviderMetadata(
  output: string,
): OpenShellProviderMetadata | null {
  if (Buffer.byteLength(output, "utf8") > MAX_PROVIDER_OUTPUT_BYTES) return null;

  const fields = new Map<ProviderField, string>();
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(ANSI_OSC_PATTERN, "").replace(ANSI_CSI_PATTERN, "");
    const match = line.match(PROVIDER_FIELD_PATTERN);
    if (!match) continue;
    if (hasUnsafeRawProviderFieldValue(rawLine)) return null;
    const field = CANONICAL_PROVIDER_FIELDS.get(match[1].toLowerCase());
    if (!field || fields.has(field)) return null;
    fields.set(field, match[2].trim());
  }

  const name = fields.get("Name");
  const type = fields.get("Type");
  const credentialKeysValue = fields.get("Credential keys");
  const configKeysValue = fields.get("Config keys");
  if (
    name === undefined ||
    type === undefined ||
    credentialKeysValue === undefined ||
    configKeysValue === undefined ||
    !isValidCliOpenShellProviderIdentifier(name) ||
    !isValidCliOpenShellProviderIdentifier(type, MAX_PROVIDER_TYPE_LENGTH)
  ) {
    return null;
  }

  const credentialKeys = parseProviderKeys(credentialKeysValue);
  const configKeys = parseProviderKeys(configKeysValue);
  if (!credentialKeys || !configKeys) return null;
  return { name, type, credentialKeys, configKeys };
}
