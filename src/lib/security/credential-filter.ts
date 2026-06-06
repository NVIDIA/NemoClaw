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

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function readRegularFileNoFollow(filePath: string): string | null {
  let fd: number;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") {
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
    }
    const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    fd = openSync(filePath, constants.O_RDONLY | noFollowFlag);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return String(readFileSync(fd, "utf-8"));
  } finally {
    closeSync(fd);
  }
}

function writeFileAtomically(filePath: string, contents: string): void {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

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
export const CREDENTIAL_SENSITIVE_BASENAMES = new Set(["auth-profiles.json", "auth.json"]);

/**
 * Dependency lockfiles may contain package metadata that resembles credentials
 * (for example package names or tarball URLs with `sk-` substrings). They do
 * not store NemoClaw runtime credentials and should not fail snapshot leak
 * checks.
 */
const SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
]);

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
export function isConfigObject(value: ConfigValue | object): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow an unknown value to a JSON-like configuration value.
 */
export function isConfigValue(value: ConfigValue | object): value is ConfigValue {
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
export function stripCredentials(obj: null): null;
export function stripCredentials(obj: undefined): undefined;
export function stripCredentials(obj: boolean): boolean;
export function stripCredentials(obj: number): number;
export function stripCredentials(obj: string): string;
export function stripCredentials<T extends ConfigValue[]>(obj: T): T;
export function stripCredentials<T extends ConfigObject>(obj: T): T;
export function stripCredentials(obj: ConfigValue): ConfigValue;
export function stripCredentials(obj: ConfigValue): ConfigValue {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((value) => stripCredentials(value));
  }
  if (!isConfigObject(obj)) return obj;

  const result: ConfigObject = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = isCredentialField(key) ? CREDENTIAL_PLACEHOLDER : stripCredentials(value);
  }
  return result;
}

/**
 * Strip credential fields from a JSON config file in-place.
 * Removes the "gateway" section (contains auth tokens — regenerated at startup).
 */
export function sanitizeConfigFile(configPath: string): void {
  const rawConfig = readRegularFileNoFollow(configPath);
  if (rawConfig === null) return;
  let parsed: ConfigValue;
  try {
    parsed = parseJson<ConfigValue>(rawConfig);
  } catch {
    return; // Not valid JSON — skip (may be YAML for Hermes)
  }
  if (!isConfigObject(parsed)) return;

  const { gateway: _gateway, ...config } = parsed;
  const sanitized = stripCredentials(config);
  writeFileAtomically(configPath, JSON.stringify(sanitized, null, 2));
}

/**
 * Check if a filename should be excluded from backups entirely.
 */
export function isSensitiveFile(filename: string): boolean {
  return CREDENTIAL_SENSITIVE_BASENAMES.has(filename.toLowerCase());
}

/**
 * Return whether a snapshot file should be scanned for credential-looking
 * payloads by coarse-grained E2E leak checks.
 */
export function shouldScanSnapshotFileForCredentials(filename: string): boolean {
  const normalizedBasename = basename(filename).toLowerCase();
  if (SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES.has(normalizedBasename)) return false;
  return normalizedBasename === ".env" || normalizedBasename.endsWith(".env") || normalizedBasename.endsWith(".json");
}
