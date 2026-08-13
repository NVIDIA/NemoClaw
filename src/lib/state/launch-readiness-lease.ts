// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { nemoclawStateRoot } from "./state-root";

export const LAUNCH_READINESS_LEASE_MS = 24 * 60 * 60 * 1_000;
export const LAUNCH_READINESS_SCHEMA_VERSION = 1;
export const LAUNCH_READINESS_MAX_BYTES = 16 * 1_024;

const RECEIPT_DIRECTORY = "launch-readiness";
const SHA256_RE = /^[a-f0-9]{64}$/;
const BOOT_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export interface LaunchReadinessIdentity {
  registry: string;
  agent: string;
  livePolicy: string;
  liveInference: string;
  gatewayName: string;
  lifecycleGeneration: string;
  liveIdentityFingerprint: string;
}

export interface LaunchReadinessLease {
  schemaVersion: 1;
  kind: "lease";
  epochId: string;
  sandboxName: string;
  leaseStartedWallMs: number;
  leaseExpiresWallMs: number;
  elapsedAtPublicationMs: number;
  publishedWallMs: number;
  publishedUptimeMs: number;
  bootId: string;
  uid: number;
  homeDevice: string;
  homeInode: string;
  storeDevice: string;
  storeInode: string;
  identity: LaunchReadinessIdentity;
}

export interface LaunchReadinessFence {
  schemaVersion: 1;
  kind: "fence";
  epochId: string;
  sandboxName: string;
  fencedWallMs: number;
  fencedUptimeMs: number;
  bootId: string;
  uid: number;
  homeDevice: string;
  homeInode: string;
  storeDevice: string;
  storeInode: string;
  publicationState: "ready" | "time-unsafe";
  preservedLeaseStartedWallMs: number | null;
  preservedLeaseExpiresWallMs: number | null;
  preservedLeaseElapsedMs: number | null;
}

export type LaunchReadinessRecord = LaunchReadinessLease | LaunchReadinessFence;

export type LaunchReadinessLeaseRead =
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "malformed" }
  | { kind: "expired"; lease: LaunchReadinessLease }
  | { kind: "identity"; lease: LaunchReadinessLease }
  | { kind: "valid"; lease: LaunchReadinessLease };

export interface LaunchReadinessStoreOptions {
  home?: string;
  nowWallMs?: () => number;
  nowUptimeMs?: () => number;
  bootId?: () => string | null;
  uid?: () => number | null;
  randomEpoch?: () => string;
}

interface StoreContext {
  home: string;
  stateRoot: string;
  receiptDir: string;
  receiptPath: string;
  uid: number;
  nowWallMs: number;
  nowUptimeMs: number;
  bootId: string;
  homeDevice: string;
  homeInode: string;
  randomEpoch: () => string;
}

interface SecureDirectory {
  fd: number;
  stat: fs.Stats;
}

class MissingReceiptError extends Error {}
class UnsafeReceiptError extends Error {}
class MalformedReceiptError extends Error {}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isEpoch(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isIdentity(value: unknown): value is LaunchReadinessIdentity {
  if (!isPlainRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "registry",
      "agent",
      "livePolicy",
      "liveInference",
      "gatewayName",
      "lifecycleGeneration",
      "liveIdentityFingerprint",
    ])
  ) {
    return false;
  }
  return (
    typeof value.gatewayName === "string" &&
    value.gatewayName.length > 0 &&
    value.gatewayName.length <= 256 &&
    typeof value.lifecycleGeneration === "string" &&
    value.lifecycleGeneration.length > 0 &&
    value.lifecycleGeneration.length <= 256 &&
    typeof value.liveIdentityFingerprint === "string" &&
    SHA256_RE.test(value.liveIdentityFingerprint) &&
    typeof value.registry === "string" &&
    SHA256_RE.test(value.registry) &&
    typeof value.agent === "string" &&
    SHA256_RE.test(value.agent) &&
    typeof value.livePolicy === "string" &&
    SHA256_RE.test(value.livePolicy) &&
    typeof value.liveInference === "string" &&
    SHA256_RE.test(value.liveInference)
  );
}

function parseRecord(raw: string): LaunchReadinessRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new MalformedReceiptError();
  }
  if (!isPlainRecord(value) || value.schemaVersion !== LAUNCH_READINESS_SCHEMA_VERSION) {
    throw new MalformedReceiptError();
  }
  if (value.kind === "lease") {
    if (
      !hasExactKeys(value, [
        "schemaVersion",
        "kind",
        "epochId",
        "sandboxName",
        "leaseStartedWallMs",
        "leaseExpiresWallMs",
        "elapsedAtPublicationMs",
        "publishedWallMs",
        "publishedUptimeMs",
        "bootId",
        "uid",
        "homeDevice",
        "homeInode",
        "storeDevice",
        "storeInode",
        "identity",
      ]) ||
      !isEpoch(value.epochId) ||
      typeof value.sandboxName !== "string" ||
      value.sandboxName.length === 0 ||
      value.sandboxName.length > 256 ||
      !isSafeInteger(value.leaseStartedWallMs) ||
      !isSafeInteger(value.leaseExpiresWallMs) ||
      !isSafeInteger(value.elapsedAtPublicationMs) ||
      !isSafeInteger(value.publishedWallMs) ||
      !isSafeInteger(value.publishedUptimeMs) ||
      typeof value.bootId !== "string" ||
      !BOOT_ID_RE.test(value.bootId) ||
      !isSafeInteger(value.uid) ||
      typeof value.homeDevice !== "string" ||
      !/^\d+$/.test(value.homeDevice) ||
      typeof value.homeInode !== "string" ||
      !/^\d+$/.test(value.homeInode) ||
      typeof value.storeDevice !== "string" ||
      !/^\d+$/.test(value.storeDevice) ||
      typeof value.storeInode !== "string" ||
      !/^\d+$/.test(value.storeInode) ||
      !isIdentity(value.identity)
    ) {
      throw new MalformedReceiptError();
    }
    return value as unknown as LaunchReadinessLease;
  }
  if (value.kind === "fence") {
    if (
      !hasExactKeys(value, [
        "schemaVersion",
        "kind",
        "epochId",
        "sandboxName",
        "fencedWallMs",
        "fencedUptimeMs",
        "bootId",
        "uid",
        "homeDevice",
        "homeInode",
        "storeDevice",
        "storeInode",
        "publicationState",
        "preservedLeaseStartedWallMs",
        "preservedLeaseExpiresWallMs",
        "preservedLeaseElapsedMs",
      ]) ||
      !isEpoch(value.epochId) ||
      typeof value.sandboxName !== "string" ||
      value.sandboxName.length === 0 ||
      value.sandboxName.length > 256 ||
      !isSafeInteger(value.fencedWallMs) ||
      !isSafeInteger(value.fencedUptimeMs) ||
      typeof value.bootId !== "string" ||
      !BOOT_ID_RE.test(value.bootId) ||
      !isSafeInteger(value.uid) ||
      typeof value.homeDevice !== "string" ||
      !/^\d+$/.test(value.homeDevice) ||
      typeof value.homeInode !== "string" ||
      !/^\d+$/.test(value.homeInode) ||
      typeof value.storeDevice !== "string" ||
      !/^\d+$/.test(value.storeDevice) ||
      typeof value.storeInode !== "string" ||
      !/^\d+$/.test(value.storeInode) ||
      (value.publicationState !== "ready" && value.publicationState !== "time-unsafe") ||
      !(
        value.preservedLeaseStartedWallMs === null ||
        isSafeInteger(value.preservedLeaseStartedWallMs)
      ) ||
      !(
        value.preservedLeaseExpiresWallMs === null ||
        isSafeInteger(value.preservedLeaseExpiresWallMs)
      ) ||
      !(value.preservedLeaseElapsedMs === null || isSafeInteger(value.preservedLeaseElapsedMs))
    ) {
      throw new MalformedReceiptError();
    }
    const hasStart = value.preservedLeaseStartedWallMs !== null;
    const hasExpiry = value.preservedLeaseExpiresWallMs !== null;
    const hasElapsed = value.preservedLeaseElapsedMs !== null;
    if (hasStart !== hasExpiry || hasStart !== hasElapsed) throw new MalformedReceiptError();
    if (
      hasStart &&
      (value.preservedLeaseExpiresWallMs as number) -
        (value.preservedLeaseStartedWallMs as number) !==
        LAUNCH_READINESS_LEASE_MS
    ) {
      throw new MalformedReceiptError();
    }
    if (hasElapsed && (value.preservedLeaseElapsedMs as number) > LAUNCH_READINESS_LEASE_MS) {
      throw new MalformedReceiptError();
    }
    return value as unknown as LaunchReadinessFence;
  }
  throw new MalformedReceiptError();
}

function readLinuxBootId(): string | null {
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return BOOT_ID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

function readDarwinBootId(): string | null {
  try {
    const output = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    const match = output.match(/sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/);
    if (!match) return null;
    const value = `darwin:${match[1]}:${match[2]}`;
    return BOOT_ID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function readTrustedBootId(): string | null {
  if (process.platform === "linux") return readLinuxBootId();
  if (process.platform === "darwin") return readDarwinBootId();
  return null;
}

function currentUid(): number | null {
  const value = process.getuid?.();
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : null;
}

function trustedCurrentUserHome(uid: number): string | null {
  try {
    const user = os.userInfo();
    if (user.uid !== uid || typeof user.homedir !== "string" || !path.isAbsolute(user.homedir)) {
      return null;
    }
    return user.homedir;
  } catch {
    return null;
  }
}

function receiptKey(sandboxName: string): string {
  return createHash("sha256").update(sandboxName, "utf8").digest("hex");
}

function buildContext(
  sandboxName: string,
  gatewayPort: number,
  options: LaunchReadinessStoreOptions,
): StoreContext {
  const uid = (options.uid ?? currentUid)();
  const bootId = (options.bootId ?? readTrustedBootId)();
  const nowWallMs = (options.nowWallMs ?? Date.now)();
  const nowUptimeMs = (options.nowUptimeMs ?? (() => Math.floor(os.uptime() * 1_000)))();
  if (
    uid === null ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !bootId ||
    !BOOT_ID_RE.test(bootId) ||
    !isSafeInteger(nowWallMs) ||
    !isSafeInteger(nowUptimeMs)
  ) {
    throw new UnsafeReceiptError();
  }
  const homeAuthority = options.home ?? trustedCurrentUserHome(uid);
  if (!homeAuthority) throw new UnsafeReceiptError();
  const home = path.resolve(homeAuthority);
  let homeStat: fs.Stats;
  try {
    homeStat = fs.lstatSync(home);
  } catch {
    throw new UnsafeReceiptError();
  }
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || homeStat.uid !== uid) {
    throw new UnsafeReceiptError();
  }
  const stateRoot = nemoclawStateRoot(home, gatewayPort);
  const receiptDir = path.join(stateRoot, RECEIPT_DIRECTORY);
  return {
    home,
    stateRoot,
    receiptDir,
    receiptPath: path.join(receiptDir, `${receiptKey(sandboxName)}.json`),
    uid,
    nowWallMs,
    nowUptimeMs,
    bootId,
    homeDevice: String(homeStat.dev),
    homeInode: String(homeStat.ino),
    randomEpoch: options.randomEpoch ?? (() => randomBytes(32).toString("hex")),
  };
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSecureDirectoryStat(stat: fs.Stats, uid: number, privateDirectory: boolean): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new UnsafeReceiptError();
  }
  if (privateDirectory && (stat.mode & 0o777) !== 0o700) throw new UnsafeReceiptError();
}

function ancestorPaths(home: string, target: string): string[] {
  const relative = path.relative(home, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new UnsafeReceiptError();
  const paths = [home];
  let current = home;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    paths.push(current);
  }
  return paths;
}

function ensureSecureDirectory(context: StoreContext, create: boolean): SecureDirectory {
  const paths = ancestorPaths(context.home, context.receiptDir);
  for (const [index, candidate] of paths.entries()) {
    const privateDirectory = candidate === context.receiptDir;
    try {
      const stat = fs.lstatSync(candidate);
      assertSecureDirectoryStat(stat, context.uid, privateDirectory);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || !create) {
        if (error instanceof UnsafeReceiptError) throw error;
        throw new UnsafeReceiptError();
      }
      if (index === 0) throw new UnsafeReceiptError();
      try {
        fs.mkdirSync(candidate, { mode: 0o700 });
        fs.chmodSync(candidate, 0o700);
        assertSecureDirectoryStat(fs.lstatSync(candidate), context.uid, privateDirectory);
      } catch {
        throw new UnsafeReceiptError();
      }
    }
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(context.receiptDir, fs.constants.O_RDONLY | noFollow | directoryOnly);
  } catch {
    throw new UnsafeReceiptError();
  }
  try {
    const descriptorStat = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(context.receiptDir);
    assertSecureDirectoryStat(descriptorStat, context.uid, true);
    assertSecureDirectoryStat(pathStat, context.uid, true);
    if (!sameIdentity(descriptorStat, pathStat)) throw new UnsafeReceiptError();
    return { fd, stat: descriptorStat };
  } catch (error) {
    fs.closeSync(fd);
    if (error instanceof UnsafeReceiptError) throw error;
    throw new UnsafeReceiptError();
  }
}

function revalidateDirectory(context: StoreContext, directory: SecureDirectory): void {
  const descriptorStat = fs.fstatSync(directory.fd);
  const pathStat = fs.lstatSync(context.receiptDir);
  assertSecureDirectoryStat(descriptorStat, context.uid, true);
  assertSecureDirectoryStat(pathStat, context.uid, true);
  if (!sameIdentity(directory.stat, descriptorStat) || !sameIdentity(directory.stat, pathStat)) {
    throw new UnsafeReceiptError();
  }
}

function assertSecureReceiptStat(stat: fs.Stats, uid: number): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > LAUNCH_READINESS_MAX_BYTES
  ) {
    throw new UnsafeReceiptError();
  }
}

function readRecordAtPath(
  context: StoreContext,
  directory: SecureDirectory,
): LaunchReadinessRecord {
  revalidateDirectory(context, directory);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(context.receiptPath, flags);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new MissingReceiptError();
    }
    throw new UnsafeReceiptError();
  }
  try {
    const before = fs.fstatSync(fd);
    assertSecureReceiptStat(before, context.uid);
    const buffer = Buffer.alloc(LAUNCH_READINESS_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    if (total > LAUNCH_READINESS_MAX_BYTES) throw new UnsafeReceiptError();
    const after = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(context.receiptPath);
    assertSecureReceiptStat(after, context.uid);
    assertSecureReceiptStat(pathStat, context.uid);
    if (
      !sameIdentity(before, after) ||
      !sameIdentity(before, pathStat) ||
      before.size !== after.size ||
      total !== after.size
    ) {
      throw new UnsafeReceiptError();
    }
    revalidateDirectory(context, directory);
    return parseRecord(buffer.subarray(0, total).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function tempPath(context: StoreContext): string {
  return path.join(
    context.receiptDir,
    `.${path.basename(context.receiptPath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
}

function proveWritable(context: StoreContext, directory: SecureDirectory): void {
  revalidateDirectory(context, directory);
  const candidate = tempPath(context);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      candidate,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    revalidateDirectory(context, directory);
    fs.unlinkSync(candidate);
    fs.fsyncSync(directory.fd);
  } catch {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(candidate);
    } catch {
      // The store is already classified unsafe; cleanup is best effort.
    }
    throw new UnsafeReceiptError();
  }
}

function writeRecord(
  context: StoreContext,
  directory: SecureDirectory,
  record: LaunchReadinessRecord,
): void {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized) > LAUNCH_READINESS_MAX_BYTES) {
    throw new UnsafeReceiptError();
  }
  revalidateDirectory(context, directory);
  const candidate = tempPath(context);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      candidate,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.fchmodSync(fd, 0o600);
    const buffer = Buffer.from(serialized, "utf8");
    let written = 0;
    while (written < buffer.length) written += fs.writeSync(fd, buffer, written);
    fs.fsyncSync(fd);
    const tempStat = fs.fstatSync(fd);
    assertSecureReceiptStat(tempStat, context.uid);
    fs.closeSync(fd);
    fd = null;
    revalidateDirectory(context, directory);
    const tempPathStat = fs.lstatSync(candidate);
    assertSecureReceiptStat(tempPathStat, context.uid);
    if (!sameIdentity(tempStat, tempPathStat)) throw new UnsafeReceiptError();
    fs.renameSync(candidate, context.receiptPath);
    fs.fsyncSync(directory.fd);
    const published = readRecordAtPath(context, directory);
    if (published.epochId !== record.epochId || published.kind !== record.kind) {
      throw new UnsafeReceiptError();
    }
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(candidate);
    } catch {
      // Preserve the original store error.
    }
    if (error instanceof UnsafeReceiptError || error instanceof MalformedReceiptError) throw error;
    throw new UnsafeReceiptError();
  }
}

function recordContextMatches(
  record: LaunchReadinessRecord,
  context: StoreContext,
  storeStat: fs.Stats,
): boolean {
  return (
    record.uid === context.uid &&
    record.bootId === context.bootId &&
    record.homeDevice === context.homeDevice &&
    record.homeInode === context.homeInode &&
    record.storeDevice === String(storeStat.dev) &&
    record.storeInode === String(storeStat.ino)
  );
}

function validateLeaseTime(
  lease: LaunchReadinessLease,
  context: StoreContext,
  storeStat: fs.Stats,
): "valid" | "expired" | "identity" | "malformed" {
  if (lease.leaseExpiresWallMs - lease.leaseStartedWallMs !== LAUNCH_READINESS_LEASE_MS) {
    return "malformed";
  }
  if (
    lease.publishedWallMs < lease.leaseStartedWallMs ||
    lease.publishedWallMs > lease.leaseExpiresWallMs ||
    lease.elapsedAtPublicationMs >= LAUNCH_READINESS_LEASE_MS ||
    lease.elapsedAtPublicationMs < lease.publishedWallMs - lease.leaseStartedWallMs ||
    context.nowWallMs < lease.leaseStartedWallMs ||
    context.nowWallMs < lease.publishedWallMs
  ) {
    return "malformed";
  }
  const wallElapsed = context.nowWallMs - lease.leaseStartedWallMs;
  if (context.nowWallMs >= lease.leaseExpiresWallMs || wallElapsed > LAUNCH_READINESS_LEASE_MS) {
    return "expired";
  }
  if (!recordContextMatches(lease, context, storeStat)) return "identity";
  if (context.nowUptimeMs < lease.publishedUptimeMs) return "malformed";
  const monotonicElapsed =
    lease.elapsedAtPublicationMs + (context.nowUptimeMs - lease.publishedUptimeMs);
  if (
    !Number.isSafeInteger(monotonicElapsed) ||
    monotonicElapsed < 0 ||
    monotonicElapsed >= LAUNCH_READINESS_LEASE_MS
  ) {
    return monotonicElapsed >= LAUNCH_READINESS_LEASE_MS ? "expired" : "malformed";
  }
  return "valid";
}

function closeDirectory(directory: SecureDirectory | null): void {
  if (directory) fs.closeSync(directory.fd);
}

export function readLaunchReadinessLease(
  sandboxName: string,
  gatewayPort: number,
  options: LaunchReadinessStoreOptions = {},
): LaunchReadinessLeaseRead {
  let directory: SecureDirectory | null = null;
  try {
    const context = buildContext(sandboxName, gatewayPort, options);
    directory = ensureSecureDirectory(context, false);
    const record = readRecordAtPath(context, directory);
    if (record.kind !== "lease" || record.sandboxName !== sandboxName) return { kind: "missing" };
    proveWritable(context, directory);
    const time = validateLeaseTime(record, context, directory.stat);
    if (time === "malformed") return { kind: "malformed" };
    if (time === "expired") return { kind: "expired", lease: record };
    if (time === "identity") return { kind: "identity", lease: record };
    return { kind: "valid", lease: record };
  } catch (error) {
    if (error instanceof MissingReceiptError) return { kind: "missing" };
    if (error instanceof MalformedReceiptError) return { kind: "malformed" };
    return { kind: "unsafe" };
  } finally {
    closeDirectory(directory);
  }
}

function recordTimeline(
  record: LaunchReadinessRecord | null,
): { started: number; expires: number; elapsed: number } | null {
  const started =
    record?.kind === "lease" ? record.leaseStartedWallMs : record?.preservedLeaseStartedWallMs;
  const expires =
    record?.kind === "lease" ? record.leaseExpiresWallMs : record?.preservedLeaseExpiresWallMs;
  const elapsed =
    record?.kind === "lease" ? record.elapsedAtPublicationMs : record?.preservedLeaseElapsedMs;
  if (
    started === null ||
    started === undefined ||
    expires === null ||
    expires === undefined ||
    elapsed === null ||
    elapsed === undefined ||
    elapsed > LAUNCH_READINESS_LEASE_MS ||
    expires - started !== LAUNCH_READINESS_LEASE_MS
  ) {
    return null;
  }
  return { started, expires, elapsed };
}

function publicationTimeline(
  record: LaunchReadinessRecord | null,
  context: StoreContext,
): {
  timeline: { started: number; expires: number; elapsed: number } | null;
  state: "ready" | "time-unsafe";
} {
  const timeline = recordTimeline(record);
  if (!record || !timeline) return { timeline: null, state: "ready" };
  if (record.kind === "fence" && record.publicationState === "time-unsafe") {
    return context.nowWallMs >= timeline.expires
      ? { timeline: null, state: "ready" }
      : { timeline, state: "time-unsafe" };
  }
  const clockRollback =
    context.nowWallMs < timeline.started ||
    (record.kind === "lease" && context.nowWallMs < record.publishedWallMs) ||
    (record.bootId === context.bootId &&
      context.nowUptimeMs <
        (record.kind === "lease" ? record.publishedUptimeMs : record.fencedUptimeMs));
  if (clockRollback) return { timeline, state: "time-unsafe" };
  const observedUptimeMs =
    record.kind === "lease" ? record.publishedUptimeMs : record.fencedUptimeMs;
  const elapsed = Math.max(
    timeline.elapsed +
      (record.bootId === context.bootId ? context.nowUptimeMs - observedUptimeMs : 0),
    context.nowWallMs - timeline.started,
  );
  if (
    !Number.isSafeInteger(elapsed) ||
    elapsed >= LAUNCH_READINESS_LEASE_MS ||
    context.nowWallMs >= timeline.expires
  ) {
    return { timeline: null, state: "ready" };
  }
  return { timeline: { ...timeline, elapsed }, state: "ready" };
}

/**
 * Replace any prior lease with a durable random publication epoch.
 *
 * The caller must hold the sandbox lifecycle lock followed by the owning
 * gateway route lock. The complete preflight must run only after those locks
 * are released.
 */
export function fenceLaunchReadinessLease(
  sandboxName: string,
  gatewayPort: number,
  options: LaunchReadinessStoreOptions = {},
): LaunchReadinessFence {
  let directory: SecureDirectory | null = null;
  try {
    const context = buildContext(sandboxName, gatewayPort, options);
    directory = ensureSecureDirectory(context, true);
    let existing: LaunchReadinessRecord | null = null;
    try {
      existing = readRecordAtPath(context, directory);
      if (existing.sandboxName !== sandboxName) existing = null;
    } catch (error) {
      if (!(error instanceof MissingReceiptError) && !(error instanceof MalformedReceiptError)) {
        throw error;
      }
    }
    const publication = publicationTimeline(existing, context);
    const epochId = context.randomEpoch();
    if (!isEpoch(epochId)) throw new UnsafeReceiptError();
    const fence: LaunchReadinessFence = {
      schemaVersion: LAUNCH_READINESS_SCHEMA_VERSION,
      kind: "fence",
      epochId,
      sandboxName,
      fencedWallMs: context.nowWallMs,
      fencedUptimeMs: context.nowUptimeMs,
      bootId: context.bootId,
      uid: context.uid,
      homeDevice: context.homeDevice,
      homeInode: context.homeInode,
      storeDevice: String(directory.stat.dev),
      storeInode: String(directory.stat.ino),
      publicationState: publication.state,
      preservedLeaseStartedWallMs: publication.timeline?.started ?? null,
      preservedLeaseExpiresWallMs: publication.timeline?.expires ?? null,
      preservedLeaseElapsedMs: publication.timeline?.elapsed ?? null,
    };
    writeRecord(context, directory, fence);
    return fence;
  } finally {
    closeDirectory(directory);
  }
}

/** Publish only when the exact fence epoch is still authoritative. */
export function publishLaunchReadinessLease(
  sandboxName: string,
  gatewayPort: number,
  expectedEpochId: string,
  identity: LaunchReadinessIdentity,
  options: LaunchReadinessStoreOptions = {},
): LaunchReadinessLease {
  let directory: SecureDirectory | null = null;
  try {
    const context = buildContext(sandboxName, gatewayPort, options);
    directory = ensureSecureDirectory(context, false);
    const record = readRecordAtPath(context, directory);
    if (
      record.kind !== "fence" ||
      record.sandboxName !== sandboxName ||
      record.epochId !== expectedEpochId ||
      !recordContextMatches(record, context, directory.stat)
    ) {
      throw new Error("Launch readiness publication authority changed.");
    }
    if (record.publicationState !== "ready") {
      throw new Error(
        "Launch readiness publication is disabled after an unsafe clock observation.",
      );
    }
    const publication = publicationTimeline(record, context);
    if (publication.state !== "ready") {
      throw new Error("Launch readiness publication time is unsafe.");
    }
    const timeline = publication.timeline;
    const leaseStartedWallMs = timeline?.started ?? context.nowWallMs;
    const leaseExpiresWallMs = timeline?.expires ?? context.nowWallMs + LAUNCH_READINESS_LEASE_MS;
    const elapsedAtPublicationMs = timeline?.elapsed ?? 0;
    if (!Number.isSafeInteger(leaseExpiresWallMs)) throw new UnsafeReceiptError();
    const lease: LaunchReadinessLease = {
      schemaVersion: LAUNCH_READINESS_SCHEMA_VERSION,
      kind: "lease",
      epochId: record.epochId,
      sandboxName,
      leaseStartedWallMs,
      leaseExpiresWallMs,
      elapsedAtPublicationMs,
      publishedWallMs: context.nowWallMs,
      publishedUptimeMs: context.nowUptimeMs,
      bootId: context.bootId,
      uid: context.uid,
      homeDevice: context.homeDevice,
      homeInode: context.homeInode,
      storeDevice: String(directory.stat.dev),
      storeInode: String(directory.stat.ino),
      identity,
    };
    if (validateLeaseTime(lease, context, directory.stat) !== "valid") {
      throw new Error("Launch readiness lease time envelope is no longer valid.");
    }
    writeRecord(context, directory, lease);
    return lease;
  } finally {
    closeDirectory(directory);
  }
}

export function launchReadinessReceiptPath(
  sandboxName: string,
  gatewayPort: number,
  home: string,
): string {
  return path.join(
    nemoclawStateRoot(path.resolve(home), gatewayPort),
    RECEIPT_DIRECTORY,
    `${receiptKey(sandboxName)}.json`,
  );
}
