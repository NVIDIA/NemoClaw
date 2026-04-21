// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared credential-stripping logic for config files.
//
// Used by:
//   - sandbox-state.ts (rebuild backup/restore)
//   - migration-state.ts (host→sandbox onboarding migration)
//
// Credentials must never be baked into sandbox filesystems or local backups.
// They are injected at runtime via OpenShell's provider credential mechanism.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * JSON-like configuration value supported by credential stripping.
 */
export type ConfigValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | ConfigValue[]
  | ConfigObject;

/**
 * JSON-like configuration object supported by credential stripping.
 */
export type ConfigObject = { [key: string]: ConfigValue };

const CREDENTIAL_PLACEHOLDER = "[STRIPPED_BY_MIGRATION]";

/**
 * File basenames that contain sensitive auth material and should be
 * excluded from backups entirely.
 */
export const CREDENTIAL_SENSITIVE_BASENAMES = new Set(["auth-profiles.json"]);

/**
 * Credential field names that MUST be stripped from config files.
 */
const CREDENTIAL_FIELDS = new Set([
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "resolvedKey",
]);

/**
 * Pattern-based detection for credential field names not covered by the
 * explicit set above. Matches common suffixes like accessToken, privateKey,
 * clientSecret, etc.
 */
const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

/**
 * Check whether a field name should be treated as credential-bearing.
 */
export function isCredentialField(key: string): boolean {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

/**
 * Narrow an unknown value to a JSON-like configuration object.
 */
export function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow an unknown value to a JSON-like configuration value.
 */
export function isConfigValue(value: unknown): value is ConfigValue {
  if (value === null || value === undefined) return true;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isConfigValue(entry));
  }
  if (!isConfigObject(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every((entry) => isConfigValue(entry));
}

/**
 * Recursively strip credential fields from a JSON-like object.
 * Returns a new object with sensitive values replaced by a placeholder.
 */
export function stripCredentials<T extends ConfigValue>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((value) => stripCredentials(value)) as T;
  }
  if (!isConfigObject(obj)) return obj;

  const result: ConfigObject = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = isCredentialField(key) ? CREDENTIAL_PLACEHOLDER : stripCredentials(value);
  }
  return result as T;
}

/**
 * Strip credential fields from a JSON config file in-place.
 * Removes the "gateway" section (contains auth tokens — regenerated at startup).
 */
export function sanitizeConfigFile(configPath: string): void {
  if (!existsSync(configPath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return; // Not valid JSON — skip (may be YAML for Hermes)
  }
  if (!isConfigObject(parsed)) return;

  const { gateway: _gateway, ...config } = parsed;
  const sanitized = stripCredentials(config);
  writeFileSync(configPath, JSON.stringify(sanitized, null, 2));
  chmodSync(configPath, 0o600);
}

/**
 * Check if a filename should be excluded from backups entirely.
 */
export function isSensitiveFile(filename: string): boolean {
  return CREDENTIAL_SENSITIVE_BASENAMES.has(filename.toLowerCase());
}
