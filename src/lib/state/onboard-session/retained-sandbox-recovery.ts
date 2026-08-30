// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import {
  parseNemoClawPolicyCreationReceipt,
  type NemoClawPolicyCreationReceipt,
} from "../../policy/merge";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../sandbox-name-contract";

export { parseNemoClawPolicyCreationReceipt } from "../../policy/merge";

const SCHEMA_VERSION = 1;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_EVIDENCE_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/u;

export function retainedSandboxRecoveryFile(sessionDirectory: string): string {
  return path.join(sessionDirectory, "retained-sandbox-recovery.json");
}

export type RetainedSandboxRecoveryReason =
  | "cancelled_after_sandbox_creation"
  | "retained_after_sandbox_creation_failure";

export interface RetainedSandboxVerifiedEffectivePolicyIdentity {
  readonly hash: string;
  readonly activeVersion: number;
}

export interface RetainedSandboxRecoveryRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly recordId: string;
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string | null;
  readonly verifiedEffectivePolicyIdentity: RetainedSandboxVerifiedEffectivePolicyIdentity | null;
  readonly createAttemptNonce: string;
  readonly policyCreationReceipt: NemoClawPolicyCreationReceipt | null;
  readonly reason: RetainedSandboxRecoveryReason;
  readonly recordedAt: string;
}

interface RetainedSandboxRecoveryState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly unresolved: readonly RetainedSandboxRecoveryRecord[];
}

interface RetainedSandboxStateDirectory {
  readonly ancestors: readonly { readonly path: string; readonly stat: fs.Stats }[];
  readonly descriptor: number;
  readonly path: string;
  readonly stat: fs.Stats;
}

export interface RecordRetainedSandboxRecoveryInput {
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string | null;
  readonly verifiedEffectivePolicyIdentity: RetainedSandboxVerifiedEffectivePolicyIdentity | null;
  readonly createAttemptNonce: string;
  readonly policyCreationReceipt: NemoClawPolicyCreationReceipt | null;
  readonly reason: RetainedSandboxRecoveryReason;
  readonly recordedAt?: string;
}

const emptyState = (): RetainedSandboxRecoveryState => ({
  schemaVersion: SCHEMA_VERSION,
  unresolved: [],
});

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stateDirectoryAncestors(directory: string): string[] {
  const home = path.resolve(process.env.HOME ?? path.dirname(directory));
  const resolved = path.resolve(directory);
  const relative = path.relative(home, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return [resolved];
  }
  const ancestors: string[] = [];
  let current = home;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    ancestors.push(current);
  }
  return ancestors;
}

function assertStateDirectoryComponent(candidate: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Retained sandbox recovery state directory cannot be a symbolic link: ${candidate}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Retained sandbox recovery state directory is not a directory: ${candidate}`);
  }
}

function openStateDirectory(
  filePath: string,
  create: boolean,
): RetainedSandboxStateDirectory | null {
  const directory = path.dirname(filePath);
  const ancestorPaths = stateDirectoryAncestors(directory);
  for (const candidate of ancestorPaths) {
    try {
      assertStateDirectoryComponent(candidate, fs.lstatSync(candidate));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const ancestors: Array<{ path: string; stat: fs.Stats }> = [];
  try {
    for (const candidate of ancestorPaths) {
      const stat = fs.lstatSync(candidate);
      assertStateDirectoryComponent(candidate, stat);
      ancestors.push({ path: candidate, stat });
    }
  } catch (error) {
    if (
      !create &&
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }

  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0);
  const descriptor = fs.openSync(directory, flags);
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(directory);
    assertStateDirectoryComponent(directory, descriptorStat);
    assertStateDirectoryComponent(directory, pathStat);
    if (!sameFileIdentity(descriptorStat, pathStat)) {
      throw new Error("Retained sandbox recovery state directory changed during validation.");
    }
    return { ancestors, descriptor, path: directory, stat: descriptorStat };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function revalidateStateDirectory(directory: RetainedSandboxStateDirectory): void {
  for (const ancestor of directory.ancestors) {
    const current = fs.lstatSync(ancestor.path);
    assertStateDirectoryComponent(ancestor.path, current);
    if (!sameFileIdentity(ancestor.stat, current)) {
      throw new Error("Retained sandbox recovery state directory changed during validation.");
    }
  }
  const descriptorStat = fs.fstatSync(directory.descriptor);
  const pathStat = fs.lstatSync(directory.path);
  assertStateDirectoryComponent(directory.path, descriptorStat);
  assertStateDirectoryComponent(directory.path, pathStat);
  if (
    !sameFileIdentity(directory.stat, descriptorStat) ||
    !sameFileIdentity(directory.stat, pathStat)
  ) {
    throw new Error("Retained sandbox recovery state directory changed during validation.");
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStateFile(filePath: string): unknown {
  const directory = openStateDirectory(filePath, false);
  if (directory === null) return emptyState();
  try {
    revalidateStateDirectory(directory);
    const file = openRegularFileNoFollow(filePath);
    try {
      const value = JSON.parse(file.readUtf8());
      revalidateStateDirectory(directory);
      return value;
    } finally {
      file.close();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return emptyState();
    }
    if (
      error instanceof Error &&
      "code" in error &&
      ((error as NodeJS.ErrnoException).code === "ELOOP" ||
        (error as NodeJS.ErrnoException).code === "EMLINK")
    ) {
      throw new Error("Retained sandbox recovery state cannot be a symbolic link.");
    }
    throw error;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

function assertTemporaryStateFile(descriptor: number, temporary: string): fs.Stats {
  const descriptorStat = fs.fstatSync(descriptor);
  const pathStat = fs.lstatSync(temporary);
  if (
    !descriptorStat.isFile() ||
    descriptorStat.nlink !== 1 ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.nlink !== 1 ||
    !sameFileIdentity(descriptorStat, pathStat)
  ) {
    throw new Error("Retained sandbox recovery temporary state changed during validation.");
  }
  return descriptorStat;
}

function writeStateFile(filePath: string, state: RetainedSandboxRecoveryState): void {
  const directory = openStateDirectory(filePath, true)!;
  try {
    revalidateStateDirectory(directory);
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("Retained sandbox recovery state cannot be a symbolic link.");
    }
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
    ) {
      fs.closeSync(directory.descriptor);
      throw error;
    }
  }
  const temporary = path.join(
    directory.path,
    `.retained-sandbox-recovery.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let temporaryStat: fs.Stats | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    revalidateStateDirectory(directory);
    temporaryStat = assertTemporaryStateFile(descriptor, temporary);
    fs.writeFileSync(descriptor, JSON.stringify(state, null, 2));
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    temporaryStat = assertTemporaryStateFile(descriptor, temporary);
    fs.closeSync(descriptor);
    descriptor = null;
    revalidateStateDirectory(directory);
    fs.renameSync(temporary, filePath);
    revalidateStateDirectory(directory);
    fs.fsyncSync(directory.descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      revalidateStateDirectory(directory);
      const pathStat = fs.lstatSync(temporary);
      if (
        temporaryStat !== null &&
        pathStat.isFile() &&
        pathStat.nlink === 1 &&
        sameFileIdentity(temporaryStat, pathStat)
      ) {
        fs.unlinkSync(temporary);
      }
    } catch {
      // Preserve the original result. Ambiguous paths are left untouched.
    }
    fs.closeSync(directory.descriptor);
  }
}

function validSandboxName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= NAME_MAX_LENGTH && NAME_VALID_PATTERN.test(value)
  );
}

function validSafeEvidence(value: unknown): value is string {
  return typeof value === "string" && SAFE_EVIDENCE_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validGatewayPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
}

function parseVerifiedEffectivePolicyIdentity(
  value: unknown,
): RetainedSandboxVerifiedEffectivePolicyIdentity | null | undefined {
  if (value === null || value === undefined) return null;
  if (
    !isObjectRecord(value) ||
    !validSafeEvidence(value.hash) ||
    !Number.isSafeInteger(value.activeVersion) ||
    Number(value.activeVersion) < 1
  ) {
    return undefined;
  }
  return { hash: value.hash, activeVersion: Number(value.activeVersion) };
}

function parseRecord(value: unknown): RetainedSandboxRecoveryRecord | null {
  if (!isObjectRecord(value)) return null;
  const fingerprint = value.sandboxIdentityFingerprint;
  const verifiedEffectivePolicyIdentity = parseVerifiedEffectivePolicyIdentity(
    value.verifiedEffectivePolicyIdentity,
  );
  const reason = value.reason;
  let policyCreationReceipt: NemoClawPolicyCreationReceipt | null = null;
  if (value.policyCreationReceipt !== null) {
    try {
      policyCreationReceipt = parseNemoClawPolicyCreationReceipt(value.policyCreationReceipt);
    } catch {
      return null;
    }
  }
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.recordId !== "string" ||
    !FINGERPRINT_PATTERN.test(value.recordId) ||
    !validSandboxName(value.sandboxName) ||
    (fingerprint !== null &&
      (typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint))) ||
    !validSafeEvidence(value.gatewayName) ||
    !validGatewayPort(value.gatewayPort) ||
    (value.lifecycleGeneration !== null && !validSafeEvidence(value.lifecycleGeneration)) ||
    verifiedEffectivePolicyIdentity === undefined ||
    typeof value.createAttemptNonce !== "string" ||
    !/^[0-9a-f]{62}$/u.test(value.createAttemptNonce) ||
    (policyCreationReceipt !== null &&
      (policyCreationReceipt.gatewayName !== value.gatewayName ||
        policyCreationReceipt.gatewayPort !== value.gatewayPort ||
        policyCreationReceipt.sandboxName !== value.sandboxName ||
        policyCreationReceipt.lifecycleGeneration !== value.lifecycleGeneration ||
        policyCreationReceipt.sandboxIdentityFingerprint !== fingerprint ||
        policyCreationReceipt.policyHash !== verifiedEffectivePolicyIdentity?.hash ||
        policyCreationReceipt.policyVersion !== verifiedEffectivePolicyIdentity?.activeVersion)) ||
    !["cancelled_after_sandbox_creation", "retained_after_sandbox_creation_failure"].includes(
      String(reason),
    ) ||
    !validTimestamp(value.recordedAt)
  ) {
    return null;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    recordId: value.recordId,
    sandboxName: value.sandboxName,
    sandboxIdentityFingerprint: fingerprint,
    gatewayName: value.gatewayName,
    gatewayPort: value.gatewayPort,
    lifecycleGeneration: value.lifecycleGeneration,
    verifiedEffectivePolicyIdentity,
    createAttemptNonce: value.createAttemptNonce,
    policyCreationReceipt,
    reason: reason as RetainedSandboxRecoveryReason,
    recordedAt: value.recordedAt,
  };
}

function loadState(filePath: string): RetainedSandboxRecoveryState {
  const value = readStateFile(filePath);
  if (!isObjectRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Retained sandbox recovery state has an unsupported schema.");
  }
  const unresolved = Array.isArray(value.unresolved) ? value.unresolved.map(parseRecord) : null;
  if (!unresolved || unresolved.includes(null)) {
    throw new Error("Retained sandbox recovery state is invalid; onboarding remains blocked.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    unresolved: unresolved as RetainedSandboxRecoveryRecord[],
  };
}

function recoveryRecordId(input: RecordRetainedSandboxRecoveryInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.gatewayName,
        input.gatewayPort,
        input.sandboxName,
        input.sandboxIdentityFingerprint,
        input.lifecycleGeneration,
        input.verifiedEffectivePolicyIdentity,
        input.createAttemptNonce,
        input.policyCreationReceipt,
      ]),
    )
    .digest("hex");
}

function assertRecordInput(input: RecordRetainedSandboxRecoveryInput): void {
  if (
    !validSandboxName(input.sandboxName) ||
    (input.sandboxIdentityFingerprint !== null &&
      !FINGERPRINT_PATTERN.test(input.sandboxIdentityFingerprint)) ||
    !validSafeEvidence(input.gatewayName) ||
    !validGatewayPort(input.gatewayPort) ||
    (input.lifecycleGeneration !== null && !validSafeEvidence(input.lifecycleGeneration)) ||
    parseVerifiedEffectivePolicyIdentity(input.verifiedEffectivePolicyIdentity) === undefined ||
    !/^[0-9a-f]{62}$/u.test(input.createAttemptNonce)
  ) {
    throw new Error("Cannot persist invalid retained sandbox recovery evidence.");
  }
  if (input.policyCreationReceipt !== null) {
    let receipt: NemoClawPolicyCreationReceipt;
    try {
      receipt = parseNemoClawPolicyCreationReceipt(input.policyCreationReceipt);
    } catch {
      throw new Error("Cannot persist invalid retained sandbox recovery evidence.");
    }
    if (
      receipt.gatewayName !== input.gatewayName ||
      receipt.gatewayPort !== input.gatewayPort ||
      receipt.sandboxName !== input.sandboxName ||
      receipt.lifecycleGeneration !== input.lifecycleGeneration ||
      receipt.sandboxIdentityFingerprint !== input.sandboxIdentityFingerprint ||
      receipt.policyHash !== input.verifiedEffectivePolicyIdentity?.hash ||
      receipt.policyVersion !== input.verifiedEffectivePolicyIdentity?.activeVersion
    ) {
      throw new Error("Cannot persist mismatched retained sandbox recovery evidence.");
    }
  }
}

export function listRetainedSandboxRecoveryRecords(
  filePath: string,
): readonly RetainedSandboxRecoveryRecord[] {
  return loadState(filePath).unresolved;
}

export function recordRetainedSandboxRecovery(
  filePath: string,
  input: RecordRetainedSandboxRecoveryInput,
): RetainedSandboxRecoveryRecord {
  assertRecordInput(input);
  const record: RetainedSandboxRecoveryRecord = {
    schemaVersion: SCHEMA_VERSION,
    recordId: recoveryRecordId(input),
    sandboxName: input.sandboxName,
    sandboxIdentityFingerprint: input.sandboxIdentityFingerprint,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    lifecycleGeneration: input.lifecycleGeneration,
    verifiedEffectivePolicyIdentity: input.verifiedEffectivePolicyIdentity
      ? { ...input.verifiedEffectivePolicyIdentity }
      : null,
    createAttemptNonce: input.createAttemptNonce,
    policyCreationReceipt: input.policyCreationReceipt
      ? parseNemoClawPolicyCreationReceipt(input.policyCreationReceipt)
      : null,
    reason: input.reason,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
  if (!validTimestamp(record.recordedAt)) {
    throw new Error("Cannot persist retained sandbox recovery with an invalid timestamp.");
  }
  const current = loadState(filePath);
  const next: RetainedSandboxRecoveryState = {
    ...current,
    unresolved: [
      ...current.unresolved.filter((candidate) => candidate.recordId !== record.recordId),
      record,
    ],
  };
  writeStateFile(filePath, next);
  const reread = loadState(filePath).unresolved.find(
    (candidate) => candidate.recordId === record.recordId,
  );
  if (!reread || JSON.stringify(reread) !== JSON.stringify(record)) {
    throw new Error("Retained sandbox recovery record did not survive durable readback.");
  }
  return reread;
}

function retainedSandboxRecoveryAuthorityMatchesState(
  state: RetainedSandboxRecoveryState,
  expected: RetainedSandboxRecoveryRecord,
): boolean {
  const recorded = state.unresolved.find(
    (candidate) => candidate.recordId === expected.recordId,
  );
  if (!recorded) return false;
  if (!isDeepStrictEqual(recorded, expected)) {
    throw new Error("Retained sandbox recovery authority changed before cleanup completed.");
  }
  return true;
}

/** Confirm that the exact cleanup authority is still present and unchanged. */
export function retainedSandboxRecoveryAuthorityIsCurrent(
  filePath: string,
  expected: RetainedSandboxRecoveryRecord,
): boolean {
  return retainedSandboxRecoveryAuthorityMatchesState(loadState(filePath), expected);
}

/** Retire only the unchanged record whose external resources were verified absent. */
export function resolveRetainedSandboxRecovery(
  filePath: string,
  expected: RetainedSandboxRecoveryRecord,
): boolean {
  const current = loadState(filePath);
  if (!retainedSandboxRecoveryAuthorityMatchesState(current, expected)) return false;
  writeStateFile(filePath, {
    ...current,
    unresolved: current.unresolved.filter((candidate) => candidate.recordId !== expected.recordId),
  });
  if (loadState(filePath).unresolved.some((candidate) => candidate.recordId === expected.recordId)) {
    throw new Error("Retained sandbox recovery record remained after verified cleanup.");
  }
  return true;
}
