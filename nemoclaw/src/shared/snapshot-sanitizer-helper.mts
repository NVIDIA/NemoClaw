// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  configureFsSafeNative,
  FsSafeError,
  root as openFsSafeRoot,
  type Root,
} from "@openclaw/fs-safe";
import {
  readFileDescriptorBoundedSync,
  readFileHandleBounded,
  stageFileInDirectory,
} from "@openclaw/fs-safe/advanced";
import type {
  DescriptorSnapshotRoot,
  DescriptorSnapshotScan,
  SnapshotFileIdentity,
  SnapshotSanitizationAction,
  SnapshotSanitizerFailureCode,
  SnapshotSanitizerHelperRequest,
  SnapshotScannedFile,
} from "./snapshot-sanitizer-protocol.cjs";

const protocolExtension = import.meta.url.endsWith(".mts") ? ".cts" : ".cjs";
const { MAX_SNAPSHOT_FILE_BYTES } = createRequire(import.meta.url)(
  `./snapshot-sanitizer-protocol${protocolExtension}`,
) as typeof import("./snapshot-sanitizer-protocol.cjs");

const MAX_ENTRIES = 100_000;
const MAX_HELPER_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 32 * 1024 * 1024;
const SUPPORTED_SUFFIXES = [".json", ".yaml", ".yml", ".env"] as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is SnapshotFileIdentity {
  return (
    isObjectRecord(value) &&
    ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
      (key) => typeof value[key] === "string" && /^\d+$/u.test(value[key]),
    )
  );
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value)) return false;
  if (value.includes("\\")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isRoot(value: unknown): value is DescriptorSnapshotRoot {
  return (
    isObjectRecord(value) &&
    typeof value.canonicalPath === "string" &&
    path.isAbsolute(value.canonicalPath) &&
    isIdentity(value.identity)
  );
}

function identity(stat: BigIntStats): SnapshotFileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function identitiesMatch(left: SnapshotFileIdentity, right: SnapshotFileIdentity): boolean {
  return (Object.keys(left) as (keyof SnapshotFileIdentity)[]).every(
    (key) => left[key] === right[key],
  );
}

function inspectRoot(expected: DescriptorSnapshotRoot): SnapshotFileIdentity {
  const observed = lstatSync(expected.canonicalPath, { bigint: true });
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error("snapshot root is not a real directory");
  }
  if (realpathSync(expected.canonicalPath) !== expected.canonicalPath) {
    throw new Error("snapshot root canonical path changed");
  }
  const current = identity(observed);
  if (!identitiesMatch(expected.identity, current)) {
    throw new Error("snapshot root identity changed");
  }
  return current;
}

async function openRoot(expected: DescriptorSnapshotRoot): Promise<Root> {
  inspectRoot(expected);
  const opened = await openFsSafeRoot(expected.canonicalPath, {
    durable: true,
    hardlinks: "reject",
    maxBytes: MAX_SNAPSHOT_FILE_BYTES,
    mkdir: false,
    mode: 0o600,
    symlinks: "reject",
  });
  inspectRoot(expected);
  return opened;
}

function shouldInspect(relativePath: string, sensitiveNames: ReadonlySet<string>): boolean {
  const name = path.posix.basename(relativePath).toLowerCase();
  return sensitiveNames.has(name) || SUPPORTED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function scanFile(
  openedRoot: Root,
  relativePath: string,
  sensitiveNames: ReadonlySet<string>,
): Promise<SnapshotScannedFile> {
  const isSensitive = sensitiveNames.has(path.posix.basename(relativePath).toLowerCase());
  const opened = await openedRoot.open(relativePath, {
    hardlinks: isSensitive ? "allow" : "reject",
    symlinks: "reject",
  });
  try {
    const before = await opened.handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error("snapshot entry is not a file");
    const metadata = identity(before);
    if (isSensitive) {
      return { path: relativePath, metadata };
    }
    if (before.size > BigInt(MAX_SNAPSHOT_FILE_BYTES)) {
      throw new Error("snapshot file exceeds the read limit");
    }
    const content = await readFileHandleBounded(opened.handle, MAX_SNAPSHOT_FILE_BYTES);
    const after = await opened.handle.stat({ bigint: true });
    if (!identitiesMatch(metadata, identity(after))) {
      throw new Error("snapshot file changed while it was read");
    }
    return { path: relativePath, metadata, content: content.toString("base64") };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function scanTree(
  openedRoot: Root,
  rootIdentity: SnapshotFileIdentity,
  sensitiveNames: ReadonlySet<string>,
): Promise<DescriptorSnapshotScan> {
  const files: SnapshotScannedFile[] = [];
  let totalBytes = 0;
  for await (const entry of openedRoot.walk("", {
    limitBehavior: "throw",
    maxEntries: MAX_ENTRIES,
    onDirectoryError: "throw",
    symlinkPolicy: "skip",
  })) {
    if (entry.kind !== "file" || !shouldInspect(entry.relativePath, sensitiveNames)) continue;
    const file = await scanFile(openedRoot, entry.relativePath, sensitiveNames);
    if (file.content !== undefined) {
      totalBytes += Buffer.byteLength(file.content, "base64");
      if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
        throw new Error("snapshot content exceeds the total read limit");
      }
    }
    files.push(file);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { root: rootIdentity, files };
}

async function scanOne(
  openedRoot: Root,
  rootIdentity: SnapshotFileIdentity,
  targetName: unknown,
  sensitiveNames: ReadonlySet<string>,
): Promise<DescriptorSnapshotScan> {
  if (!isSafeRelativePath(targetName) || targetName.includes("/")) {
    throw new Error("scan target must be one direct-child basename");
  }
  try {
    const file = await scanFile(openedRoot, targetName, sensitiveNames);
    return { root: rootIdentity, files: [file] };
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return { root: rootIdentity, files: [] };
    }
    throw error;
  }
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new Error("content is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > MAX_SNAPSHOT_FILE_BYTES || decoded.toString("base64") !== value) {
    throw new Error("content is not canonical bounded base64");
  }
  return decoded;
}

function parseScan(value: unknown): DescriptorSnapshotScan {
  if (!isObjectRecord(value) || !isIdentity(value.root) || !Array.isArray(value.files)) {
    throw new Error("scan plan is invalid");
  }
  const seen = new Set<string>();
  const files: SnapshotScannedFile[] = value.files.map((file) => {
    if (
      !isObjectRecord(file) ||
      !isSafeRelativePath(file.path) ||
      !isIdentity(file.metadata) ||
      (file.content !== undefined && typeof file.content !== "string") ||
      seen.has(file.path)
    ) {
      throw new Error("scanned file is invalid");
    }
    seen.add(file.path);
    return {
      path: file.path,
      metadata: file.metadata,
      ...(typeof file.content === "string" ? { content: file.content } : {}),
    };
  });
  return { root: value.root, files };
}

function parseActions(value: unknown): readonly SnapshotSanitizationAction[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("action plan is empty");
  const seen = new Set<string>();
  return value.map((action) => {
    if (
      !isObjectRecord(action) ||
      !isSafeRelativePath(action.path) ||
      !isIdentity(action.metadata) ||
      (action.kind !== "remove" && action.kind !== "replace") ||
      seen.has(action.path)
    ) {
      throw new Error("snapshot action is invalid");
    }
    seen.add(action.path);
    if (action.kind === "replace") {
      if (typeof action.content !== "string") throw new Error("replacement content is missing");
      return {
        kind: "replace",
        path: action.path,
        metadata: action.metadata,
        content: action.content,
      };
    }
    return { kind: "remove", path: action.path, metadata: action.metadata };
  });
}

async function assertFileCurrent(
  openedRoot: Root,
  relativePath: string,
  expected: SnapshotFileIdentity,
): Promise<void> {
  const opened = await openedRoot.open(relativePath, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  try {
    const current = await opened.handle.stat({ bigint: true });
    if (
      !current.isFile() ||
      current.nlink !== 1n ||
      !identitiesMatch(expected, identity(current))
    ) {
      throw new Error("snapshot file identity changed");
    }
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function applyActions(
  openedRoot: Root,
  request: SnapshotSanitizerHelperRequest,
): Promise<boolean> {
  const scan = parseScan(request.scan);
  if (!identitiesMatch(request.root.identity, scan.root)) throw new Error("scan root changed");
  const scannedFiles = new Map(scan.files.map((file) => [file.path, file.metadata]));
  const actions = parseActions(request.actions);
  for (const action of actions) {
    const scanned = scannedFiles.get(action.path);
    if (!scanned || !identitiesMatch(scanned, action.metadata)) {
      throw new Error("action does not match the scan");
    }
    await assertFileCurrent(openedRoot, action.path, action.metadata);
    if (action.kind === "remove") {
      await openedRoot.remove(action.path);
    } else {
      await openedRoot.write(action.path, decodeCanonicalBase64(action.content), {
        durable: true,
        mkdir: false,
        mode: 0o600,
      });
    }
  }
  return true;
}

async function installFile(
  openedRoot: Root,
  request: SnapshotSanitizerHelperRequest,
): Promise<boolean> {
  if (!isSafeRelativePath(request.name) || request.name.includes("/")) {
    throw new Error("install target must be one direct-child basename");
  }
  await openedRoot.create(request.name, decodeCanonicalBase64(request.content), {
    durable: true,
    mkdir: false,
    mode: 0o600,
  });
  return true;
}

function sensitiveNames(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error("sensitive names are invalid");
  }
  return new Set(value as string[]);
}

async function run(mode: string, value: unknown): Promise<unknown> {
  if (!isObjectRecord(value) || !isRoot(value.root)) throw new Error("helper request is invalid");
  const request = value as SnapshotSanitizerHelperRequest;
  const rootIdentity = inspectRoot(request.root);
  const openedRoot = await openRoot(request.root);
  if (mode === "scan-tree") {
    return await scanTree(openedRoot, rootIdentity, sensitiveNames(request.sensitiveNames));
  }
  if (mode === "scan-file") {
    return await scanOne(
      openedRoot,
      rootIdentity,
      request.targetName,
      sensitiveNames(request.sensitiveNames),
    );
  }
  if (mode === "apply") return await applyActions(openedRoot, request);
  if (mode === "install") return await installFile(openedRoot, request);
  throw new Error("snapshot sanitizer mode is invalid");
}

function isPrerequisiteError(error: unknown): boolean {
  return (
    error instanceof FsSafeError &&
    (error.code === "helper-unavailable" || error.code === "unsupported-platform")
  );
}

function classifyFailure(mode: string, error: unknown): SnapshotSanitizerFailureCode {
  const message = error instanceof Error ? error.message : "";
  if (message === "native support probe cleanup failed") return "native-probe-failed";
  if (
    message === "snapshot file exceeds the read limit" ||
    message === "snapshot content exceeds the total read limit" ||
    (error instanceof FsSafeError && error.code === "too-large" && !message.startsWith("root walk"))
  ) {
    return "snapshot-size-limit-exceeded";
  }
  if (error instanceof FsSafeError && error.code === "too-large") {
    return "snapshot-entry-limit-exceeded";
  }
  return mode === "apply" || mode === "install"
    ? "snapshot-mutation-failed"
    : "snapshot-scan-failed";
}

interface NativeSupportProbe {
  readonly receipt: {
    readonly directory: { readonly realPath: string };
    readonly temporaryBasename: string;
  };
  cleanup(): Promise<{ readonly status: string }>;
}

class NativeProbeCleanupError extends Error {
  readonly retainedPath: string;

  constructor(retainedPath: string) {
    super("native support probe cleanup failed");
    this.name = "NativeProbeCleanupError";
    this.retainedPath = retainedPath;
  }
}

/** @visibleForTesting Verify native staging and report an exact retained probe when cleanup fails. */
export async function assertNativeSupport(
  createProbe: () => Promise<NativeSupportProbe> = () =>
    stageFileInDirectory({ directory: tmpdir(), content: Buffer.alloc(0) }),
): Promise<void> {
  const probe = await createProbe();
  const cleanup = await probe.cleanup();
  if (cleanup.status !== "removed") {
    throw new NativeProbeCleanupError(
      path.join(probe.receipt.directory.realPath, probe.receipt.temporaryBasename),
    );
  }
}

async function main(): Promise<void> {
  try {
    configureFsSafeNative({ mode: "require" });
    await assertNativeSupport();
    const request: unknown = JSON.parse(
      readFileDescriptorBoundedSync(0, MAX_HELPER_INPUT_BYTES).toString("utf8"),
    );
    const result = await run(process.argv[2] ?? "", request);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const prerequisite = isPrerequisiteError(error);
    process.stdout.write(
      JSON.stringify({
        ok: false,
        prerequisite,
        ...(prerequisite ? {} : { code: classifyFailure(process.argv[2] ?? "", error) }),
        ...(error instanceof NativeProbeCleanupError ? { retainedPath: error.retainedPath } : {}),
      }),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
