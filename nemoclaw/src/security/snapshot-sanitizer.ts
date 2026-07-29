// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isObjectRecord } from "../shared/object-record.js";
import {
  CREDENTIAL_PLACEHOLDER,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  sanitizeEnvFileContent,
  stripCredentials,
  valueLooksLikeSecret,
} from "./credential-filter.js";

function sanitizeTopLevelValue(value: unknown): unknown {
  if (typeof value !== "string" || isSafeCredentialPlaceholder(value)) {
    return stripCredentials(value);
  }
  return valueLooksLikeSecret(value) ? CREDENTIAL_PLACEHOLDER : value;
}

function withoutGateway(value: unknown): unknown {
  if (!isObjectRecord(value)) return value;
  const { gateway: _gateway, ...config } = value;
  return config;
}

function writeSnapshotFile(filePath: string, contents: string): boolean {
  const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { mode: 0o600 });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
    return true;
  } catch {
    rmSync(temporaryPath, { force: true });
    return false;
  }
}

function readRegularSnapshotFile(filePath: string): string | null {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function sanitizeJsonFile(filePath: string): boolean {
  const raw = readRegularSnapshotFile(filePath);
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON5.parse(raw);
    const sanitized = sanitizeTopLevelValue(withoutGateway(parsed));
    return writeSnapshotFile(filePath, JSON.stringify(sanitized, null, 2));
  } catch {
    return false;
  }
}

function sanitizeYamlFile(filePath: string): boolean {
  const raw = readRegularSnapshotFile(filePath);
  if (raw === null) return false;
  try {
    const parsed: unknown = parseYaml(raw);
    if (parsed === null || parsed === undefined) return true;
    const sanitized = sanitizeTopLevelValue(withoutGateway(parsed));
    return writeSnapshotFile(filePath, stringifyYaml(sanitized));
  } catch {
    return false;
  }
}

function sanitizeEnvFile(filePath: string): boolean {
  const raw = readRegularSnapshotFile(filePath);
  if (raw === null) return false;
  return writeSnapshotFile(filePath, sanitizeEnvFileContent(raw));
}

function removeUnsafeArtifact(filePath: string): void {
  rmSync(filePath, { force: true });
  if (existsSync(filePath)) {
    throw new Error(`Unable to remove unsanitizable migration artifact: ${filePath}`);
  }
}

function sanitizeFile(filePath: string): void {
  const name = path.basename(filePath).toLowerCase();
  if (isSensitiveFile(name)) {
    removeUnsafeArtifact(filePath);
    return;
  }

  let sanitized = true;
  if (name.endsWith(".json")) {
    sanitized = sanitizeJsonFile(filePath);
  } else if (name.endsWith(".yaml") || name.endsWith(".yml")) {
    sanitized = sanitizeYamlFile(filePath);
  } else if (name === ".env" || name.endsWith(".env")) {
    sanitized = sanitizeEnvFile(filePath);
  }
  if (!sanitized) removeUnsafeArtifact(filePath);
}

/**
 * Recursively sanitize every copied migration artifact before it can be
 * archived or prepared for the sandbox. Symlinks are left untouched for the
 * existing manifest audit and are never followed by this walk.
 */
export function sanitizeMigrationDirectory(rootPath: string): void {
  if (!existsSync(rootPath)) return;
  for (const entry of readdirSync(rootPath)) {
    const fullPath = path.join(rootPath, entry);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      sanitizeMigrationDirectory(fullPath);
    } else if (stat.isFile()) {
      sanitizeFile(fullPath);
    }
  }
}

/**
 * Sanitize a required OpenClaw configuration copy.
 */
export function sanitizeOpenClawConfigFile(configPath: string): boolean {
  return sanitizeJsonFile(configPath);
}
