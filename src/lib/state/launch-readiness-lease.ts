// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { nemoclawStateRoot } from "./state-root";

export const LAUNCH_READINESS_LEASE_MS = 24 * 60 * 60 * 1_000;
// This version covers lease and fence records. Nested session qualifications
// and the separate runtime authority keep their independent schema versions.
export const LAUNCH_READINESS_SCHEMA_VERSION = 3;
export const LAUNCH_READINESS_MAX_BYTES = 16 * 1_024;

const RECEIPT_DIRECTORY = "launch-readiness";
const AUTHORITY_PRODUCT_DIRECTORY = "nemoclaw";
const AUTHORITY_DIRECTORY = "launch-readiness";
const SHA256_RE = /^[a-f0-9]{64}$/;
const BOOT_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export interface LaunchReadinessIdentity {
  registry: string;
  agent: string;
  liveInference: string;
  gatewayName: string;
  lifecycleGeneration: string;
  liveIdentityFingerprint: string;
  session: LaunchReadinessSessionQualification | null;
}

export interface LaunchReadinessOpenClawSessionQualification {
  schemaVersion: 1;
  kind: "openclaw-pairing";
  openclawVersion: string;
  deviceIdentitySha256: string;
  pairingStateSha256: string;
  requiredRoles: ["operator"];
  requiredScopes: ["operator.pairing", "operator.read", "operator.write"];
}

export type LaunchReadinessSessionQualification = LaunchReadinessOpenClawSessionQualification;

export interface LaunchReadinessLease {
  schemaVersion: 3;
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
  gatewayName: string;
  gatewayPort: number;
  identity: LaunchReadinessIdentity;
}

export interface LaunchReadinessFence {
  schemaVersion: 3;
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
  gatewayName: string;
  gatewayPort: number;
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

export type LaunchReadinessMutationAuthorityCheck = "current" | "changed" | "unsafe";

export interface LaunchReadinessStoreOptions {
  home?: string;
  nowWallMs?: () => number;
  nowUptimeMs?: () => number;
  bootId?: () => string | null;
  uid?: () => number | null;
  randomEpoch?: () => string;
  /** Test seam only. Production derives the runtime authority root from the OS. */
  runtimeAuthorityRoot?: () => string | null;
}

interface LaunchReadinessAuthority {
  schemaVersion: 1;
  kind: "authority";
  phase: "fence" | "lease";
  epochId: string;
  sandboxName: string;
  gatewayName: string;
  gatewayPort: number;
  observedWallMs: number;
  observedUptimeMs: number;
  bootId: string;
  uid: number;
  runtimeRootDevice: string;
  runtimeRootInode: string;
  storeDevice: string;
  storeInode: string;
  publicationState: "ready" | "time-unsafe";
  preservedLeaseStartedWallMs: number | null;
  preservedLeaseExpiresWallMs: number | null;
  preservedLeaseElapsedMs: number | null;
}

interface BaseContext {
  uid: number;
  nowWallMs: number;
  nowUptimeMs: number;
  bootId: string;
  randomEpoch: () => string;
  runtimeAuthorityRoot: (() => string | null) | null;
}

interface StoreContext extends BaseContext {
  home: string;
  stateRoot: string;
  receiptDir: string;
  receiptPath: string;
  homeDevice: string;
  homeInode: string;
}

interface AuthorityContext extends BaseContext {
  runtimeRoot: string;
  authorityDir: string;
  authorityPath: string;
  runtimeRootDevice: string;
  runtimeRootInode: string;
}

interface SecureDirectory {
  fd: number;
  stat: fs.Stats;
  path: string;
  ancestors: Array<{ path: string; stat: fs.Stats; privateDirectory: boolean }>;
}

class MissingStoreError extends Error {}
class UnsupportedAuthorityError extends Error {}
class UnsafeReceiptError extends Error {}
class MalformedReceiptError extends Error {}

export class LaunchReadinessFenceError extends Error {
  constructor(
    readonly blocksRecovery: boolean,
    readonly priorEpochInvalidated: boolean,
    readonly authorityUnsupported = false,
  ) {
    super(
      blocksRecovery
        ? "Launch readiness evidence cannot be safely invalidated."
        : "Launch readiness evidence storage is unavailable.",
    );
    this.name = "LaunchReadinessFenceError";
  }
}

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

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function isSessionQualification(value: unknown): value is LaunchReadinessSessionQualification {
  if (!isPlainRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "openclawVersion",
      "deviceIdentitySha256",
      "pairingStateSha256",
      "requiredRoles",
      "requiredScopes",
    ])
  ) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    value.kind === "openclaw-pairing" &&
    typeof value.openclawVersion === "string" &&
    value.openclawVersion.length > 0 &&
    value.openclawVersion.length <= 128 &&
    typeof value.deviceIdentitySha256 === "string" &&
    SHA256_RE.test(value.deviceIdentitySha256) &&
    typeof value.pairingStateSha256 === "string" &&
    SHA256_RE.test(value.pairingStateSha256) &&
    isExactStringArray(value.requiredRoles, ["operator"]) &&
    isExactStringArray(value.requiredScopes, [
      "operator.pairing",
      "operator.read",
      "operator.write",
    ])
  );
}

function isIdentity(value: unknown): value is LaunchReadinessIdentity {
  if (!isPlainRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "registry",
      "agent",
      "liveInference",
      "gatewayName",
      "lifecycleGeneration",
      "liveIdentityFingerprint",
      "session",
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
    typeof value.liveInference === "string" &&
    SHA256_RE.test(value.liveInference) &&
    (value.session === null || isSessionQualification(value.session))
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
        "gatewayName",
        "gatewayPort",
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
      typeof value.gatewayName !== "string" ||
      value.gatewayName.length === 0 ||
      value.gatewayName.length > 256 ||
      !Number.isInteger(value.gatewayPort) ||
      (value.gatewayPort as number) < 1 ||
      (value.gatewayPort as number) > 65535 ||
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
        "gatewayName",
        "gatewayPort",
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
      typeof value.gatewayName !== "string" ||
      value.gatewayName.length === 0 ||
      value.gatewayName.length > 256 ||
      !Number.isInteger(value.gatewayPort) ||
      (value.gatewayPort as number) < 1 ||
      (value.gatewayPort as number) > 65535 ||
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

function parseAuthority(raw: string): LaunchReadinessAuthority {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new MalformedReceiptError();
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "phase",
      "epochId",
      "sandboxName",
      "gatewayName",
      "gatewayPort",
      "observedWallMs",
      "observedUptimeMs",
      "bootId",
      "uid",
      "runtimeRootDevice",
      "runtimeRootInode",
      "storeDevice",
      "storeInode",
      "publicationState",
      "preservedLeaseStartedWallMs",
      "preservedLeaseExpiresWallMs",
      "preservedLeaseElapsedMs",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "authority" ||
    (value.phase !== "fence" && value.phase !== "lease") ||
    !isEpoch(value.epochId) ||
    typeof value.sandboxName !== "string" ||
    value.sandboxName.length === 0 ||
    value.sandboxName.length > 256 ||
    typeof value.gatewayName !== "string" ||
    value.gatewayName.length === 0 ||
    value.gatewayName.length > 256 ||
    !Number.isInteger(value.gatewayPort) ||
    (value.gatewayPort as number) < 1 ||
    (value.gatewayPort as number) > 65535 ||
    !isSafeInteger(value.observedWallMs) ||
    !isSafeInteger(value.observedUptimeMs) ||
    typeof value.bootId !== "string" ||
    !BOOT_ID_RE.test(value.bootId) ||
    !isSafeInteger(value.uid) ||
    typeof value.runtimeRootDevice !== "string" ||
    !/^\d+$/.test(value.runtimeRootDevice) ||
    typeof value.runtimeRootInode !== "string" ||
    !/^\d+$/.test(value.runtimeRootInode) ||
    typeof value.storeDevice !== "string" ||
    !/^\d+$/.test(value.storeDevice) ||
    typeof value.storeInode !== "string" ||
    !/^\d+$/.test(value.storeInode) ||
    (value.publicationState !== "ready" && value.publicationState !== "time-unsafe") ||
    !(
      value.preservedLeaseStartedWallMs === null || isSafeInteger(value.preservedLeaseStartedWallMs)
    ) ||
    !(
      value.preservedLeaseExpiresWallMs === null || isSafeInteger(value.preservedLeaseExpiresWallMs)
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
  return value as unknown as LaunchReadinessAuthority;
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

function buildBaseContext(options: LaunchReadinessStoreOptions): BaseContext {
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
  return {
    uid,
    nowWallMs,
    nowUptimeMs,
    bootId,
    randomEpoch: options.randomEpoch ?? (() => randomBytes(32).toString("hex")),
    runtimeAuthorityRoot: options.runtimeAuthorityRoot ?? null,
  };
}

function buildStoreContext(
  base: BaseContext,
  sandboxName: string,
  gatewayPort: number,
  options: LaunchReadinessStoreOptions,
): StoreContext {
  const { uid } = base;
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
  const key = receiptKey(sandboxName);
  return {
    ...base,
    home,
    stateRoot,
    receiptDir,
    receiptPath: path.join(receiptDir, `${key}.json`),
    homeDevice: String(homeStat.dev),
    homeInode: String(homeStat.ino),
  };
}

function pathComponents(target: string): string[] {
  if (!path.isAbsolute(target)) throw new UnsafeReceiptError();
  const parsed = path.parse(target);
  const result = [parsed.root];
  let current = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    result.push(current);
  }
  return result;
}

function validateDerivedRuntimeRoot(
  candidate: string,
  uid: number,
): { path: string; stat: fs.Stats } {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(candidate);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new MissingStoreError();
    }
    throw new UnsafeReceiptError();
  }
  if (!path.isAbsolute(canonical)) throw new UnsafeReceiptError();
  let sawUserOwner = false;
  let finalStat: fs.Stats | null = null;
  for (const component of pathComponents(canonical)) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(component);
    } catch {
      throw new UnsafeReceiptError();
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
      throw new UnsafeReceiptError();
    }
    if (stat.uid === uid) {
      sawUserOwner = true;
    } else if (stat.uid !== 0 || sawUserOwner) {
      throw new UnsafeReceiptError();
    }
    finalStat = stat;
  }
  if (!finalStat || finalStat.uid !== uid || (finalStat.mode & 0o777) !== 0o700) {
    throw new UnsafeReceiptError();
  }
  return { path: canonical, stat: finalStat };
}

function derivedRuntimeRoot(uid: number): string {
  if (process.platform === "linux") return `/run/user/${uid}`;
  throw new UnsupportedAuthorityError();
}

function buildAuthorityContext(base: BaseContext, sandboxName: string): AuthorityContext {
  const overridden = base.runtimeAuthorityRoot?.();
  const candidate = overridden ?? derivedRuntimeRoot(base.uid);
  let runtimeRoot: string;
  let runtimeStat: fs.Stats;
  if (overridden !== null && overridden !== undefined) {
    runtimeRoot = path.resolve(overridden);
    try {
      runtimeStat = fs.lstatSync(runtimeRoot);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new MissingStoreError();
      }
      throw new UnsafeReceiptError();
    }
    if (
      !runtimeStat.isDirectory() ||
      runtimeStat.isSymbolicLink() ||
      runtimeStat.uid !== base.uid ||
      (runtimeStat.mode & 0o777) !== 0o700
    ) {
      throw new UnsafeReceiptError();
    }
  } else {
    const verified = validateDerivedRuntimeRoot(candidate, base.uid);
    runtimeRoot = verified.path;
    runtimeStat = verified.stat;
  }
  const authorityDir = path.join(runtimeRoot, AUTHORITY_PRODUCT_DIRECTORY, AUTHORITY_DIRECTORY);
  return {
    ...base,
    runtimeRoot,
    authorityDir,
    authorityPath: path.join(authorityDir, `${receiptKey(sandboxName)}.json`),
    runtimeRootDevice: String(runtimeStat.dev),
    runtimeRootInode: String(runtimeStat.ino),
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

function ancestorPaths(root: string, target: string): string[] {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new UnsafeReceiptError();
  const paths = [root];
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    paths.push(current);
  }
  return paths;
}

function fsyncSecureDirectoryPath(directoryPath: string, uid: number): void {
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
  let fd: number | null = null;
  try {
    fd = fs.openSync(directoryPath, flags);
    assertSecureDirectoryStat(fs.fstatSync(fd), uid, false);
    fs.fsyncSync(fd);
  } catch {
    throw new UnsafeReceiptError();
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function ensureSecureDirectory(
  context: BaseContext,
  root: string,
  directoryPath: string,
  create: boolean,
  privateFrom = directoryPath,
): SecureDirectory {
  const paths = ancestorPaths(root, directoryPath);
  const ancestors: SecureDirectory["ancestors"] = [];
  for (const [index, candidate] of paths.entries()) {
    const privateDirectory =
      candidate === directoryPath ||
      candidate.startsWith(`${privateFrom}${path.sep}`) ||
      candidate === privateFrom;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
      assertSecureDirectoryStat(stat, context.uid, privateDirectory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT" && !create) {
        throw new MissingStoreError();
      }
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        if (error instanceof UnsafeReceiptError) throw error;
        throw new UnsafeReceiptError();
      }
      if (index === 0) throw new UnsafeReceiptError();
      try {
        fs.mkdirSync(candidate, { mode: 0o700 });
        fs.chmodSync(candidate, 0o700);
        stat = fs.lstatSync(candidate);
        assertSecureDirectoryStat(stat, context.uid, privateDirectory);
        fsyncSecureDirectoryPath(path.dirname(candidate), context.uid);
      } catch {
        throw new UnsafeReceiptError();
      }
    }
    ancestors.push({ path: candidate, stat, privateDirectory });
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(directoryPath, fs.constants.O_RDONLY | noFollow | directoryOnly);
  } catch {
    throw new UnsafeReceiptError();
  }
  try {
    const descriptorStat = fs.fstatSync(fd);
    const pathStat = fs.lstatSync(directoryPath);
    assertSecureDirectoryStat(descriptorStat, context.uid, true);
    assertSecureDirectoryStat(pathStat, context.uid, true);
    if (!sameIdentity(descriptorStat, pathStat)) throw new UnsafeReceiptError();
    for (const ancestor of ancestors) {
      const current = fs.lstatSync(ancestor.path);
      assertSecureDirectoryStat(current, context.uid, ancestor.privateDirectory);
      if (!sameIdentity(ancestor.stat, current)) throw new UnsafeReceiptError();
    }
    return { fd, stat: descriptorStat, path: directoryPath, ancestors };
  } catch (error) {
    fs.closeSync(fd);
    if (error instanceof UnsafeReceiptError) throw error;
    throw new UnsafeReceiptError();
  }
}

function revalidateDirectory(context: BaseContext, directory: SecureDirectory): void {
  for (const ancestor of directory.ancestors) {
    const current = fs.lstatSync(ancestor.path);
    assertSecureDirectoryStat(current, context.uid, ancestor.privateDirectory);
    if (!sameIdentity(ancestor.stat, current)) throw new UnsafeReceiptError();
  }
  const descriptorStat = fs.fstatSync(directory.fd);
  const pathStat = fs.lstatSync(directory.path);
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

function readSecureFileAtPath(
  context: BaseContext,
  directory: SecureDirectory,
  filePath: string,
): string {
  revalidateDirectory(context, directory);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(filePath, flags);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new MissingStoreError();
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
    const pathStat = fs.lstatSync(filePath);
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
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readRecordAtPath(
  context: StoreContext,
  directory: SecureDirectory,
): LaunchReadinessRecord {
  return parseRecord(readSecureFileAtPath(context, directory, context.receiptPath));
}

function readAuthorityAtPath(
  context: AuthorityContext,
  directory: SecureDirectory,
): LaunchReadinessAuthority {
  return parseAuthority(readSecureFileAtPath(context, directory, context.authorityPath));
}

function tempPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
}

function proveWritable(context: BaseContext, directory: SecureDirectory, filePath: string): void {
  revalidateDirectory(context, directory);
  const candidate = tempPath(filePath);
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

function writeSecureJson(
  context: BaseContext,
  directory: SecureDirectory,
  filePath: string,
  value: LaunchReadinessRecord | LaunchReadinessAuthority,
  verify: (raw: string) => void,
): void {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized) > LAUNCH_READINESS_MAX_BYTES) {
    throw new UnsafeReceiptError();
  }
  revalidateDirectory(context, directory);
  const candidate = tempPath(filePath);
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
    fs.renameSync(candidate, filePath);
    fs.fsyncSync(directory.fd);
    verify(readSecureFileAtPath(context, directory, filePath));
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

function writeRecord(
  context: StoreContext,
  directory: SecureDirectory,
  record: LaunchReadinessRecord,
): void {
  writeSecureJson(context, directory, context.receiptPath, record, (raw) => {
    const published = parseRecord(raw);
    if (JSON.stringify(published) !== JSON.stringify(record)) {
      throw new UnsafeReceiptError();
    }
  });
}

function authorityContextMatches(
  authority: LaunchReadinessAuthority,
  context: AuthorityContext,
  directory: SecureDirectory,
): boolean {
  return (
    authority.sandboxName.length > 0 &&
    authority.uid === context.uid &&
    authority.bootId === context.bootId &&
    authority.runtimeRootDevice === context.runtimeRootDevice &&
    authority.runtimeRootInode === context.runtimeRootInode &&
    authority.storeDevice === String(directory.stat.dev) &&
    authority.storeInode === String(directory.stat.ino)
  );
}

function writeAuthority(
  context: AuthorityContext,
  directory: SecureDirectory,
  authority: LaunchReadinessAuthority,
): LaunchReadinessAuthority {
  writeSecureJson(context, directory, context.authorityPath, authority, (raw) => {
    const published = parseAuthority(raw);
    if (
      JSON.stringify(published) !== JSON.stringify(authority) ||
      !authorityContextMatches(published, context, directory)
    ) {
      throw new UnsafeReceiptError();
    }
  });
  return authority;
}

function ensureAuthorityDirectory(context: AuthorityContext, create: boolean): SecureDirectory {
  return ensureSecureDirectory(
    context,
    context.runtimeRoot,
    context.authorityDir,
    create,
    path.join(context.runtimeRoot, AUTHORITY_PRODUCT_DIRECTORY),
  );
}

type AuthorityInspection =
  | { kind: "missing"; context: AuthorityContext | null }
  | { kind: "unsupported"; context: null }
  | { kind: "present"; context: AuthorityContext; authority: LaunchReadinessAuthority }
  | { kind: "unsafe"; context: AuthorityContext | null };

function inspectAuthority(base: BaseContext, sandboxName: string): AuthorityInspection {
  let context: AuthorityContext;
  let directory: SecureDirectory | null = null;
  try {
    context = buildAuthorityContext(base, sandboxName);
  } catch (error) {
    if (error instanceof UnsupportedAuthorityError) {
      return { kind: "unsupported", context: null };
    }
    return error instanceof MissingStoreError
      ? { kind: "missing", context: null }
      : { kind: "unsafe", context: null };
  }
  try {
    directory = ensureAuthorityDirectory(context, false);
    const authority = readAuthorityAtPath(context, directory);
    proveWritable(context, directory, context.authorityPath);
    if (!authorityContextMatches(authority, context, directory)) {
      return { kind: "unsafe", context };
    }
    return { kind: "present", context, authority };
  } catch (error) {
    return error instanceof MissingStoreError
      ? { kind: "missing", context }
      : { kind: "unsafe", context };
  } finally {
    closeDirectory(directory);
  }
}

function rotateAuthority(
  context: AuthorityContext,
  sandboxName: string,
  gatewayName: string,
  gatewayPort: number,
  prior: LaunchReadinessAuthority | null,
  epochId: string,
  publicationDisabled: boolean,
): LaunchReadinessAuthority {
  if (!isEpoch(epochId)) throw new UnsafeReceiptError();
  const directory = ensureAuthorityDirectory(context, true);
  try {
    let publication = publicationDisabled
      ? { timeline: null, state: "time-unsafe" as const }
      : authorityPublicationTimeline(prior, context);
    if (publication.state === "time-unsafe" && publication.timeline === null) {
      const expires = context.nowWallMs + LAUNCH_READINESS_LEASE_MS;
      if (!Number.isSafeInteger(expires)) throw new UnsafeReceiptError();
      publication = {
        state: "time-unsafe",
        timeline: { started: context.nowWallMs, expires, elapsed: 0 },
      };
    }
    const authority: LaunchReadinessAuthority = {
      schemaVersion: 1,
      kind: "authority",
      phase: "fence",
      epochId,
      sandboxName,
      gatewayName,
      gatewayPort,
      observedWallMs: context.nowWallMs,
      observedUptimeMs: context.nowUptimeMs,
      bootId: context.bootId,
      uid: context.uid,
      runtimeRootDevice: context.runtimeRootDevice,
      runtimeRootInode: context.runtimeRootInode,
      storeDevice: String(directory.stat.dev),
      storeInode: String(directory.stat.ino),
      publicationState: publication.state,
      preservedLeaseStartedWallMs: publication.timeline?.started ?? null,
      preservedLeaseExpiresWallMs: publication.timeline?.expires ?? null,
      preservedLeaseElapsedMs: publication.timeline?.elapsed ?? null,
    };
    return writeAuthority(context, directory, authority);
  } finally {
    closeDirectory(directory);
  }
}

function recordContextMatches(
  record: LaunchReadinessRecord,
  context: StoreContext,
  storeStat: fs.Stats,
  gatewayName: string,
  gatewayPort: number,
): boolean {
  return (
    record.uid === context.uid &&
    record.bootId === context.bootId &&
    record.homeDevice === context.homeDevice &&
    record.homeInode === context.homeInode &&
    record.storeDevice === String(storeStat.dev) &&
    record.storeInode === String(storeStat.ino) &&
    record.gatewayName === gatewayName &&
    record.gatewayPort === gatewayPort
  );
}

function validateLeaseTime(
  lease: LaunchReadinessLease,
  context: StoreContext,
  storeStat: fs.Stats,
  gatewayName: string,
  gatewayPort: number,
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
  if (!recordContextMatches(lease, context, storeStat, gatewayName, gatewayPort)) return "identity";
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
  gatewayName: string,
  gatewayPort: number,
  options: LaunchReadinessStoreOptions = {},
): LaunchReadinessLeaseRead {
  let context: StoreContext | null = null;
  let directory: SecureDirectory | null = null;
  let authorityDirectory: SecureDirectory | null = null;
  try {
    const base = buildBaseContext(options);
    context = buildStoreContext(base, sandboxName, gatewayPort, options);
    directory = ensureSecureDirectory(context, context.home, context.receiptDir, false);
    const record = readRecordAtPath(context, directory);
    if (record.kind !== "lease" || record.sandboxName !== sandboxName) return { kind: "missing" };
    if (record.gatewayName !== record.identity.gatewayName) return { kind: "malformed" };
    proveWritable(context, directory, context.receiptPath);
    const time = validateLeaseTime(record, context, directory.stat, gatewayName, gatewayPort);
    if (time === "malformed") return { kind: "malformed" };
    if (time === "expired") return { kind: "expired", lease: record };
    if (time === "identity") return { kind: "identity", lease: record };
    try {
      const authorityContext = buildAuthorityContext(base, sandboxName);
      authorityDirectory = ensureAuthorityDirectory(authorityContext, false);
      const authority = readAuthorityAtPath(authorityContext, authorityDirectory);
      proveWritable(authorityContext, authorityDirectory, authorityContext.authorityPath);
      if (
        authority.phase !== "lease" ||
        authority.sandboxName !== sandboxName ||
        authority.epochId !== record.epochId ||
        authority.gatewayName !== gatewayName ||
        authority.gatewayPort !== gatewayPort ||
        authority.publicationState !== "ready" ||
        authority.observedWallMs !== record.publishedWallMs ||
        authority.observedUptimeMs !== record.publishedUptimeMs ||
        authority.preservedLeaseStartedWallMs !== record.leaseStartedWallMs ||
        authority.preservedLeaseExpiresWallMs !== record.leaseExpiresWallMs ||
        authority.preservedLeaseElapsedMs !== record.elapsedAtPublicationMs ||
        !authorityContextMatches(authority, authorityContext, authorityDirectory)
      ) {
        return { kind: "identity", lease: record };
      }
    } catch (error) {
      if (error instanceof MissingStoreError) return { kind: "identity", lease: record };
      throw new UnsafeReceiptError();
    }
    return { kind: "valid", lease: record };
  } catch (error) {
    if (error instanceof MissingStoreError) return { kind: "missing" };
    if (error instanceof MalformedReceiptError) return { kind: "malformed" };
    return { kind: "unsafe" };
  } finally {
    closeDirectory(authorityDirectory);
    closeDirectory(directory);
  }
}

function recordTimeline(
  record: LaunchReadinessRecord | LaunchReadinessAuthority | null,
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

function authorityPublicationTimeline(
  authority: LaunchReadinessAuthority | null,
  context: BaseContext,
): {
  timeline: { started: number; expires: number; elapsed: number } | null;
  state: "ready" | "time-unsafe";
} {
  const timeline = recordTimeline(authority);
  if (!authority) return { timeline: null, state: "ready" };
  if (authority.publicationState === "time-unsafe") {
    if (!timeline) return { timeline: null, state: "time-unsafe" };
    if (
      authority.bootId !== context.bootId ||
      context.nowWallMs < timeline.started ||
      context.nowWallMs < authority.observedWallMs ||
      context.nowUptimeMs < authority.observedUptimeMs
    ) {
      return { timeline, state: "time-unsafe" };
    }
    const monotonicElapsed = timeline.elapsed + (context.nowUptimeMs - authority.observedUptimeMs);
    const wallElapsed = context.nowWallMs - timeline.started;
    if (!Number.isSafeInteger(monotonicElapsed) || !Number.isSafeInteger(wallElapsed)) {
      return { timeline, state: "time-unsafe" };
    }
    const elapsed = Math.min(LAUNCH_READINESS_LEASE_MS, monotonicElapsed);
    return monotonicElapsed >= LAUNCH_READINESS_LEASE_MS &&
      wallElapsed >= LAUNCH_READINESS_LEASE_MS &&
      context.nowWallMs >= timeline.expires
      ? { timeline: null, state: "ready" }
      : { timeline: { ...timeline, elapsed }, state: "time-unsafe" };
  }
  if (!timeline) return { timeline: null, state: "ready" };
  if (
    authority.bootId !== context.bootId ||
    context.nowWallMs < timeline.started ||
    context.nowWallMs < authority.observedWallMs ||
    context.nowUptimeMs < authority.observedUptimeMs
  ) {
    return { timeline, state: "time-unsafe" };
  }
  const elapsed = Math.max(
    timeline.elapsed + (context.nowUptimeMs - authority.observedUptimeMs),
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

type PersistentInspection = { kind: "missing" } | { kind: "present" } | { kind: "unsafe" };

function inspectPersistentStore(
  base: BaseContext,
  sandboxName: string,
  gatewayPort: number,
  options: LaunchReadinessStoreOptions,
): PersistentInspection {
  let directory: SecureDirectory | null = null;
  try {
    const context = buildStoreContext(base, sandboxName, gatewayPort, options);
    directory = ensureSecureDirectory(context, context.home, context.receiptDir, false);
    try {
      readRecordAtPath(context, directory);
      return { kind: "present" };
    } catch (error) {
      if (error instanceof MissingStoreError) return { kind: "missing" };
      if (error instanceof MalformedReceiptError) return { kind: "present" };
      return { kind: "unsafe" };
    }
  } catch (error) {
    return error instanceof MissingStoreError ? { kind: "missing" } : { kind: "unsafe" };
  } finally {
    closeDirectory(directory);
  }
}

/**
 * Revalidate the sandbox-global runtime epoch immediately before recovery.
 * The caller must hold the sandbox lifecycle lock followed by the owning
 * gateway route lock for this check and the complete mutation window.
 */
export function checkLaunchReadinessMutationAuthority(
  sandboxName: string,
  gatewayName: string,
  gatewayPort: number,
  expectedEpochId: string | null,
  options: LaunchReadinessStoreOptions = {},
): LaunchReadinessMutationAuthorityCheck {
  if (
    !gatewayName ||
    gatewayName.length > 256 ||
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65535 ||
    (expectedEpochId !== null && !isEpoch(expectedEpochId))
  ) {
    return "unsafe";
  }
  try {
    const base = buildBaseContext(options);
    const inspection = inspectAuthority(base, sandboxName);
    if (expectedEpochId === null) {
      if (inspection.kind === "unsupported") return "current";
      const persistent = inspectPersistentStore(base, sandboxName, gatewayPort, options);
      if (inspection.kind === "unsafe" || persistent.kind === "unsafe") return "unsafe";
      return inspection.kind === "missing" && persistent.kind === "missing" ? "current" : "changed";
    }
    if (inspection.kind === "unsupported") return "changed";
    if (inspection.kind === "unsafe") return "unsafe";
    if (inspection.kind === "missing") return "changed";
    const { authority } = inspection;
    return authority.phase === "fence" &&
      authority.epochId === expectedEpochId &&
      authority.sandboxName === sandboxName &&
      authority.gatewayName === gatewayName &&
      authority.gatewayPort === gatewayPort
      ? "current"
      : "changed";
  } catch {
    return "unsafe";
  }
}

/**
 * Replace any prior lease with a durable random publication epoch.
 *
 * The caller must hold the sandbox lifecycle lock followed by the owning
 * gateway route lock. After the caller releases those locks following the
 * initial rotation, it must reacquire both through the mutation gate,
 * revalidate this epoch, and hold them for the complete preflight and final
 * publication.
 */
export function fenceLaunchReadinessLease(
  sandboxName: string,
  gatewayName: string,
  gatewayPort: number,
  options: LaunchReadinessStoreOptions = {},
): LaunchReadinessFence {
  if (
    !gatewayName ||
    gatewayName.length > 256 ||
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65535
  ) {
    throw new LaunchReadinessFenceError(true, false);
  }
  const base = buildBaseContext(options);
  const authorityInspection = inspectAuthority(base, sandboxName);
  if (authorityInspection.kind === "unsupported") {
    throw new LaunchReadinessFenceError(false, false, true);
  }
  const persistentInspection = inspectPersistentStore(base, sandboxName, gatewayPort, options);
  const epochId = base.randomEpoch();
  if (!isEpoch(epochId)) throw new LaunchReadinessFenceError(true, false);

  let authorityContext: AuthorityContext;
  try {
    authorityContext = authorityInspection.context ?? buildAuthorityContext(base, sandboxName);
    rotateAuthority(
      authorityContext,
      sandboxName,
      gatewayName,
      gatewayPort,
      authorityInspection.kind === "present" ? authorityInspection.authority : null,
      epochId,
      authorityInspection.kind === "unsafe",
    );
  } catch {
    const blocksRecovery =
      authorityInspection.kind !== "missing" || persistentInspection.kind !== "missing";
    throw new LaunchReadinessFenceError(blocksRecovery, false);
  }

  let directory: SecureDirectory | null = null;
  try {
    const context = buildStoreContext(base, sandboxName, gatewayPort, options);
    directory = ensureSecureDirectory(context, context.home, context.receiptDir, true);
    let existing: LaunchReadinessRecord | null = null;
    try {
      existing = readRecordAtPath(context, directory);
      if (existing.sandboxName !== sandboxName) existing = null;
    } catch (error) {
      if (!(error instanceof MissingStoreError) && !(error instanceof MalformedReceiptError)) {
        throw error;
      }
    }
    const currentAuthority = inspectAuthority(base, sandboxName);
    if (
      currentAuthority.kind !== "present" ||
      currentAuthority.authority.epochId !== epochId ||
      currentAuthority.authority.gatewayName !== gatewayName ||
      currentAuthority.authority.gatewayPort !== gatewayPort
    ) {
      throw new UnsafeReceiptError();
    }
    const authorityTimeline = authorityPublicationTimeline(currentAuthority.authority, base);
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
      gatewayName,
      gatewayPort,
      publicationState: authorityTimeline.state,
      preservedLeaseStartedWallMs: authorityTimeline.timeline?.started ?? null,
      preservedLeaseExpiresWallMs: authorityTimeline.timeline?.expires ?? null,
      preservedLeaseElapsedMs: authorityTimeline.timeline?.elapsed ?? null,
    };
    writeRecord(context, directory, fence);
    return fence;
  } catch {
    throw new LaunchReadinessFenceError(false, true);
  } finally {
    closeDirectory(directory);
  }
}

/** Publish only when the exact fence epoch is still authoritative. */
export function publishLaunchReadinessLease(
  sandboxName: string,
  gatewayName: string,
  gatewayPort: number,
  expectedEpochId: string,
  identity: LaunchReadinessIdentity,
  options: LaunchReadinessStoreOptions = {},
  assertBeforeCommit?: () => void,
): LaunchReadinessLease {
  let directory: SecureDirectory | null = null;
  let authorityDirectory: SecureDirectory | null = null;
  try {
    const base = buildBaseContext(options);
    const context = buildStoreContext(base, sandboxName, gatewayPort, options);
    directory = ensureSecureDirectory(context, context.home, context.receiptDir, false);
    const record = readRecordAtPath(context, directory);
    if (
      record.kind !== "fence" ||
      record.sandboxName !== sandboxName ||
      record.epochId !== expectedEpochId ||
      !recordContextMatches(record, context, directory.stat, gatewayName, gatewayPort)
    ) {
      throw new Error("Launch readiness publication authority changed.");
    }
    if (record.publicationState !== "ready") {
      throw new Error(
        "Launch readiness publication is disabled while authority or clock history is unsafe.",
      );
    }
    const authorityContext = buildAuthorityContext(base, sandboxName);
    authorityDirectory = ensureAuthorityDirectory(authorityContext, false);
    const authority = readAuthorityAtPath(authorityContext, authorityDirectory);
    if (
      authority.phase !== "fence" ||
      authority.epochId !== expectedEpochId ||
      authority.sandboxName !== sandboxName ||
      authority.gatewayName !== gatewayName ||
      authority.gatewayPort !== gatewayPort ||
      !authorityContextMatches(authority, authorityContext, authorityDirectory)
    ) {
      throw new Error("Launch readiness publication authority changed.");
    }
    proveWritable(authorityContext, authorityDirectory, authorityContext.authorityPath);
    const publication = authorityPublicationTimeline(authority, base);
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
      gatewayName,
      gatewayPort,
      identity,
    };
    if (validateLeaseTime(lease, context, directory.stat, gatewayName, gatewayPort) !== "valid") {
      throw new Error("Launch readiness lease time envelope is no longer valid.");
    }
    const leaseAuthority: LaunchReadinessAuthority = {
      ...authority,
      phase: "lease",
      observedWallMs: context.nowWallMs,
      observedUptimeMs: context.nowUptimeMs,
      publicationState: "ready",
      preservedLeaseStartedWallMs: leaseStartedWallMs,
      preservedLeaseExpiresWallMs: leaseExpiresWallMs,
      preservedLeaseElapsedMs: elapsedAtPublicationMs,
    };
    assertBeforeCommit?.();
    writeAuthority(authorityContext, authorityDirectory, leaseAuthority);
    writeRecord(context, directory, lease);
    const finalAuthority = readAuthorityAtPath(authorityContext, authorityDirectory);
    if (
      finalAuthority.epochId !== expectedEpochId ||
      finalAuthority.phase !== "lease" ||
      finalAuthority.observedWallMs !== lease.publishedWallMs ||
      finalAuthority.observedUptimeMs !== lease.publishedUptimeMs ||
      finalAuthority.gatewayName !== gatewayName ||
      finalAuthority.gatewayPort !== gatewayPort ||
      finalAuthority.preservedLeaseStartedWallMs !== lease.leaseStartedWallMs ||
      finalAuthority.preservedLeaseExpiresWallMs !== lease.leaseExpiresWallMs ||
      finalAuthority.preservedLeaseElapsedMs !== lease.elapsedAtPublicationMs ||
      !authorityContextMatches(finalAuthority, authorityContext, authorityDirectory)
    ) {
      throw new Error("Launch readiness publication authority changed.");
    }
    return lease;
  } finally {
    closeDirectory(authorityDirectory);
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

export function launchReadinessAuthorityPath(sandboxName: string, runtimeRoot: string): string {
  return path.join(
    path.resolve(runtimeRoot),
    AUTHORITY_PRODUCT_DIRECTORY,
    AUTHORITY_DIRECTORY,
    `${receiptKey(sandboxName)}.json`,
  );
}
