// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

export type GatewayProviderMetadata = {
  name: string;
  type: string;
  credentialKeys: string[];
  configKeys: string[];
};

export type GatewayProviderBinding = {
  name: string;
  type: string;
  credentialKey: string;
  configKey: string;
};

/** Match the complete non-secret provider identity used for route decisions. */
export function matchesGatewayProviderBinding(
  metadata: GatewayProviderMetadata | null,
  expected: GatewayProviderBinding,
): boolean {
  return Boolean(
    metadata &&
      metadata.name === expected.name &&
      metadata.type === expected.type &&
      metadata.credentialKeys.length === 1 &&
      metadata.credentialKeys[0] === expected.credentialKey &&
      metadata.configKeys.length === 1 &&
      metadata.configKeys[0] === expected.configKey,
  );
}

type GatewayProviderCommandResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

type GatewayProviderRunner = (
  args: string[],
  options: {
    ignoreError: true;
    suppressOutput: true;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => GatewayProviderCommandResult;

type ProviderField = "Name" | "Type" | "Credential keys" | "Config keys";

const PROVIDER_FIELD_PATTERN = /^\s*(Name|Type|Credential keys|Config keys):\s*(.*?)\s*$/i;
const CANONICAL_PROVIDER_FIELDS = new Map<string, ProviderField>([
  ["name", "Name"],
  ["type", "Type"],
  ["credential keys", "Credential keys"],
  ["config keys", "Config keys"],
]);

function isSafeIdentifier(value: string, maxLength: number): boolean {
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

function commandStreamText(value: string | Buffer | null | undefined): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : (value ?? "");
}

function hasUnsafeRawProviderFieldValue(rawLine: string): boolean {
  const separatorIndex = rawLine.indexOf(":");
  if (separatorIndex < 0) return true;
  const rawValue = rawLine.slice(separatorIndex + 1).replace(LEADING_FIELD_LABEL_RESET_PATTERN, "");
  return UNSAFE_FIELD_VALUE_CONTROL_PATTERN.test(rawValue);
}

/**
 * Parse the non-secret identity and binding keys emitted by `openshell provider get`.
 * Provider display output is untrusted: it must stay bounded, contain each required
 * field exactly once, and use only the syntax accepted by recovery decisions.
 * Provider-specific binding semantics remain at the authorization boundary in
 * `assessRecoveredProviderCredentialReuse`; this parser deliberately has no
 * selected-provider context and cannot authorize credential reuse by itself.
 */
export function parseGatewayProviderMetadata(output: string): GatewayProviderMetadata | null {
  if (Buffer.byteLength(output, "utf8") > MAX_PROVIDER_OUTPUT_BYTES) return null;

  const fields = new Map<ProviderField, string>();

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(ANSI_OSC_PATTERN, "").replace(ANSI_CSI_PATTERN, "");
    const match = line.match(PROVIDER_FIELD_PATTERN);
    if (!match) continue;
    // OpenShell styles field labels, then emits identity values as plain text.
    // Permit the label's immediate SGR reset, but reject escape/control bytes
    // once the semantic value begins instead of normalizing an injected value.
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
    !isSafeIdentifier(name, MAX_PROVIDER_NAME_LENGTH) ||
    !isSafeIdentifier(type, MAX_PROVIDER_TYPE_LENGTH)
  ) {
    return null;
  }

  const credentialKeys = parseProviderKeys(credentialKeysValue);
  const configKeys = parseProviderKeys(configKeysValue);
  if (!credentialKeys || !configKeys) return null;

  return { name, type, credentialKeys, configKeys };
}

/** Read one exact provider identity without reading or exporting credential values. */
export function readGatewayProviderMetadata(
  name: string,
  runOpenshell: GatewayProviderRunner,
): GatewayProviderMetadata | null {
  if (!isSafeIdentifier(name, MAX_PROVIDER_NAME_LENGTH)) return null;

  const result = runOpenshell(["provider", "get", name], {
    ignoreError: true,
    suppressOutput: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;

  const output = `${commandStreamText(result.stdout)}\n${commandStreamText(result.stderr)}`;
  const metadata = parseGatewayProviderMetadata(output);
  return metadata?.name === name ? metadata : null;
}
