// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { buildSubprocessEnv } from "../lib/subprocess-env.js";
import { isObjectRecord } from "../shared/object-record.js";
import {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_SENSITIVE_BASENAMES,
  isSafeCredentialPlaceholder,
  isSensitiveFile,
  sanitizeEnvFileContent,
  stripCredentials,
  valueLooksLikeSecret,
} from "./credential-filter.js";
import { SNAPSHOT_SANITIZER_PYTHON } from "./snapshot-sanitizer-python.js";

const HELPER_TIMEOUT_MS = 60_000;
const HELPER_MAX_BUFFER_BYTES = 48 * 1024 * 1024;
const MAX_SANITIZATION_PASSES = 3;

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly nlink: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface ScannedFile {
  readonly path: string;
  readonly metadata: FileIdentity;
  readonly content?: string;
}

interface ScanResult {
  readonly root: FileIdentity;
  readonly directories: Readonly<Record<string, FileIdentity>>;
  readonly files: readonly ScannedFile[];
}

interface SanitizationAction {
  readonly kind: "remove" | "replace";
  readonly path: string;
  readonly metadata: FileIdentity;
  readonly content?: string;
}

interface SnapshotRoot {
  readonly canonicalPath: string;
  readonly identity: FileIdentity;
}

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

function isFileIdentity(value: unknown): value is FileIdentity {
  if (!isObjectRecord(value)) return false;
  return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (key) => typeof value[key] === "string",
  );
}

function parseScanResult(stdout: string): ScanResult | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isObjectRecord(parsed) || !isFileIdentity(parsed.root)) return null;
    if (!isObjectRecord(parsed.directories) || !Array.isArray(parsed.files)) return null;

    const directories: Record<string, FileIdentity> = {};
    for (const [relativePath, identity] of Object.entries(parsed.directories)) {
      if (!isSafeRelativePath(relativePath) || !isFileIdentity(identity)) return null;
      directories[relativePath] = identity;
    }

    const files: ScannedFile[] = [];
    for (const value of parsed.files) {
      if (!isObjectRecord(value) || !isSafeRelativePath(value.path)) return null;
      if (!isFileIdentity(value.metadata)) return null;
      if (value.content !== undefined && typeof value.content !== "string") return null;
      files.push({
        path: value.path,
        metadata: value.metadata,
        ...(typeof value.content === "string" ? { content: value.content } : {}),
      });
    }
    return { root: parsed.root, directories, files };
  } catch {
    return null;
  }
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value)) return false;
  if (value.includes("\\")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function rootIdentity(rootPath: string): SnapshotRoot | null {
  let observed: ReturnType<typeof lstatSync>;
  try {
    observed = lstatSync(rootPath, { bigint: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error(`Migration snapshot root is not a safe directory: ${rootPath}`);
  }
  const canonicalPath = realpathSync(rootPath);
  const canonical = lstatSync(canonicalPath, { bigint: true });
  if (canonical.dev !== observed.dev || canonical.ino !== observed.ino) {
    throw new Error(`Migration snapshot root changed while it was resolved: ${rootPath}`);
  }
  return {
    canonicalPath,
    identity: {
      dev: String(observed.dev),
      ino: String(observed.ino),
      mode: String(observed.mode),
      nlink: String(observed.nlink),
      size: String(observed.size),
      mtimeNs: String(observed.mtimeNs),
      ctimeNs: String(observed.ctimeNs),
    },
  };
}

function scanSnapshot(root: SnapshotRoot, targetName?: string): ScanResult | null {
  const mode = targetName === undefined ? "scan-tree" : "scan-file";
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      SNAPSHOT_SANITIZER_PYTHON,
      mode,
      root.canonicalPath,
      JSON.stringify(root.identity),
      targetName ?? "",
      JSON.stringify([...CREDENTIAL_SENSITIVE_BASENAMES]),
    ],
    {
      encoding: "utf-8",
      env: buildSubprocessEnv(),
      maxBuffer: HELPER_MAX_BUFFER_BYTES,
      timeout: HELPER_TIMEOUT_MS,
    },
  );
  if (result.status !== 0 || result.error) return null;
  return parseScanResult(result.stdout);
}

function applyActions(
  canonicalPath: string,
  scan: ScanResult,
  actions: readonly SanitizationAction[],
): boolean {
  if (actions.length === 0) return true;
  const result = spawnSync(
    "python3",
    ["-I", "-c", SNAPSHOT_SANITIZER_PYTHON, "apply", canonicalPath],
    {
      encoding: "utf-8",
      env: buildSubprocessEnv(),
      input: JSON.stringify({ root: scan.root, directories: scan.directories, actions }),
      maxBuffer: HELPER_MAX_BUFFER_BYTES,
      timeout: HELPER_TIMEOUT_MS,
    },
  );
  return result.status === 0 && !result.error;
}

function decodeScannedContent(content: string | undefined): string | null {
  if (
    content === undefined ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content)
  ) {
    return null;
  }
  const decoded = Buffer.from(content, "base64");
  if (decoded.toString("base64") !== content) return null;
  const utf8 = decoded.toString("utf-8");
  if (!Buffer.from(utf8, "utf-8").equals(decoded)) return null;
  return utf8;
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

function actionForScannedFile(file: ScannedFile): SanitizationAction | null {
  const name = path.posix.basename(file.path).toLowerCase();
  if (isSensitiveFile(name)) {
    return { kind: "remove", path: file.path, metadata: file.metadata };
  }
  const raw = decodeScannedContent(file.content);
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
    const root = rootIdentity(rootPath);
    if (root === null) {
      if (pass === 0) return;
      throw new Error(`Failed to inspect migration artifacts safely: ${rootPath}`);
    }
    const scan = scanSnapshot(root);
    if (scan === null) {
      throw new Error(`Failed to inspect migration artifacts safely: ${rootPath}`);
    }
    const actions = scan.files
      .map((file) => actionForScannedFile(file))
      .filter((action): action is SanitizationAction => action !== null);
    if (actions.length === 0) return;
    if (!applyActions(root.canonicalPath, scan, actions)) {
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
    let root: SnapshotRoot | null;
    try {
      root = rootIdentity(parentPath);
    } catch {
      return false;
    }
    if (root === null) return false;
    const scan = scanSnapshot(root, targetName);
    if (scan === null || scan.files.length !== 1) return false;
    const file = scan.files[0];
    if (!file || file.path !== targetName) return false;
    const raw = decodeScannedContent(file.content);
    if (raw === null) return false;
    const sanitized = sanitizedContents(targetName.toLowerCase(), raw);
    if (typeof sanitized !== "string") return false;
    if (sanitized === raw) return true;
    if (
      !applyActions(root.canonicalPath, scan, [
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
