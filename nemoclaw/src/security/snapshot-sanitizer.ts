// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import JSON5 from "json5";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isObjectRecord } from "../shared/object-record.js";
import {
  applyDescriptorSnapshotActions,
  type DescriptorSnapshotRoot,
  decodeDescriptorSnapshotContent,
  inspectDescriptorSnapshotRoot,
  type SnapshotSanitizationAction,
  type SnapshotScannedFile,
  scanDescriptorSnapshot,
} from "../shared/snapshot-sanitizer-boundary.cjs";
import {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_SENSITIVE_BASENAMES,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  sanitizeEnvFileContent,
  stripCredentials,
  valueLooksLikeSecret,
} from "./credential-filter.js";

const MAX_SANITIZATION_PASSES = 3;

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

function sanitizedContents(name: string, raw: string): string | null | undefined {
  try {
    if (name.endsWith(".json")) {
      const parsed: unknown = JSON5.parse(raw);
      return JSON.stringify(sanitizeTopLevelValue(withoutGateway(parsed)), null, 2);
    }
    if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      const parsed: unknown = parseYaml(raw);
      if (parsed === null || parsed === undefined) return undefined;
      return stringifyYaml(sanitizeTopLevelValue(withoutGateway(parsed)));
    }
    if (name === ".env" || name.endsWith(".env")) {
      return sanitizeEnvFileContent(raw);
    }
  } catch {
    return null;
  }
  return undefined;
}

function actionForScannedFile(file: SnapshotScannedFile): SnapshotSanitizationAction | null {
  const name = path.posix.basename(file.path).toLowerCase();
  if (isSensitiveFile(name)) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }
  const raw = decodeDescriptorSnapshotContent(file.content);
  if (raw === null) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }
  const sanitized = sanitizedContents(name, raw);
  if (sanitized === undefined) return null;
  if (sanitized === null) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }
  if (sanitized === raw) return null;
  return {
    kind: "replace",
    path: file.path,
    metadata: file.metadata,
    content: Buffer.from(sanitized, "utf-8").toString("base64"),
  };
}

/**
 * Recursively sanitize every copied migration artifact before it can be
 * archived or prepared for the sandbox. Symlinks are left untouched for the
 * existing manifest audit and are never followed by this walk.
 */
export function sanitizeMigrationDirectory(rootPath: string): void {
  for (let pass = 0; pass < MAX_SANITIZATION_PASSES; pass += 1) {
    const root = inspectDescriptorSnapshotRoot(rootPath);
    if (root === null) {
      if (pass === 0) return;
      throw new Error(`Failed to inspect migration artifacts safely: ${rootPath}`);
    }
    const scan = scanDescriptorSnapshot(root, CREDENTIAL_SENSITIVE_BASENAMES);
    if (scan === null) {
      throw new Error(`Failed to inspect migration artifacts safely: ${rootPath}`);
    }
    const actions = scan.files
      .map((file) => actionForScannedFile(file))
      .filter((action): action is SnapshotSanitizationAction => action !== null);
    if (actions.length === 0) return;
    if (!applyDescriptorSnapshotActions(root, scan, actions)) {
      throw new Error(`Failed to sanitize migration artifacts safely: ${rootPath}`);
    }
  }
  throw new Error(`Migration artifacts did not reach a stable sanitized state: ${rootPath}`);
}

/**
 * Sanitize a required OpenClaw configuration copy.
 */
export function sanitizeOpenClawConfigFile(configPath: string): boolean {
  const parentPath = path.dirname(configPath);
  const targetName = path.basename(configPath);
  if (targetName === "" || targetName === "." || targetName === "..") return false;
  for (let pass = 0; pass < MAX_SANITIZATION_PASSES; pass += 1) {
    let root: DescriptorSnapshotRoot | null;
    try {
      root = inspectDescriptorSnapshotRoot(parentPath);
    } catch {
      return false;
    }
    if (root === null) return false;
    const scan = scanDescriptorSnapshot(root, CREDENTIAL_SENSITIVE_BASENAMES, targetName);
    if (scan === null || scan.files.length !== 1) return false;
    const file = scan.files[0];
    if (!file || file.path !== targetName) return false;
    const raw = decodeDescriptorSnapshotContent(file.content);
    if (raw === null) return false;
    const sanitized = sanitizedContents(targetName.toLowerCase(), raw);
    if (typeof sanitized !== "string") return false;
    if (sanitized === raw) return true;
    if (
      !applyDescriptorSnapshotActions(root, scan, [
        {
          kind: "replace",
          path: file.path,
          metadata: file.metadata,
          content: Buffer.from(sanitized, "utf-8").toString("base64"),
        },
      ])
    ) {
      return false;
    }
  }
  return false;
}
