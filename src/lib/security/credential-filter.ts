// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  isConfigObject,
  isConfigValue,
  sanitizeEnvFileContent,
  stripCredentials,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";
import type {
  ConfigObject,
  ConfigValue,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";

export {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_SENSITIVE_BASENAMES,
  isConfigObject,
  isConfigValue,
  isCredentialField,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  redactCredentialText,
  sanitizeEnvFileContent,
  stripCredentials,
  valueLooksLikeSecret,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";
export type {
  ConfigObject,
  ConfigValue,
} from "../../../nemoclaw/dist/shared/credential-filter-boundary.cjs";

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function readRegularFileNoFollow(filePath: string): string | null {
  const noFollowFlag = Reflect.get(constants, "O_NOFOLLOW");
  if (typeof noFollowFlag !== "number") return null;

  let fd: number;
  try {
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
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/** Dependency lockfiles do not store NemoClaw runtime credentials. */
const SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES = new Set([
  ".package-lock.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
]);

/** Whether a filename is a dependency lockfile. */
export function isDependencyLockfile(filename: string): boolean {
  return SNAPSHOT_CREDENTIAL_SCAN_EXCLUDED_BASENAMES.has(basename(filename).toLowerCase());
}

/** Strip credential lines from a `.env` file in-place. */
export function sanitizeEnvFile(
  filePath: string,
  writeSanitized: (targetPath: string, contents: string) => void = writeFileAtomically,
): boolean {
  const raw = readRegularFileNoFollow(filePath);
  if (raw === null) return false;
  try {
    writeSanitized(filePath, sanitizeEnvFileContent(raw));
    return true;
  } catch {
    return false;
  }
}

const UNREPRESENTABLE_CONFIG_VALUE = Symbol("unrepresentable-config-value");

function toConfigValue(value: unknown): ConfigValue | typeof UNREPRESENTABLE_CONFIG_VALUE {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const items: ConfigValue[] = [];
    for (const entry of value) {
      const converted = toConfigValue(entry);
      if (converted === UNREPRESENTABLE_CONFIG_VALUE) return UNREPRESENTABLE_CONFIG_VALUE;
      items.push(converted);
    }
    return items;
  }
  if (!isConfigObject(value)) return UNREPRESENTABLE_CONFIG_VALUE;
  const result: ConfigObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const converted = toConfigValue(entry);
    if (converted === UNREPRESENTABLE_CONFIG_VALUE) return UNREPRESENTABLE_CONFIG_VALUE;
    result[key] = converted;
  }
  return result;
}

/**
 * Strip credential fields from a Hermes YAML config body.
 *
 * Returns null when the document cannot be represented safely. Empty and
 * comment-only documents are returned unchanged because they contain no
 * credential material.
 */
export function sanitizeYamlConfigContent(rawConfig: string): string | null {
  try {
    const parsed = parseYaml(rawConfig);
    if (parsed === null || parsed === undefined) return rawConfig;
    const configValue = toConfigValue(parsed);
    if (configValue === UNREPRESENTABLE_CONFIG_VALUE || !isConfigObject(configValue)) {
      return null;
    }

    const { gateway: _gateway, ...config } = configValue;
    return stringifyYaml(stripCredentials(config));
  } catch {
    return null;
  }
}

/**
 * Strip credential fields from a JSON or YAML config body.
 *
 * The filename is used only to decide whether a non-JSON document is an
 * allowed YAML target. Returns null when the input cannot be sanitized.
 * Credential-free JSON is returned byte for byte.
 */
export function sanitizeConfigFileContent(configName: string, rawConfig: string): string | null {
  try {
    const parsed = parseJson<ConfigValue | object>(rawConfig);
    if (!isConfigValue(parsed)) return null;
    let config = parsed;
    if (isConfigObject(parsed)) {
      const { gateway: _gateway, ...withoutGateway } = parsed;
      config = withoutGateway;
    }
    const stripped = stripCredentials(config);
    if (JSON.stringify(stripped) === JSON.stringify(parsed)) return rawConfig;
    return JSON.stringify(stripped, null, 2);
  } catch {
    // Fall through to YAML for Hermes and other non-JSON configs.
  }

  const normalized = basename(configName).toLowerCase();
  if (normalized.endsWith(".yaml") || normalized.endsWith(".yml")) {
    return sanitizeYamlConfigContent(rawConfig);
  }
  return null;
}

/** Strip credential fields from a Hermes YAML config file in-place. */
export function sanitizeYamlConfigFile(
  configPath: string,
  writeSanitized: (targetPath: string, contents: string) => void = writeFileAtomically,
): boolean {
  const rawConfig = readRegularFileNoFollow(configPath);
  if (rawConfig === null) return false;
  const sanitized = sanitizeYamlConfigContent(rawConfig);
  if (sanitized === null) return false;
  if (sanitized === rawConfig) return true;
  try {
    writeSanitized(configPath, sanitized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip credential fields from a JSON or YAML config file in-place.
 * Returns false when the input cannot be sanitized safely.
 */
export function sanitizeConfigFile(configPath: string): boolean {
  const rawConfig = readRegularFileNoFollow(configPath);
  if (rawConfig === null) return false;
  const sanitized = sanitizeConfigFileContent(configPath, rawConfig);
  if (sanitized === null) return false;
  if (sanitized === rawConfig) return true;
  try {
    writeFileAtomically(configPath, sanitized);
    return true;
  } catch {
    return false;
  }
}

/** Return whether coarse E2E leak checks should scan a snapshot file. */
export function shouldScanSnapshotFileForCredentials(filename: string): boolean {
  const normalizedBasename = basename(filename).toLowerCase();
  if (isDependencyLockfile(normalizedBasename)) return false;
  return (
    normalizedBasename === ".env" ||
    normalizedBasename.endsWith(".env") ||
    normalizedBasename.endsWith(".json") ||
    normalizedBasename.endsWith(".yaml") ||
    normalizedBasename.endsWith(".yml")
  );
}
