// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import {
  selectEnabledMessagingAgentRender,
  selectEnabledPostAgentInstallBuildFiles,
} from "../../messaging/post-agent-install-selection";
import {
  fingerprintManagedStartupProfile,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
} from "./profile";

const TRANSACTION_SCHEMA_VERSION = 1;
const MAX_TRANSACTION_FILES = 128;
const MAX_TRANSACTION_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSACTION_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const TRANSACTION_PARENT_DIRECTORY_MODE = 0o755;
const TRANSACTION_DIRECTORY_MODE = 0o700;
const TRANSACTION_FILE_MODE = 0o400;

export const MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY =
  "/var/lib/nemoclaw/managed-startup-shared-state-transaction-v1";
export const MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY =
  "/run/nemoclaw/managed-startup-shared-rollback-receipt-v1";

interface FilePresentReceipt {
  readonly path: string;
  readonly state: "file";
  readonly backup: string;
  readonly sha256: string;
  readonly size: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

interface FileAbsentReceipt {
  readonly path: string;
  readonly state: "absent";
}

type FileReceipt = FilePresentReceipt | FileAbsentReceipt;

interface DirectoryPresentReceipt {
  readonly path: string;
  readonly state: "directory";
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

interface DirectoryAbsentReceipt {
  readonly path: string;
  readonly state: "absent";
}

type DirectoryReceipt = DirectoryPresentReceipt | DirectoryAbsentReceipt;

interface TransactionManifest {
  readonly schemaVersion: typeof TRANSACTION_SCHEMA_VERSION;
  readonly agent: ManagedStartupAgent;
  readonly profileFingerprint: string;
  readonly files: readonly FileReceipt[];
  readonly directories: readonly DirectoryReceipt[];
}

export interface ManagedStartupSharedTransactionOptions {
  readonly sandboxRoot?: string;
  readonly transactionDirectory?: string;
  /** Test seam. Production always retains the root:root defaults. */
  readonly trustedUid?: number;
  /** Test seam. Production always retains the root:root defaults. */
  readonly trustedGid?: number;
  /**
   * Rollback-helper seam. The host copy is mounted read-only at a fixed path,
   * so ownership may reflect the Docker CLI user instead of container root.
   */
  readonly readOnlyReceipt?: boolean;
}

interface ResolvedOptions {
  readonly sandboxRoot: string;
  readonly transactionParentDirectory: string;
  readonly transactionDirectory: string;
  readonly backupDirectory: string;
  readonly manifestFile: string;
  readonly trustedUid: number;
  readonly trustedGid: number;
  readonly readOnlyReceipt: boolean;
}

interface StableFile {
  readonly bytes: Buffer;
  readonly stat: fs.BigIntStats;
}

function fail(message: string): never {
  throw new Error(`Managed startup shared-state transaction failed: ${message}`);
}

function resolveOptions(options: ManagedStartupSharedTransactionOptions = {}): ResolvedOptions {
  const sandboxRoot = path.resolve(options.sandboxRoot ?? "/sandbox");
  const transactionDirectory = path.resolve(
    options.transactionDirectory ?? MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY,
  );
  if (
    transactionDirectory === sandboxRoot ||
    transactionDirectory.startsWith(`${sandboxRoot}${path.sep}`)
  ) {
    fail("transaction receipts must not be stored in sandbox-shared state");
  }
  return {
    sandboxRoot,
    transactionParentDirectory: path.dirname(transactionDirectory),
    transactionDirectory,
    backupDirectory: path.join(transactionDirectory, "backups"),
    manifestFile: path.join(transactionDirectory, "manifest.json"),
    trustedUid: options.trustedUid ?? 0,
    trustedGid: options.trustedGid ?? 0,
    readOnlyReceipt: options.readOnlyReceipt ?? false,
  };
}

function modeOf(stat: fs.Stats | fs.BigIntStats): number {
  if (typeof stat.mode === "bigint") {
    return Number(stat.mode & 0o7777n);
  }
  return stat.mode & 0o7777;
}

function requireTransactionIdentity(options: ResolvedOptions): void {
  const expectedUid = options.readOnlyReceipt ? 0 : options.trustedUid;
  const expectedGid = options.readOnlyReceipt ? 0 : options.trustedGid;
  if (process.geteuid?.() !== expectedUid || process.getegid?.() !== expectedGid) {
    fail("transaction control requires the trusted effective identity");
  }
}

function pathExistsNoFollow(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail(`could not inspect ${target}`);
  }
}

function requireDirectory(
  target: string,
  options: ResolvedOptions,
  expectedMode: number | null = null,
): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    fail(`required directory is missing: ${target}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`required directory is unsafe: ${target}`);
  }
  if (
    expectedMode !== null &&
    (stat.uid !== options.trustedUid ||
      stat.gid !== options.trustedGid ||
      modeOf(stat) !== expectedMode)
  ) {
    fail(
      `${target} must be ${options.trustedUid}:${options.trustedGid} mode ${expectedMode.toString(8)}`,
    );
  }
  return stat;
}

function requireTransactionBoundaries(options: ResolvedOptions): void {
  requireDirectory(options.sandboxRoot, options);
  requireDirectory(options.transactionParentDirectory, options, TRANSACTION_PARENT_DIRECTORY_MODE);
}

function sameStableMetadata(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readStableFile(target: string, maxBytes: number): StableFile {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") fail("O_NOFOLLOW is unavailable");
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch {
    fail(`could not safely open ${target}`);
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 0n ||
      before.size > BigInt(maxBytes)
    ) {
      fail(`refusing unsafe or oversized transaction file ${target}`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    const overflowCount = fs.readSync(descriptor, overflow, 0, 1, offset);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || overflowCount !== 0 || !sameStableMetadata(before, after)) {
      fail(`${target} changed while it was captured`);
    }
    return { bytes, stat: before };
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(value)
  ) {
    fail(`unsafe transaction path ${JSON.stringify(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`unsafe transaction path ${JSON.stringify(value)}`);
  }
  return segments.join("/");
}

function absoluteTarget(relativePath: string, options: ResolvedOptions): string {
  const safe = safeRelativePath(relativePath);
  const target = path.resolve(options.sandboxRoot, safe);
  if (!target.startsWith(`${options.sandboxRoot}${path.sep}`)) {
    fail(`transaction target escapes the sandbox root: ${relativePath}`);
  }
  return target;
}

function relativeTarget(target: string, options: ResolvedOptions): string {
  return safeRelativePath(path.relative(options.sandboxRoot, target));
}

function validateExistingAncestors(target: string, options: ResolvedOptions): void {
  const relative = relativeTarget(target, options);
  const sandboxStat = requireDirectory(options.sandboxRoot, options);
  let current = options.sandboxRoot;
  const segments = relative.split("/").slice(0, -1);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      fail(`could not inspect transaction path ancestor ${current}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`transaction path ancestor is unsafe: ${current}`);
    }
    if (stat.dev !== sandboxStat.dev) {
      fail(`transaction path crosses a nested filesystem mount: ${current}`);
    }
  }
}

function agentRoot(agent: ManagedStartupAgent, sandboxRoot: string): string {
  switch (agent) {
    case "openclaw":
      return path.join(sandboxRoot, ".openclaw");
    case "hermes":
      return path.join(sandboxRoot, ".hermes");
    case "langchain-deepagents-code":
      return path.join(sandboxRoot, ".deepagents");
  }
}

function resolveUnderAgentRoot(root: string, relativePath: string): string {
  const safe = safeRelativePath(relativePath);
  const target = path.resolve(root, safe);
  if (!target.startsWith(`${root}${path.sep}`)) {
    fail(`managed output escapes the agent root: ${relativePath}`);
  }
  return target;
}

function renderTarget(root: string, agent: ManagedStartupAgent, target: string): string {
  if (agent === "openclaw" && target === "openclaw.json") {
    return path.join(root, "openclaw.json");
  }
  const prefix = agent === "openclaw" ? "~/.openclaw/" : agent === "hermes" ? "~/.hermes/" : null;
  if (!prefix || !target.startsWith(prefix)) {
    fail(`unsupported managed messaging render target ${JSON.stringify(target)}`);
  }
  return resolveUnderAgentRoot(root, target.slice(prefix.length));
}

function managedOutputTargets(
  profile: ManagedStartupProfile,
  options: ResolvedOptions,
): { readonly files: string[]; readonly directories: string[] } {
  const root = agentRoot(profile.agent, options.sandboxRoot);
  const files = new Set<string>();
  const directories = new Set<string>([root]);
  switch (profile.agent) {
    case "openclaw":
      files.add(path.join(root, "openclaw.json"));
      files.add(path.join(root, ".config-hash"));
      break;
    case "hermes":
      files.add(path.join(root, "config.yaml"));
      files.add(path.join(root, ".env"));
      files.add(path.join(root, ".config-hash"));
      break;
    case "langchain-deepagents-code":
      files.add(path.join(root, "config.toml"));
      directories.add(path.join(root, ".state"));
      directories.add(path.join(root, "skills"));
      break;
  }

  if (profile.messaging.plan !== null) {
    const plan = parseSandboxMessagingPlan(profile.messaging.plan, { agent: profile.agent });
    if (!plan) fail("managed messaging plan is invalid");
    for (const render of selectEnabledMessagingAgentRender(plan)) {
      if (typeof render.target !== "string") continue;
      files.add(renderTarget(root, profile.agent, render.target));
    }
    for (const step of selectEnabledPostAgentInstallBuildFiles(plan)) {
      if (typeof step.value !== "object" || step.value === null) {
        continue;
      }
      const outputPath = (step.value as Record<string, unknown>).path;
      if (typeof outputPath === "string") {
        files.add(resolveUnderAgentRoot(root, outputPath));
      }
    }
  }

  for (const file of files) {
    let parent = path.dirname(file);
    while (parent !== options.sandboxRoot && parent.startsWith(`${root}${path.sep}`)) {
      directories.add(parent);
      if (parent === root) break;
      parent = path.dirname(parent);
    }
  }
  return {
    files: [...files].sort(),
    directories: [...directories].sort(
      (left, right) => left.split(path.sep).length - right.split(path.sep).length,
    ),
  };
}

function snapshotFile(
  target: string,
  index: number,
  options: ResolvedOptions,
): { readonly receipt: FileReceipt; readonly bytes: Buffer | null } {
  validateExistingAncestors(target, options);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        receipt: { path: relativeTarget(target, options), state: "absent" },
        bytes: null,
      };
    }
    fail(`could not inspect managed output ${target}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail(`managed output is not a safe regular file: ${target}`);
  }
  if (stat.dev !== requireDirectory(options.sandboxRoot, options).dev) {
    fail(`managed output crosses a nested filesystem mount: ${target}`);
  }
  const stable = readStableFile(target, MAX_TRANSACTION_FILE_BYTES);
  const size = Number(stable.stat.size);
  const backup = `${String(index).padStart(3, "0")}.bin`;
  return {
    receipt: {
      path: relativeTarget(target, options),
      state: "file",
      backup,
      sha256: createHash("sha256").update(stable.bytes).digest("hex"),
      size,
      uid: Number(stable.stat.uid),
      gid: Number(stable.stat.gid),
      mode: Number(stable.stat.mode & 0o7777n),
    },
    bytes: stable.bytes,
  };
}

function snapshotDirectory(target: string, options: ResolvedOptions): DirectoryReceipt {
  validateExistingAncestors(path.join(target, ".receipt"), options);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: relativeTarget(target, options), state: "absent" };
    }
    fail(`could not inspect managed output directory ${target}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`managed output directory is unsafe: ${target}`);
  }
  if (stat.dev !== requireDirectory(options.sandboxRoot, options).dev) {
    fail(`managed output directory crosses a nested filesystem mount: ${target}`);
  }
  return {
    path: relativeTarget(target, options),
    state: "directory",
    uid: stat.uid,
    gid: stat.gid,
    mode: modeOf(stat),
  };
}

function atomicWriteTrustedFile(
  target: string,
  contents: string | Buffer,
  mode: number,
  uid: number,
  gid: number,
): void {
  const parent = path.dirname(target);
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.${randomBytes(12).toString("hex")}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, contents);
    fs.fchownSync(descriptor, uid, gid);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the primary failure.
    }
    fail(`could not atomically write ${target}: ${(error as Error).message}`);
  }
}

function canonicalManifest(manifest: TransactionManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    fail("transaction manifest contains unexpected fields");
  }
}

function safeMetadata(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseManifest(text: string): TransactionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("transaction manifest is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("transaction manifest must be an object");
  }
  const record = parsed as Record<string, unknown>;
  requireExactKeys(record, [
    "agent",
    "directories",
    "files",
    "profileFingerprint",
    "schemaVersion",
  ]);
  if (
    record.schemaVersion !== TRANSACTION_SCHEMA_VERSION ||
    !["openclaw", "hermes", "langchain-deepagents-code"].includes(String(record.agent)) ||
    typeof record.profileFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.profileFingerprint) ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.directories) ||
    record.files.length > MAX_TRANSACTION_FILES ||
    record.directories.length > MAX_TRANSACTION_FILES * 4
  ) {
    fail("transaction manifest has an invalid envelope");
  }
  const files = record.files.map((value): FileReceipt => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail("transaction file receipt must be an object");
    }
    const receipt = value as Record<string, unknown>;
    if (typeof receipt.path !== "string") {
      return fail("transaction file receipt path must be a string");
    }
    const receiptPath = safeRelativePath(receipt.path);
    if (receipt.state === "absent") {
      requireExactKeys(receipt, ["path", "state"]);
      return { path: receiptPath, state: "absent" };
    }
    requireExactKeys(receipt, ["backup", "gid", "mode", "path", "sha256", "size", "state", "uid"]);
    if (
      receipt.state !== "file" ||
      typeof receipt.backup !== "string" ||
      !/^[0-9]{3}\.bin$/u.test(receipt.backup) ||
      typeof receipt.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(receipt.sha256) ||
      !safeMetadata(receipt.size) ||
      (receipt.size as number) > MAX_TRANSACTION_FILE_BYTES ||
      !safeMetadata(receipt.uid) ||
      !safeMetadata(receipt.gid) ||
      !safeMetadata(receipt.mode) ||
      (receipt.mode as number) > 0o7777
    ) {
      return fail("transaction file receipt is invalid");
    }
    return {
      path: receiptPath,
      state: "file",
      backup: receipt.backup,
      sha256: receipt.sha256,
      size: receipt.size as number,
      uid: receipt.uid as number,
      gid: receipt.gid as number,
      mode: receipt.mode as number,
    };
  });
  const directories = record.directories.map((value): DirectoryReceipt => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail("transaction directory receipt must be an object");
    }
    const receipt = value as Record<string, unknown>;
    if (typeof receipt.path !== "string") {
      return fail("transaction directory receipt path must be a string");
    }
    const receiptPath = safeRelativePath(receipt.path);
    if (receipt.state === "absent") {
      requireExactKeys(receipt, ["path", "state"]);
      return { path: receiptPath, state: "absent" };
    }
    requireExactKeys(receipt, ["gid", "mode", "path", "state", "uid"]);
    if (
      receipt.state !== "directory" ||
      !safeMetadata(receipt.uid) ||
      !safeMetadata(receipt.gid) ||
      !safeMetadata(receipt.mode) ||
      (receipt.mode as number) > 0o7777
    ) {
      return fail("transaction directory receipt is invalid");
    }
    return {
      path: receiptPath,
      state: "directory",
      uid: receipt.uid as number,
      gid: receipt.gid as number,
      mode: receipt.mode as number,
    };
  });
  const filePaths = files.map((receipt) => receipt.path);
  const directoryPaths = directories.map((receipt) => receipt.path);
  const backupNames = files
    .filter((receipt): receipt is FilePresentReceipt => receipt.state === "file")
    .map((receipt) => receipt.backup);
  if (
    new Set(filePaths).size !== filePaths.length ||
    new Set(directoryPaths).size !== directoryPaths.length ||
    new Set(backupNames).size !== backupNames.length
  ) {
    fail("transaction manifest contains duplicate receipts");
  }
  const manifest: TransactionManifest = {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    agent: record.agent as ManagedStartupAgent,
    profileFingerprint: record.profileFingerprint,
    files,
    directories,
  };
  if (canonicalManifest(manifest) !== text) {
    fail("transaction manifest is not canonical");
  }
  return manifest;
}

function requireTrustedTransactionPath(
  target: string,
  mode: number,
  options: ResolvedOptions,
): void {
  const stat = fs.lstatSync(target);
  if (
    stat.isSymbolicLink() ||
    (mode === TRANSACTION_DIRECTORY_MODE ? !stat.isDirectory() : !stat.isFile()) ||
    (!options.readOnlyReceipt &&
      (stat.uid !== options.trustedUid || stat.gid !== options.trustedGid)) ||
    modeOf(stat) !== mode
  ) {
    fail(`transaction artifact has unsafe metadata: ${target}`);
  }
}

function requireReadOnlyReceiptMount(options: ResolvedOptions): void {
  if (!options.readOnlyReceipt) return;
  const probe = path.join(options.transactionDirectory, ".nemoclaw-write-probe");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      probe,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(probe);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === "EROFS") return;
    fail("rollback receipt must be mounted on a read-only filesystem");
  }
  fail("rollback receipt mount is writable");
}

function loadManifest(options: ResolvedOptions): TransactionManifest | null {
  requireTransactionBoundaries(options);
  if (!pathExistsNoFollow(options.transactionDirectory)) return null;
  requireTrustedTransactionPath(options.transactionDirectory, TRANSACTION_DIRECTORY_MODE, options);
  requireReadOnlyReceiptMount(options);
  requireTrustedTransactionPath(options.backupDirectory, TRANSACTION_DIRECTORY_MODE, options);
  requireTrustedTransactionPath(options.manifestFile, TRANSACTION_FILE_MODE, options);
  const stable = readStableFile(options.manifestFile, MAX_MANIFEST_BYTES);
  if (
    (!options.readOnlyReceipt &&
      (Number(stable.stat.uid) !== options.trustedUid ||
        Number(stable.stat.gid) !== options.trustedGid)) ||
    Number(stable.stat.mode & 0o7777n) !== TRANSACTION_FILE_MODE
  ) {
    fail("transaction manifest ownership changed while it was read");
  }
  return parseManifest(stable.bytes.toString("utf8"));
}

function verifyBackup(receipt: FilePresentReceipt, options: ResolvedOptions): Buffer {
  const backupPath = path.join(options.backupDirectory, receipt.backup);
  requireTrustedTransactionPath(backupPath, TRANSACTION_FILE_MODE, options);
  const stable = readStableFile(backupPath, MAX_TRANSACTION_FILE_BYTES);
  const digest = createHash("sha256").update(stable.bytes).digest("hex");
  if (stable.bytes.length !== receipt.size || digest !== receipt.sha256) {
    fail(`transaction backup does not match its receipt: ${receipt.path}`);
  }
  return stable.bytes;
}

function verifyAllBackups(
  receipts: readonly FileReceipt[],
  options: ResolvedOptions,
): ReadonlyMap<string, Buffer> {
  const backups = new Map<string, Buffer>();
  for (const receipt of receipts) {
    if (receipt.state === "file") {
      backups.set(receipt.path, verifyBackup(receipt, options));
    }
  }
  return backups;
}

function fileMatchesReceipt(target: string, receipt: FilePresentReceipt): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail(`could not inspect managed output ${target}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return false;
  const stable = readStableFile(target, MAX_TRANSACTION_FILE_BYTES);
  return (
    stable.bytes.length === receipt.size &&
    createHash("sha256").update(stable.bytes).digest("hex") === receipt.sha256 &&
    Number(stable.stat.uid) === receipt.uid &&
    Number(stable.stat.gid) === receipt.gid &&
    Number(stable.stat.mode & 0o7777n) === receipt.mode
  );
}

function directoryMatchesReceipt(target: string, receipt: DirectoryPresentReceipt): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail(`could not inspect managed output directory ${target}`);
  }
  return (
    !stat.isSymbolicLink() &&
    stat.isDirectory() &&
    stat.uid === receipt.uid &&
    stat.gid === receipt.gid &&
    modeOf(stat) === receipt.mode
  );
}

function removeTransactionDirectory(options: ResolvedOptions): void {
  requireTrustedTransactionPath(options.transactionDirectory, TRANSACTION_DIRECTORY_MODE, options);
  fs.rmSync(options.transactionDirectory, { force: false, recursive: true });
  if (pathExistsNoFollow(options.transactionDirectory)) {
    fail("transaction directory remained after cleanup");
  }
}

export function beginManagedStartupSharedStateTransaction(
  profile: ManagedStartupProfile,
  inputOptions: ManagedStartupSharedTransactionOptions = {},
): boolean {
  const options = resolveOptions(inputOptions);
  requireTransactionIdentity(options);
  if (options.readOnlyReceipt) {
    fail("cannot begin a transaction from a read-only rollback receipt");
  }
  requireTransactionBoundaries(options);
  const profileFingerprint = fingerprintManagedStartupProfile(profile);
  const pending = loadManifest(options);
  if (pending) {
    if (pending.agent !== profile.agent || pending.profileFingerprint !== profileFingerprint) {
      fail("a pending managed startup transaction belongs to a different profile");
    }
    verifyAllBackups(pending.files, options);
    return false;
  }
  const targets = managedOutputTargets(profile, options);
  if (targets.files.length > MAX_TRANSACTION_FILES) {
    fail("managed startup transaction has too many file targets");
  }
  const snapshots = targets.files.map((target, index) => snapshotFile(target, index, options));
  const totalBytes = snapshots.reduce((sum, snapshot) => sum + (snapshot.bytes?.length ?? 0), 0);
  if (totalBytes > MAX_TRANSACTION_TOTAL_BYTES) {
    fail("managed startup transaction backup exceeds the total size limit");
  }
  const directories = targets.directories.map((target) => snapshotDirectory(target, options));
  const manifest: TransactionManifest = {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    agent: profile.agent,
    profileFingerprint,
    files: snapshots.map(({ receipt }) => receipt),
    directories,
  };

  let createdTransactionIdentity:
    | { readonly dev: bigint; readonly ino: bigint; readonly uid: bigint; readonly gid: bigint }
    | undefined;
  try {
    fs.mkdirSync(options.transactionDirectory, { mode: TRANSACTION_DIRECTORY_MODE });
    const created = fs.lstatSync(options.transactionDirectory, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) {
      fail("new transaction path is not a directory");
    }
    createdTransactionIdentity = {
      dev: created.dev,
      ino: created.ino,
      uid: created.uid,
      gid: created.gid,
    };
    fs.chownSync(options.transactionDirectory, options.trustedUid, options.trustedGid);
    fs.chmodSync(options.transactionDirectory, TRANSACTION_DIRECTORY_MODE);
    fs.mkdirSync(options.backupDirectory, { mode: TRANSACTION_DIRECTORY_MODE });
    fs.chownSync(options.backupDirectory, options.trustedUid, options.trustedGid);
    fs.chmodSync(options.backupDirectory, TRANSACTION_DIRECTORY_MODE);
    for (const snapshot of snapshots) {
      if (snapshot.receipt.state !== "file" || snapshot.bytes === null) continue;
      atomicWriteTrustedFile(
        path.join(options.backupDirectory, snapshot.receipt.backup),
        snapshot.bytes,
        TRANSACTION_FILE_MODE,
        options.trustedUid,
        options.trustedGid,
      );
    }
    atomicWriteTrustedFile(
      options.manifestFile,
      canonicalManifest(manifest),
      TRANSACTION_FILE_MODE,
      options.trustedUid,
      options.trustedGid,
    );
    loadManifest(options);
  } catch (error) {
    try {
      if (createdTransactionIdentity && pathExistsNoFollow(options.transactionDirectory)) {
        const current = fs.lstatSync(options.transactionDirectory, { bigint: true });
        if (
          !current.isSymbolicLink() &&
          current.isDirectory() &&
          current.dev === createdTransactionIdentity.dev &&
          current.ino === createdTransactionIdentity.ino &&
          current.uid === createdTransactionIdentity.uid &&
          current.gid === createdTransactionIdentity.gid
        ) {
          fs.chmodSync(options.transactionDirectory, TRANSACTION_DIRECTORY_MODE);
          fs.chownSync(options.transactionDirectory, options.trustedUid, options.trustedGid);
        }
        requireTrustedTransactionPath(
          options.transactionDirectory,
          TRANSACTION_DIRECTORY_MODE,
          options,
        );
        fs.rmSync(options.transactionDirectory, { force: true, recursive: true });
      }
    } catch {
      // Preserve the primary transaction preparation failure.
    }
    throw error;
  }
  return true;
}

function ensureOriginalDirectories(
  receipts: readonly DirectoryReceipt[],
  options: ResolvedOptions,
): void {
  for (const receipt of receipts) {
    if (receipt.state !== "directory") continue;
    const target = absoluteTarget(receipt.path, options);
    validateExistingAncestors(path.join(target, ".restore"), options);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fail(`could not inspect restore directory ${target}`);
      }
    }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      fail(`restore directory is unsafe: ${target}`);
    }
    if (stat && directoryMatchesReceipt(target, receipt)) continue;
    if (!stat) fs.mkdirSync(target, { mode: receipt.mode });
    fs.chownSync(target, receipt.uid, receipt.gid);
    fs.chmodSync(target, receipt.mode);
  }
}

function restoreFiles(
  receipts: readonly FileReceipt[],
  backups: ReadonlyMap<string, Buffer>,
  options: ResolvedOptions,
): void {
  for (const receipt of receipts) {
    const target = absoluteTarget(receipt.path, options);
    validateExistingAncestors(target, options);
    if (receipt.state === "absent") {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        fail(`could not inspect new managed output ${target}`);
      }
      if (stat.isDirectory()) {
        fail(`new managed output unexpectedly became a directory: ${target}`);
      }
      fs.unlinkSync(target);
      continue;
    }
    if (fileMatchesReceipt(target, receipt)) continue;
    const bytes = backups.get(receipt.path);
    if (!bytes) fail(`verified transaction backup is missing: ${receipt.path}`);
    let current: fs.Stats | null = null;
    try {
      current = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fail(`could not inspect managed output before restore: ${target}`);
      }
    }
    if (current?.isDirectory()) {
      fail(`managed output unexpectedly became a directory: ${target}`);
    }
    atomicWriteTrustedFile(target, bytes, receipt.mode, receipt.uid, receipt.gid);
  }
}

function restoreDirectoryMetadata(
  receipts: readonly DirectoryReceipt[],
  options: ResolvedOptions,
): void {
  for (const receipt of [...receipts].reverse()) {
    const target = absoluteTarget(receipt.path, options);
    if (receipt.state === "absent") {
      try {
        fs.rmdirSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        fail(`could not remove newly created managed directory ${target}`);
      }
      continue;
    }
    if (directoryMatchesReceipt(target, receipt)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`managed directory changed type during restore: ${target}`);
    }
    fs.chownSync(target, receipt.uid, receipt.gid);
    fs.chmodSync(target, receipt.mode);
  }
}

function verifyRestoration(manifest: TransactionManifest, options: ResolvedOptions): void {
  for (const receipt of manifest.files) {
    const target = absoluteTarget(receipt.path, options);
    if (receipt.state === "absent") {
      if (pathExistsNoFollow(target)) {
        fail(`new managed output remained after rollback: ${target}`);
      }
      continue;
    }
    const stable = readStableFile(target, MAX_TRANSACTION_FILE_BYTES);
    if (
      stable.bytes.length !== receipt.size ||
      createHash("sha256").update(stable.bytes).digest("hex") !== receipt.sha256 ||
      Number(stable.stat.uid) !== receipt.uid ||
      Number(stable.stat.gid) !== receipt.gid ||
      Number(stable.stat.mode & 0o7777n) !== receipt.mode
    ) {
      fail(`managed output was not restored exactly: ${target}`);
    }
  }
  for (const receipt of manifest.directories) {
    const target = absoluteTarget(receipt.path, options);
    if (receipt.state === "absent") {
      if (pathExistsNoFollow(target)) {
        fail(`new managed directory remained after rollback: ${target}`);
      }
      continue;
    }
    const stat = fs.lstatSync(target);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== receipt.uid ||
      stat.gid !== receipt.gid ||
      modeOf(stat) !== receipt.mode
    ) {
      fail(`managed directory metadata was not restored exactly: ${target}`);
    }
  }
}

export function rollbackManagedStartupSharedStateTransaction(
  expectedAgent: ManagedStartupAgent,
  inputOptions: ManagedStartupSharedTransactionOptions = {},
): boolean {
  const options = resolveOptions(inputOptions);
  requireTransactionIdentity(options);
  const manifest = loadManifest(options);
  if (!manifest) return false;
  if (manifest.agent !== expectedAgent) {
    fail(`pending transaction targets ${manifest.agent}, expected ${expectedAgent}`);
  }
  const backups = verifyAllBackups(manifest.files, options);
  ensureOriginalDirectories(manifest.directories, options);
  restoreFiles(manifest.files, backups, options);
  restoreDirectoryMetadata(manifest.directories, options);
  verifyRestoration(manifest, options);
  if (!options.readOnlyReceipt) {
    removeTransactionDirectory(options);
  }
  return true;
}

export function commitManagedStartupSharedStateTransaction(
  expectedAgent: ManagedStartupAgent,
  inputOptions: ManagedStartupSharedTransactionOptions = {},
): boolean {
  const options = resolveOptions(inputOptions);
  requireTransactionIdentity(options);
  if (options.readOnlyReceipt) {
    fail("cannot commit a read-only rollback receipt");
  }
  const manifest = loadManifest(options);
  if (!manifest) return false;
  if (manifest.agent !== expectedAgent) {
    fail(`pending transaction targets ${manifest.agent}, expected ${expectedAgent}`);
  }
  removeTransactionDirectory(options);
  return true;
}
