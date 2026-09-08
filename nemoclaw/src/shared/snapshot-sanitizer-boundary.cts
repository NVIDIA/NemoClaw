// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const HELPER_TIMEOUT_MS = 60_000;
const HELPER_MAX_BUFFER_BYTES = 48 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BASE64_LENGTH = Math.ceil(MAX_SNAPSHOT_FILE_BYTES / 3) * 4;
let snapshotSanitizerHelperPathForTest: string | null | undefined;

export interface SnapshotFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly nlink: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface SnapshotScannedFile {
  readonly path: string;
  readonly metadata: SnapshotFileIdentity;
  readonly content?: string;
}

export interface DescriptorSnapshotRoot {
  readonly canonicalPath: string;
  readonly identity: SnapshotFileIdentity;
}

export interface DescriptorSnapshotScan {
  readonly root: SnapshotFileIdentity;
  readonly files: readonly SnapshotScannedFile[];
}

export type SnapshotSanitizationAction =
  | {
      readonly kind: "remove";
      readonly path: string;
      readonly metadata: SnapshotFileIdentity;
    }
  | {
      readonly kind: "replace";
      readonly path: string;
      readonly metadata: SnapshotFileIdentity;
      readonly content: string;
    };

type HelperResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly prerequisite?: boolean };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileIdentity(value: unknown): value is SnapshotFileIdentity {
  if (!isObjectRecord(value)) return false;
  return ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (key) => typeof value[key] === "string",
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value)) return false;
  if (value.includes("\\")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function parseScanResult(value: unknown): DescriptorSnapshotScan | null {
  if (!isObjectRecord(value) || !isFileIdentity(value.root)) return null;
  if (!Array.isArray(value.files)) return null;

  const files: SnapshotScannedFile[] = [];
  for (const candidate of value.files) {
    if (!isObjectRecord(candidate) || !isSafeRelativePath(candidate.path)) return null;
    if (!isFileIdentity(candidate.metadata)) return null;
    if (candidate.content !== undefined && typeof candidate.content !== "string") return null;
    files.push({
      path: candidate.path,
      metadata: candidate.metadata,
      ...(typeof candidate.content === "string" ? { content: candidate.content } : {}),
    });
  }
  return { root: value.root, files };
}

/** Resolve the packaged Node helper beside this source or compiled boundary. */
export function resolveSnapshotSanitizerHelperPath(): string {
  const extension = __filename.endsWith(".cts") ? ".mts" : ".mjs";
  return path.join(__dirname, `snapshot-sanitizer-helper${extension}`);
}

/** @visibleForTesting Install an explicit helper substitute without weakening production lookup. */
export function setSnapshotSanitizerHelperPathForTest(helperPath: string | null | undefined): void {
  if (process.env.VITEST !== "true") {
    throw new Error("Snapshot sanitizer helper substitution is only available under Vitest");
  }
  if (typeof helperPath === "string" && !path.isAbsolute(helperPath)) {
    throw new Error("Snapshot sanitizer test helper path must be absolute");
  }
  snapshotSanitizerHelperPathForTest = helperPath;
}

function snapshotSanitizerHelperPath(): string | null {
  if (process.env.VITEST === "true" && snapshotSanitizerHelperPathForTest !== undefined) {
    return snapshotSanitizerHelperPathForTest;
  }
  return resolveSnapshotSanitizerHelperPath();
}

/** Native snapshot support is absent, so the sanitizer cannot mutate safely. */
export class SnapshotSanitizerPrerequisiteError extends Error {
  readonly snapshotPath: string;

  constructor(snapshotPath: string) {
    super(
      "Native snapshot sanitization support is unavailable; reinstall NemoClaw with optional dependencies and rerun",
    );
    this.name = "SnapshotSanitizerPrerequisiteError";
    this.snapshotPath = snapshotPath;
  }
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SYSTEMROOT", "WINDIR"] as const) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function invokeSnapshotSanitizerHelper(
  root: DescriptorSnapshotRoot,
  mode: "scan-tree" | "scan-file" | "apply" | "install",
  request: unknown,
): HelperResponse | null {
  const helperPath = snapshotSanitizerHelperPath();
  if (helperPath === null) throw new SnapshotSanitizerPrerequisiteError(root.canonicalPath);
  const result = spawnSync(process.execPath, [helperPath, mode], {
    encoding: "utf-8",
    env: helperEnvironment(),
    input: JSON.stringify(request),
    maxBuffer: HELPER_MAX_BUFFER_BYTES,
    timeout: HELPER_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isObjectRecord(parsed) || typeof parsed.ok !== "boolean") return null;
    if (parsed.ok === true && Object.hasOwn(parsed, "result")) {
      return { ok: true, result: parsed.result };
    }
    if (parsed.ok === false) {
      if (parsed.prerequisite === true) {
        throw new SnapshotSanitizerPrerequisiteError(root.canonicalPath);
      }
      return { ok: false };
    }
    return null;
  } catch (error) {
    if (error instanceof SnapshotSanitizerPrerequisiteError) throw error;
    return null;
  }
}

/** Resolve and pin one snapshot root without accepting a final-component symlink. */
export function inspectDescriptorSnapshotRoot(rootPath: string): DescriptorSnapshotRoot | null {
  let observed: ReturnType<typeof lstatSync>;
  try {
    observed = lstatSync(rootPath, { bigint: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error(`Snapshot root is not a safe directory: ${rootPath}`);
  }
  const canonicalPath = realpathSync(rootPath);
  const canonical = lstatSync(canonicalPath, { bigint: true });
  if (canonical.dev !== observed.dev || canonical.ino !== observed.ino) {
    throw new Error(`Snapshot root changed while it was resolved: ${rootPath}`);
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

/** Read a bounded snapshot tree through the native fs-safe boundary. */
export function scanDescriptorSnapshot(
  root: DescriptorSnapshotRoot,
  sensitiveNames: ReadonlySet<string>,
  targetName?: string,
): DescriptorSnapshotScan | null {
  const mode = targetName === undefined ? "scan-tree" : "scan-file";
  const response = invokeSnapshotSanitizerHelper(root, mode, {
    root,
    sensitiveNames: [...sensitiveNames],
    ...(targetName === undefined ? {} : { targetName }),
  });
  if (response?.ok !== true) return null;
  return parseScanResult(response.result);
}

/** Install or remove sanitized artifacts through the native fs-safe boundary. */
export function applyDescriptorSnapshotActions(
  root: DescriptorSnapshotRoot,
  scan: DescriptorSnapshotScan,
  actions: readonly SnapshotSanitizationAction[],
): boolean {
  if (actions.length === 0) return true;
  const response = invokeSnapshotSanitizerHelper(root, "apply", {
    root,
    scan: {
      root: scan.root,
      files: scan.files.map((file) => ({ path: file.path, metadata: file.metadata })),
    },
    actions,
  });
  return response?.ok === true && response.result === true;
}

/** Create one direct child without replacing an existing entry. */
export function installDescriptorSnapshotFile(
  root: DescriptorSnapshotRoot,
  targetName: string,
  content: string,
): boolean {
  if (!isSafeRelativePath(targetName) || targetName.includes("/")) return false;
  const response = invokeSnapshotSanitizerHelper(root, "install", {
    root,
    name: targetName,
    content: Buffer.from(content, "utf-8").toString("base64"),
  });
  return response?.ok === true && response.result === true;
}

/** Decode one helper payload and reject non-canonical base64 or invalid UTF-8. */
export function decodeDescriptorSnapshotContent(content: string | undefined): string | null {
  if (
    content === undefined ||
    content.length % 4 !== 0 ||
    content.length > MAX_SNAPSHOT_FILE_BASE64_LENGTH
  ) {
    return null;
  }
  const paddingLength = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const unpaddedLength = content.length - paddingLength;
  for (let index = 0; index < unpaddedLength; index += 1) {
    const code = content.charCodeAt(index);
    if (
      !(
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2b ||
        code === 0x2f
      )
    ) {
      return null;
    }
  }
  for (let index = unpaddedLength; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 0x3d) return null;
  }
  const decoded = Buffer.from(content, "base64");
  if (decoded.length > MAX_SNAPSHOT_FILE_BYTES) return null;
  if (decoded.toString("base64") !== content) return null;
  const utf8 = decoded.toString("utf-8");
  if (!Buffer.from(utf8, "utf-8").equals(decoded)) return null;
  return utf8;
}
