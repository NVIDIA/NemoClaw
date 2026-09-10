// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  isSnapshotSanitizerFailureCode,
  snapshotSanitizerTempDirectory,
  MAX_SNAPSHOT_FILE_BASE64_LENGTH,
  MAX_SNAPSHOT_FILE_BYTES,
} from "./snapshot-sanitizer-protocol.cjs";
import type {
  DescriptorSnapshotRoot,
  DescriptorSnapshotScan,
  SnapshotFileIdentity,
  SnapshotSanitizationAction,
  SnapshotSanitizerFailureCode,
  SnapshotSanitizerHelperResponse,
  SnapshotScannedFile,
} from "./snapshot-sanitizer-protocol.cjs";

export type {
  DescriptorSnapshotRoot,
  DescriptorSnapshotScan,
  SnapshotFileIdentity,
  SnapshotSanitizationAction,
  SnapshotSanitizerFailureCode,
  SnapshotScannedFile,
} from "./snapshot-sanitizer-protocol.cjs";

const HELPER_TIMEOUT_MS = 60_000;
const HELPER_MAX_BUFFER_BYTES = 48 * 1024 * 1024;
let snapshotSanitizerHelperPathForTest: string | null | undefined;

const TRUSTED_PYTHON_LOCATIONS = [
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "/opt/local/bin/python3",
] as const;

function isTrustedAbsoluteExecutable(candidate: string): string | null {
  try {
    const canonical = realpathSync(candidate);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    let inspected = canonical;
    while (true) {
      const metadata = statSync(inspected);
      if ((metadata.mode & 0o022) !== 0) return null;
      if (currentUid !== null && metadata.uid !== 0 && metadata.uid !== currentUid) return null;
      const parent = path.dirname(inspected);
      if (parent === inspected) break;
      inspected = parent;
    }
    const executable = statSync(canonical);
    if (!executable.isFile()) return null;
    accessSync(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

/** Migration restore still requires a verified interpreter; the sanitizer uses Node.js. */
export function resolveTrustedSnapshotSanitizerPythonPath(): string | null {
  const candidates: string[] = [...TRUSTED_PYTHON_LOCATIONS];
  try {
    candidates.push(path.join(path.dirname(realpathSync(process.execPath)), "python3"));
  } catch {
    // The fixed system locations remain authoritative when Node cannot be canonicalized.
  }
  for (const candidate of new Set(candidates)) {
    const trusted = isTrustedAbsoluteExecutable(candidate);
    if (trusted !== null) return trusted;
  }
  return null;
}

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

function validatedRetainedProbePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !path.isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  return path.dirname(value) === snapshotSanitizerTempDirectory() ? value : undefined;
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

/** A bounded failure class from the native helper, without sensitive exception text. */
export class SnapshotSanitizerOperationError extends Error {
  readonly code: SnapshotSanitizerFailureCode;
  readonly retainedPath?: string;
  readonly snapshotPath: string;

  constructor(snapshotPath: string, code: SnapshotSanitizerFailureCode, retainedPath?: string) {
    super(
      retainedPath === undefined
        ? `Native snapshot sanitization failed: ${code}`
        : `Native snapshot sanitization failed: ${code}; remove retained temporary file and retry: ${retainedPath}`,
    );
    this.name = "SnapshotSanitizerOperationError";
    this.code = code;
    this.retainedPath = retainedPath;
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
): SnapshotSanitizerHelperResponse | null {
  const helperPath = snapshotSanitizerHelperPath();
  if (helperPath === null) throw new SnapshotSanitizerPrerequisiteError(root.canonicalPath);
  const helperArguments = helperPath.endsWith(".mts")
    ? ["--import", "tsx", helperPath, mode]
    : [helperPath, mode];
  const result = spawnSync(process.execPath, helperArguments, {
    encoding: "utf-8",
    env: helperEnvironment(),
    input: JSON.stringify(request),
    maxBuffer: HELPER_MAX_BUFFER_BYTES,
    timeout: HELPER_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    throw new SnapshotSanitizerOperationError(root.canonicalPath, "helper-process-failed");
  }
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
      if (isSnapshotSanitizerFailureCode(parsed.code)) {
        const retainedPath =
          parsed.code === "native-probe-failed"
            ? validatedRetainedProbePath(parsed.retainedPath)
            : undefined;
        throw new SnapshotSanitizerOperationError(root.canonicalPath, parsed.code, retainedPath);
      }
      return { ok: false };
    }
    return null;
  } catch (error) {
    if (
      error instanceof SnapshotSanitizerPrerequisiteError ||
      error instanceof SnapshotSanitizerOperationError
    ) {
      throw error;
    }
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
  const decoded = Buffer.from(content, "base64");
  if (decoded.length > MAX_SNAPSHOT_FILE_BYTES) return null;
  if (decoded.toString("base64") !== content) return null;
  const utf8 = decoded.toString("utf-8");
  if (!Buffer.from(utf8, "utf-8").equals(decoded)) return null;
  return utf8;
}
