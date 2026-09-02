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
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
} from "./profile";
import { managedStartupStateRootMountTargets } from "./state-roots";

const TRANSACTION_SCHEMA_VERSION = 1;
const MAX_TRANSACTION_FILES = 128;
const MAX_TRANSACTION_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSACTION_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_COMMIT_RECEIPT_BYTES = 4096;
const TRANSACTION_PARENT_DIRECTORY_MODE = 0o755;
const TRANSACTION_DIRECTORY_MODE = 0o700;
const TRANSACTION_FILE_MODE = 0o400;
const ATOMIC_TEMPORARY_FILE_MODE = 0o600;

export const MANAGED_STARTUP_SHARED_TRANSACTION_DIRECTORY =
  "/var/lib/nemoclaw/managed-startup-shared-state-transaction-v1";
export const MANAGED_STARTUP_SHARED_ROLLBACK_RECEIPT_DIRECTORY =
  "/run/nemoclaw/managed-startup-shared-rollback-receipt-v1";
export const MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY =
  "/var/lib/nemoclaw/managed-startup-shared-state-commit-v1";
const MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_FILE = "receipt.json";

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
  readonly bootstrapIdentity: string | null;
  readonly files: readonly FileReceipt[];
  readonly directories: readonly DirectoryReceipt[];
}

interface CommitReceipt {
  readonly schemaVersion: typeof TRANSACTION_SCHEMA_VERSION;
  readonly agent: ManagedStartupAgent;
  readonly profileFingerprint: string;
  readonly bootstrapIdentity: string;
}

export interface ManagedStartupSharedTransactionOptions {
  readonly sandboxRoot?: string;
  readonly transactionDirectory?: string;
  /** Test/helper seam. Production derives the fixed image-owned commit receipt path. */
  readonly commitReceiptDirectory?: string;
  /** Test seam. Production always retains the root:root defaults. */
  readonly trustedUid?: number;
  /** Test seam. Production always retains the root:root defaults. */
  readonly trustedGid?: number;
  /**
   * Immutable copied-receipt helper seam. The Docker client preserves source
   * metadata in a daemon volume, so ownership may reflect the Docker CLI user
   * instead of container root.
   */
  readonly readOnlyReceipt?: boolean;
  /** One-attempt identity for managed bootstrap; null for legacy root application. */
  readonly bootstrapIdentity?: string | null;
}

interface ResolvedOptions {
  readonly sandboxRoot: string;
  readonly transactionParentDirectory: string;
  readonly transactionDirectory: string;
  readonly backupDirectory: string;
  readonly manifestFile: string;
  readonly commitReceiptDirectory: string;
  readonly commitReceiptFile: string;
  readonly trustedUid: number;
  readonly trustedGid: number;
  readonly readOnlyReceipt: boolean;
  readonly bootstrapIdentity: string | null;
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
  const commitReceiptDirectory = path.resolve(
    options.commitReceiptDirectory ??
      (options.transactionDirectory
        ? path.join(
            path.dirname(transactionDirectory),
            path.basename(MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY),
          )
        : MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY),
  );
  if (
    transactionDirectory === sandboxRoot ||
    transactionDirectory.startsWith(`${sandboxRoot}${path.sep}`) ||
    commitReceiptDirectory === sandboxRoot ||
    commitReceiptDirectory.startsWith(`${sandboxRoot}${path.sep}`) ||
    path.dirname(commitReceiptDirectory) !== path.dirname(transactionDirectory) ||
    commitReceiptDirectory === transactionDirectory
  ) {
    fail("transaction and commit receipts require distinct paths outside sandbox-shared state");
  }
  const bootstrapIdentity = options.bootstrapIdentity ?? null;
  if (bootstrapIdentity !== null && !/^[a-f0-9]{64}$/u.test(bootstrapIdentity)) {
    fail("bootstrap identity must encode 32 lowercase-hex bytes");
  }
  return {
    sandboxRoot,
    transactionParentDirectory: path.dirname(transactionDirectory),
    transactionDirectory,
    backupDirectory: path.join(transactionDirectory, "backups"),
    manifestFile: path.join(transactionDirectory, "manifest.json"),
    commitReceiptDirectory,
    commitReceiptFile: path.join(
      commitReceiptDirectory,
      MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_FILE,
    ),
    trustedUid: options.trustedUid ?? 0,
    trustedGid: options.trustedGid ?? 0,
    readOnlyReceipt: options.readOnlyReceipt ?? false,
    bootstrapIdentity,
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

/**
 * SOURCE_OF_TRUTH_REVIEW
 * invalidState: an agent-declared managed state root appears on another filesystem and is rejected
 *   as a nested mount, while a broader exception could hide an unsafe descendant mount.
 * sourceBoundary: the managed state-root declaration authorizes only its exact agent root; these
 *   transaction validators remain authoritative for every descendant device boundary.
 * whyNotSourceFix: a managed volume necessarily changes the root device, so the transaction must
 *   adopt that device at the exact declared root and continue rejecting later device changes.
 * regressionTest: managed-startup-shared-state-transaction.test.ts proves exact-root prepare and
 *   rollback acceptance, descendant-mount rejection in both paths, and rejection for other agents.
 * removalCondition: remove this adoption when managed roots no longer arrive as distinct
 *   filesystem mounts, or when transaction storage moves wholly inside each declared root.
 */
function isDeclaredAgentStateRoot(
  expectedAgent: ManagedStartupAgent,
  outputRoot: string,
  options: ResolvedOptions,
): boolean {
  const relative = path.relative(options.sandboxRoot, outputRoot).split(path.sep).join("/");
  const canonicalTarget = path.posix.join("/sandbox", relative);
  return managedStartupStateRootMountTargets(expectedAgent).includes(canonicalTarget);
}

function validateExistingAncestors(
  target: string,
  expectedAgent: ManagedStartupAgent,
  options: ResolvedOptions,
): void {
  const relative = relativeTarget(target, options);
  const sandboxStat = requireDirectory(options.sandboxRoot, options);
  const outputRoot = agentRoot(expectedAgent, options.sandboxRoot);
  if (target !== outputRoot && !target.startsWith(`${outputRoot}${path.sep}`)) {
    fail(`transaction target escapes the ${expectedAgent} state root: ${target}`);
  }
  let current = options.sandboxRoot;
  let expectedDevice = sandboxStat.dev;
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
    // An exact agent-declared state root may cross from /sandbox onto its
    // managed volume. Every descendant must remain on that adopted device.
    if (current === outputRoot && isDeclaredAgentStateRoot(expectedAgent, outputRoot, options)) {
      expectedDevice = stat.dev;
    } else if (stat.dev !== expectedDevice) {
      fail(`transaction path crosses a nested filesystem mount: ${current}`);
    }
  }
}

function managedOutputDevice(expectedAgent: ManagedStartupAgent, options: ResolvedOptions): number {
  const sandboxStat = requireDirectory(options.sandboxRoot, options);
  const outputRoot = agentRoot(expectedAgent, options.sandboxRoot);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(outputRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return sandboxStat.dev;
    fail(`could not inspect managed output root ${outputRoot}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`managed output root is unsafe: ${outputRoot}`);
  }
  if (!isDeclaredAgentStateRoot(expectedAgent, outputRoot, options) && stat.dev !== sandboxStat.dev) {
    fail(`managed output root crosses a nested filesystem mount: ${outputRoot}`);
  }
  return stat.dev;
}

function agentRoot(agent: ManagedStartupAgent, sandboxRoot: string): string {
  switch (agent) {
    case "openclaw":
      return path.join(sandboxRoot, ".openclaw");
    case "hermes":
      return path.join(sandboxRoot, ".hermes");
    case "langchain-deepagents-code":
      return path.join(sandboxRoot, ".deepagents");
    case "pi":
      return path.join(sandboxRoot, ".pi");
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
    case "pi":
      directories.add(path.join(root, "agent"));
      files.add(path.join(root, "agent", "models.json"));
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
  expectedAgent: ManagedStartupAgent,
  options: ResolvedOptions,
): { readonly receipt: FileReceipt; readonly bytes: Buffer | null } {
  validateExistingAncestors(target, expectedAgent, options);
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
  if (stat.dev !== managedOutputDevice(expectedAgent, options)) {
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

function snapshotDirectory(
  target: string,
  expectedAgent: ManagedStartupAgent,
  options: ResolvedOptions,
): DirectoryReceipt {
  validateExistingAncestors(path.join(target, ".receipt"), expectedAgent, options);
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
  if (stat.dev !== managedOutputDevice(expectedAgent, options)) {
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

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function canonicalManifest(manifest: TransactionManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function canonicalLegacyManifest(manifest: TransactionManifest): string {
  return `${JSON.stringify(
    {
      schemaVersion: manifest.schemaVersion,
      agent: manifest.agent,
      profileFingerprint: manifest.profileFingerprint,
      files: manifest.files,
      directories: manifest.directories,
    },
    null,
    2,
  )}\n`;
}

function canonicalCommitReceipt(receipt: CommitReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    fail("transaction manifest contains unexpected fields");
  }
}

function parseCommitReceipt(text: string): CommitReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("commit receipt is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("commit receipt must be an object");
  }
  const record = parsed as Record<string, unknown>;
  requireExactKeys(record, ["agent", "bootstrapIdentity", "profileFingerprint", "schemaVersion"]);
  if (
    record.schemaVersion !== TRANSACTION_SCHEMA_VERSION ||
    !(MANAGED_STARTUP_AGENTS as readonly string[]).includes(String(record.agent)) ||
    typeof record.profileFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.profileFingerprint) ||
    typeof record.bootstrapIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.bootstrapIdentity)
  ) {
    fail("commit receipt has an invalid envelope");
  }
  const receipt: CommitReceipt = {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    agent: record.agent as ManagedStartupAgent,
    profileFingerprint: record.profileFingerprint,
    bootstrapIdentity: record.bootstrapIdentity,
  };
  if (canonicalCommitReceipt(receipt) !== text) {
    fail("commit receipt is not canonical");
  }
  return receipt;
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
  const hasBootstrapIdentity = Object.hasOwn(record, "bootstrapIdentity");
  requireExactKeys(
    record,
    hasBootstrapIdentity
      ? [
          "agent",
          "bootstrapIdentity",
          "directories",
          "files",
          "profileFingerprint",
          "schemaVersion",
        ]
      : ["agent", "directories", "files", "profileFingerprint", "schemaVersion"],
  );
  const bootstrapIdentity = hasBootstrapIdentity ? record.bootstrapIdentity : null;
  if (
    record.schemaVersion !== TRANSACTION_SCHEMA_VERSION ||
    !(MANAGED_STARTUP_AGENTS as readonly string[]).includes(String(record.agent)) ||
    typeof record.profileFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.profileFingerprint) ||
    !(
      bootstrapIdentity === null ||
      (typeof bootstrapIdentity === "string" && /^[a-f0-9]{64}$/u.test(bootstrapIdentity))
    ) ||
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
    bootstrapIdentity,
    files,
    directories,
  };
  const canonical = hasBootstrapIdentity
    ? canonicalManifest(manifest)
    : canonicalLegacyManifest(manifest);
  if (canonical !== text) {
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

function requireReadOnlyReceiptMount(target: string, options: ResolvedOptions): void {
  if (!options.readOnlyReceipt) return;
  const probe = path.join(target, ".nemoclaw-write-probe");
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
    fail("copied receipt must be mounted on a read-only filesystem");
  }
  fail("copied receipt mount is writable");
}

function loadManifest(options: ResolvedOptions): TransactionManifest | null {
  requireTransactionBoundaries(options);
  if (!pathExistsNoFollow(options.transactionDirectory)) return null;
  requireTrustedTransactionPath(options.transactionDirectory, TRANSACTION_DIRECTORY_MODE, options);
  requireReadOnlyReceiptMount(options.transactionDirectory, options);
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

function transactionOptionsAt(
  options: ResolvedOptions,
  transactionDirectory: string,
): ResolvedOptions {
  return {
    ...options,
    transactionDirectory,
    backupDirectory: path.join(transactionDirectory, "backups"),
    manifestFile: path.join(transactionDirectory, "manifest.json"),
  };
}

function loadCommitReceipt(
  options: ResolvedOptions,
): { readonly receipt: CommitReceipt; readonly compact: boolean } | null {
  requireTransactionBoundaries(options);
  if (!pathExistsNoFollow(options.commitReceiptDirectory)) return null;
  requireTrustedTransactionPath(
    options.commitReceiptDirectory,
    TRANSACTION_DIRECTORY_MODE,
    options,
  );
  if (pathExistsNoFollow(options.commitReceiptFile)) {
    requireReadOnlyReceiptMount(options.commitReceiptDirectory, options);
    requireTrustedTransactionPath(options.commitReceiptFile, TRANSACTION_FILE_MODE, options);
    const stable = readStableFile(options.commitReceiptFile, MAX_COMMIT_RECEIPT_BYTES);
    if (
      (!options.readOnlyReceipt &&
        (Number(stable.stat.uid) !== options.trustedUid ||
          Number(stable.stat.gid) !== options.trustedGid)) ||
      Number(stable.stat.mode & 0o7777n) !== TRANSACTION_FILE_MODE
    ) {
      fail("commit receipt ownership changed while it was read");
    }
    return { receipt: parseCommitReceipt(stable.bytes.toString("utf8")), compact: true };
  }
  const stagedOptions = transactionOptionsAt(options, options.commitReceiptDirectory);
  const staged = loadManifest(stagedOptions);
  if (!staged || staged.bootstrapIdentity === null) {
    fail("durable commit staging receipt is incomplete");
  }
  verifyAllBackups(staged.files, stagedOptions);
  return {
    receipt: {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      agent: staged.agent,
      profileFingerprint: staged.profileFingerprint,
      bootstrapIdentity: staged.bootstrapIdentity,
    },
    compact: false,
  };
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
  fsyncDirectory(options.transactionParentDirectory);
  if (pathExistsNoFollow(options.transactionDirectory)) {
    fail("transaction directory remained after cleanup");
  }
}

function assertCommitReceiptMatches(
  receipt: CommitReceipt,
  expected: {
    readonly agent: ManagedStartupAgent;
    readonly profileFingerprint?: string;
    readonly bootstrapIdentity: string;
  },
): void {
  if (
    receipt.agent !== expected.agent ||
    (expected.profileFingerprint !== undefined &&
      receipt.profileFingerprint !== expected.profileFingerprint) ||
    receipt.bootstrapIdentity !== expected.bootstrapIdentity
  ) {
    fail("durable commit receipt belongs to a different bootstrap attempt");
  }
}

function loadCommitStagingManifest(options: ResolvedOptions): TransactionManifest | null {
  if (!pathExistsNoFollow(options.manifestFile)) return null;
  requireTrustedTransactionPath(options.manifestFile, TRANSACTION_FILE_MODE, options);
  const stable = readStableFile(options.manifestFile, MAX_MANIFEST_BYTES);
  if (
    Number(stable.stat.uid) !== options.trustedUid ||
    Number(stable.stat.gid) !== options.trustedGid ||
    Number(stable.stat.mode & 0o7777n) !== TRANSACTION_FILE_MODE
  ) {
    fail("durable commit staging manifest ownership changed while it was read");
  }
  return parseManifest(stable.bytes.toString("utf8"));
}

function retireInterruptedCommitReceiptWrites(
  receipt: CommitReceipt,
  options: ResolvedOptions,
): void {
  const temporaryPattern = new RegExp(
    `^\\.${MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_FILE.replace(".", "\\.")}\\.[a-f0-9]{24}$`,
    "u",
  );
  for (const entry of fs.readdirSync(options.commitReceiptDirectory)) {
    if (!temporaryPattern.test(entry)) continue;
    const target = path.join(options.commitReceiptDirectory, entry);
    const stat = fs.lstatSync(target);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== options.trustedUid ||
      stat.gid !== options.trustedGid ||
      ![ATOMIC_TEMPORARY_FILE_MODE, TRANSACTION_FILE_MODE].includes(modeOf(stat))
    ) {
      fail("interrupted durable commit receipt write has unsafe metadata");
    }
    const stable = readStableFile(target, MAX_COMMIT_RECEIPT_BYTES);
    const mode = Number(stable.stat.mode & 0o7777n);
    if (
      Number(stable.stat.uid) !== options.trustedUid ||
      Number(stable.stat.gid) !== options.trustedGid ||
      ![ATOMIC_TEMPORARY_FILE_MODE, TRANSACTION_FILE_MODE].includes(mode)
    ) {
      fail("interrupted durable commit receipt write changed during verification");
    }
    if (stable.bytes.length > 0) {
      let interruptedReceipt: CommitReceipt | null = null;
      try {
        interruptedReceipt = parseCommitReceipt(stable.bytes.toString("utf8"));
      } catch {
        // The atomic writer may have crashed after any partial write. The
        // trusted 0700 directory and exact random temp-name shape bind this
        // artifact to that interrupted write; the established receipt is now
        // authoritative.
      }
      if (interruptedReceipt) assertCommitReceiptMatches(interruptedReceipt, receipt);
    }
    fs.unlinkSync(target);
    fsyncDirectory(options.commitReceiptDirectory);
  }
}

function compactDurableCommitReceipt(
  state: { readonly receipt: CommitReceipt; readonly compact: boolean },
  options: ResolvedOptions,
): void {
  if (!state.compact) {
    atomicWriteTrustedFile(
      options.commitReceiptFile,
      canonicalCommitReceipt(state.receipt),
      TRANSACTION_FILE_MODE,
      options.trustedUid,
      options.trustedGid,
    );
    fsyncDirectory(options.commitReceiptDirectory);
  }
  retireInterruptedCommitReceiptWrites(state.receipt, options);
  const stagedOptions = transactionOptionsAt(options, options.commitReceiptDirectory);
  const manifestExists = pathExistsNoFollow(stagedOptions.manifestFile);
  const backupsExist = pathExistsNoFollow(stagedOptions.backupDirectory);
  const unexpectedBeforeCleanup = fs
    .readdirSync(options.commitReceiptDirectory)
    .filter(
      (entry) =>
        ![
          MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_FILE,
          path.basename(stagedOptions.backupDirectory),
          path.basename(stagedOptions.manifestFile),
        ].includes(entry),
    );
  if (unexpectedBeforeCleanup.length !== 0) {
    fail("durable commit receipt directory contains unexpected artifacts");
  }
  if (manifestExists) {
    // The fsynced compact receipt is authoritative after commit. Validate the
    // remaining manifest identity without requiring a complete backup tree:
    // recursive backup deletion may have been interrupted at any point.
    const staged = loadCommitStagingManifest(stagedOptions);
    if (!staged || staged.bootstrapIdentity === null) {
      fail("durable commit staging receipt disappeared during cleanup");
    }
    assertCommitReceiptMatches(state.receipt, {
      agent: staged.agent,
      profileFingerprint: staged.profileFingerprint,
      bootstrapIdentity: staged.bootstrapIdentity,
    });
  }
  if (backupsExist) {
    requireTrustedTransactionPath(
      stagedOptions.backupDirectory,
      TRANSACTION_DIRECTORY_MODE,
      options,
    );
    fs.rmSync(stagedOptions.backupDirectory, { force: false, recursive: true });
    fsyncDirectory(options.commitReceiptDirectory);
  }
  if (manifestExists) {
    requireTrustedTransactionPath(stagedOptions.manifestFile, TRANSACTION_FILE_MODE, options);
    fs.unlinkSync(stagedOptions.manifestFile);
    fsyncDirectory(options.commitReceiptDirectory);
  }
  const unexpected = fs
    .readdirSync(options.commitReceiptDirectory)
    .filter((entry) => entry !== MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_FILE);
  if (unexpected.length !== 0) {
    fail("durable commit receipt directory contains unexpected artifacts");
  }
  const verified = loadCommitReceipt(options);
  if (!verified?.compact) fail("durable commit receipt did not compact successfully");
  assertCommitReceiptMatches(verified.receipt, state.receipt);
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
  const committed = loadCommitReceipt(options);
  if (committed) {
    if (options.bootstrapIdentity === null) {
      fail("a durable managed bootstrap commit receipt already exists");
    }
    assertCommitReceiptMatches(committed.receipt, {
      agent: profile.agent,
      profileFingerprint,
      bootstrapIdentity: options.bootstrapIdentity,
    });
    fail("this managed bootstrap attempt is already durably committed");
  }
  const pending = loadManifest(options);
  if (pending) {
    if (
      pending.agent !== profile.agent ||
      pending.profileFingerprint !== profileFingerprint ||
      pending.bootstrapIdentity !== options.bootstrapIdentity
    ) {
      fail(
        "a pending managed startup transaction belongs to a different agent, profile fingerprint, or bootstrap attempt",
      );
    }
    verifyAllBackups(pending.files, options);
    return false;
  }
  const targets = managedOutputTargets(profile, options);
  if (targets.files.length > MAX_TRANSACTION_FILES) {
    fail("managed startup transaction has too many file targets");
  }
  const snapshots = targets.files.map((target, index) =>
    snapshotFile(target, index, profile.agent, options),
  );
  const totalBytes = snapshots.reduce((sum, snapshot) => sum + (snapshot.bytes?.length ?? 0), 0);
  if (totalBytes > MAX_TRANSACTION_TOTAL_BYTES) {
    fail("managed startup transaction backup exceeds the total size limit");
  }
  const directories = targets.directories.map((target) =>
    snapshotDirectory(target, profile.agent, options),
  );
  const manifest: TransactionManifest = {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    agent: profile.agent,
    profileFingerprint,
    bootstrapIdentity: options.bootstrapIdentity,
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
    fsyncDirectory(options.transactionParentDirectory);
    fs.mkdirSync(options.backupDirectory, { mode: TRANSACTION_DIRECTORY_MODE });
    fs.chownSync(options.backupDirectory, options.trustedUid, options.trustedGid);
    fs.chmodSync(options.backupDirectory, TRANSACTION_DIRECTORY_MODE);
    fsyncDirectory(options.transactionDirectory);
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
    fsyncDirectory(options.backupDirectory);
    atomicWriteTrustedFile(
      options.manifestFile,
      canonicalManifest(manifest),
      TRANSACTION_FILE_MODE,
      options.trustedUid,
      options.trustedGid,
    );
    fsyncDirectory(options.transactionDirectory);
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
  expectedAgent: ManagedStartupAgent,
  options: ResolvedOptions,
): void {
  for (const receipt of receipts) {
    if (receipt.state !== "directory") continue;
    const target = absoluteTarget(receipt.path, options);
    validateExistingAncestors(path.join(target, ".restore"), expectedAgent, options);
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
  expectedAgent: ManagedStartupAgent,
  options: ResolvedOptions,
): void {
  for (const receipt of receipts) {
    const target = absoluteTarget(receipt.path, options);
    validateExistingAncestors(target, expectedAgent, options);
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
  const committed = loadCommitReceipt(options);
  if (committed) {
    if (options.bootstrapIdentity === null) {
      fail("shared state is already durably committed");
    }
    assertCommitReceiptMatches(committed.receipt, {
      agent: expectedAgent,
      bootstrapIdentity: options.bootstrapIdentity,
    });
    fail("shared state is already durably committed and cannot be rolled back");
  }
  const manifest = loadManifest(options);
  if (!manifest) return false;
  if (manifest.agent !== expectedAgent) {
    fail(`pending transaction targets ${manifest.agent}, expected ${expectedAgent}`);
  }
  if (manifest.bootstrapIdentity !== options.bootstrapIdentity) {
    fail("pending transaction belongs to a different bootstrap attempt");
  }
  const backups = verifyAllBackups(manifest.files, options);
  ensureOriginalDirectories(manifest.directories, expectedAgent, options);
  restoreFiles(manifest.files, backups, expectedAgent, options);
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
  const committed = loadCommitReceipt(options);
  if (committed) {
    if (options.bootstrapIdentity === null) {
      fail("durable commit receipt is missing its expected bootstrap identity");
    }
    assertCommitReceiptMatches(committed.receipt, {
      agent: expectedAgent,
      bootstrapIdentity: options.bootstrapIdentity,
    });
    compactDurableCommitReceipt(committed, options);
    return true;
  }
  const manifest = loadManifest(options);
  if (!manifest) return false;
  if (manifest.agent !== expectedAgent) {
    fail(`pending transaction targets ${manifest.agent}, expected ${expectedAgent}`);
  }
  if (manifest.bootstrapIdentity !== options.bootstrapIdentity) {
    fail("pending transaction belongs to a different bootstrap attempt");
  }
  if (manifest.bootstrapIdentity === null) {
    removeTransactionDirectory(options);
    return true;
  }
  verifyAllBackups(manifest.files, options);
  if (pathExistsNoFollow(options.commitReceiptDirectory)) {
    fail("durable commit receipt path appeared before transaction commit");
  }
  try {
    fs.renameSync(options.transactionDirectory, options.commitReceiptDirectory);
    fsyncDirectory(options.transactionParentDirectory);
  } catch (error) {
    fail(`could not atomically establish durable commit state: ${(error as Error).message}`);
  }
  const renamed = loadCommitReceipt(options);
  if (!renamed) fail("durable commit state disappeared after atomic rename");
  assertCommitReceiptMatches(renamed.receipt, {
    agent: expectedAgent,
    profileFingerprint: manifest.profileFingerprint,
    bootstrapIdentity: manifest.bootstrapIdentity,
  });
  compactDurableCommitReceipt(renamed, options);
  return true;
}

/**
 * Retire one exact durable bootstrap commit only after the runtime owner has
 * proven its external rollback backup is gone. This prevents a completed
 * attempt's image-owned receipt from blocking a later bootstrap with a
 * different identity in the same persisted workload.
 */
export function clearManagedStartupSharedStateCommitReceipt(
  expectedAgent: ManagedStartupAgent,
  inputOptions: ManagedStartupSharedTransactionOptions = {},
): boolean {
  const options = resolveOptions(inputOptions);
  requireTransactionIdentity(options);
  if (options.readOnlyReceipt) {
    fail("cannot clear a durable commit from a read-only receipt");
  }
  if (options.bootstrapIdentity === null) {
    fail("durable commit cleanup requires its bootstrap identity");
  }
  const committed = loadCommitReceipt(options);
  if (!committed) return false;
  assertCommitReceiptMatches(committed.receipt, {
    agent: expectedAgent,
    bootstrapIdentity: options.bootstrapIdentity,
  });
  compactDurableCommitReceipt(committed, options);
  requireTrustedTransactionPath(
    options.commitReceiptDirectory,
    TRANSACTION_DIRECTORY_MODE,
    options,
  );
  requireTrustedTransactionPath(options.commitReceiptFile, TRANSACTION_FILE_MODE, options);
  const entries = fs.readdirSync(options.commitReceiptDirectory);
  if (entries.length !== 1 || entries[0] !== MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_FILE) {
    fail("durable commit receipt directory contains unexpected artifacts");
  }
  fs.rmSync(options.commitReceiptDirectory, { force: false, recursive: true });
  fsyncDirectory(options.transactionParentDirectory);
  if (pathExistsNoFollow(options.commitReceiptDirectory)) {
    fail("durable commit receipt remained after cleanup");
  }
  return true;
}

export function getManagedStartupSharedStateTransactionStatus(
  expected: {
    readonly agent: ManagedStartupAgent;
    readonly profileFingerprint: string;
    readonly bootstrapIdentity: string;
  },
  inputOptions: ManagedStartupSharedTransactionOptions = {},
): "committed" | "none" | "pending" {
  const options = resolveOptions({
    ...inputOptions,
    bootstrapIdentity: expected.bootstrapIdentity,
  });
  requireTransactionIdentity(options);
  const manifest = loadManifest(options);
  if (manifest) {
    if (
      manifest.agent !== expected.agent ||
      manifest.profileFingerprint !== expected.profileFingerprint ||
      manifest.bootstrapIdentity !== expected.bootstrapIdentity
    ) {
      fail(
        "pending transaction does not match the expected agent, profile fingerprint, or bootstrap identity",
      );
    }
    verifyAllBackups(manifest.files, options);
    return "pending";
  }
  const committed = loadCommitReceipt(options);
  if (!committed) return "none";
  assertCommitReceiptMatches(committed.receipt, expected);
  return "committed";
}
