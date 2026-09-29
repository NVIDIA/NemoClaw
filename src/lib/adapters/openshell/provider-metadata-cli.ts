// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderMetadata } from "./provider-adapter";

const MAX_PROVIDER_OUTPUT_BYTES = 16 * 1024;
const MAX_PROVIDER_NAME_LENGTH = 128;
const MAX_PROVIDER_TYPE_LENGTH = 64;
const MAX_PROVIDER_KEYS = 32;
const MAX_PROVIDER_KEY_LENGTH = 128;
const MAX_PROVIDER_INVENTORY_ENTRIES = 1_000;
const MAX_PROVIDER_INVENTORY_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ECMASCRIPT_TIMESTAMP_MS = 8_640_000_000_000_000;
const SAFE_PROVIDER_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const SAFE_PROVIDER_KEY = /^[A-Z_][A-Z0-9_]*$/;
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\|$)/gu;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;
const LEADING_FIELD_LABEL_RESET_PATTERN = /^(?:\x1B\[0m)*[ \t]*/u;
const UNSAFE_FIELD_VALUE_CONTROL_PATTERN = /[\x00-\x08\x0A-\x1F\x7F-\x9F]/u;

type ProviderField =
  | "Name"
  | "Id"
  | "Type"
  | "Resource version"
  | "Credential keys"
  | "Config keys";

const PROVIDER_FIELD_PATTERN =
  /^\s*(Name|Id|Type|Resource version|Credential keys|Config keys):\s*(.*?)\s*$/i;
const CANONICAL_PROVIDER_FIELDS = new Map<string, ProviderField>([
  ["name", "Name"],
  ["id", "Id"],
  ["type", "Type"],
  ["resource version", "Resource version"],
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

  const id = fields.get("Id");
  const resourceVersionValue = fields.get("Resource version");
  if ((id === undefined) !== (resourceVersionValue === undefined)) return null;
  if (id === undefined || resourceVersionValue === undefined) {
    return { name, type, credentialKeys, configKeys, revision: null };
  }
  const resourceVersion = Number(resourceVersionValue);
  if (
    !isValidCliOpenShellProviderIdentifier(id) ||
    !/^[0-9]+$/u.test(resourceVersionValue) ||
    !Number.isSafeInteger(resourceVersion) ||
    resourceVersion < 1
  ) {
    return null;
  }
  return {
    name,
    type,
    credentialKeys,
    configKeys,
    revision: { id, resourceVersion },
  };
}

export type CliOpenShellProviderCredentialState = Readonly<{
  credentialKeys: readonly string[];
  credentialExpiresAtMs: Readonly<Record<string, number>>;
}>;

function parseProviderKeyArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_KEYS) return null;
  const keys: string[] = [];
  for (const key of value) {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > MAX_PROVIDER_KEY_LENGTH ||
      !SAFE_PROVIDER_KEY.test(key) ||
      keys.includes(key)
    ) {
      return null;
    }
    keys.push(key);
  }
  return Object.freeze(keys);
}

/** Parse one provider's non-secret credential state from one provider inventory record. */
export function parseCliOpenShellProviderCredentialState(
  output: string,
  providerName: string,
): CliOpenShellProviderCredentialState | null | undefined {
  if (
    !isValidCliOpenShellProviderIdentifier(providerName) ||
    Buffer.byteLength(output, "utf8") > MAX_PROVIDER_INVENTORY_OUTPUT_BYTES
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PROVIDER_INVENTORY_ENTRIES) return null;

  const matchingProviders: Record<string, unknown>[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (typeof record.name !== "string" || !isValidCliOpenShellProviderIdentifier(record.name)) {
      return null;
    }
    if (record.name === providerName) matchingProviders.push(record);
  }
  // A full page without the target permits the adapter to request the next page.
  if (matchingProviders.length === 0 && parsed.length === MAX_PROVIDER_INVENTORY_ENTRIES) {
    return undefined;
  }
  if (matchingProviders.length !== 1) return null;

  const credentialKeys = parseProviderKeyArray(matchingProviders[0].credential_keys);
  if (!credentialKeys) return null;

  const rawExpirations = matchingProviders[0].credential_expires_at_ms;
  if (rawExpirations === undefined) {
    return Object.freeze({ credentialKeys, credentialExpiresAtMs: Object.freeze({}) });
  }
  if (!rawExpirations || typeof rawExpirations !== "object" || Array.isArray(rawExpirations)) {
    return null;
  }

  const entries = Object.entries(rawExpirations);
  if (entries.length > MAX_PROVIDER_KEYS) return null;
  const expirations: Record<string, number> = {};
  for (const [credentialKey, expiresAtMs] of entries) {
    if (
      credentialKey.length > MAX_PROVIDER_KEY_LENGTH ||
      !SAFE_PROVIDER_KEY.test(credentialKey) ||
      typeof expiresAtMs !== "number" ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs < 0 ||
      expiresAtMs > MAX_ECMASCRIPT_TIMESTAMP_MS
    ) {
      return null;
    }
    expirations[credentialKey] = expiresAtMs;
  }
  if (Object.keys(expirations).some((credentialKey) => !credentialKeys.includes(credentialKey))) {
    return null;
  }
  return Object.freeze({
    credentialKeys,
    credentialExpiresAtMs: Object.freeze(expirations),
  });
}
