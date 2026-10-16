// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { publishExportFile } from "../../adapters/fs/config-export-file";
import type { SandboxEntry } from "../registry/types";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../sandbox-name-contract";
import type { JsonObject } from "../../core/json-types";
import { inspectCheckpoint } from "../onboard-checkpoint";

const SCHEMA_VERSION = 1;
const CREATE_AUTHORITY_SCHEMA_VERSION = 2;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const CREATE_ATTEMPT_NONCE_PATTERN = /^[0-9a-f]{62}$/u;
const SAFE_EVIDENCE_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/u;

export function retainedSandboxRecoveryFile(sessionDirectory: string): string {
  return path.join(sessionDirectory, "retained-sandbox-recovery.json");
}

export function retainedRebuildSessionFileName(
  sandboxName: string,
): `.onboard-rebuild-${string}.json` {
  if (sandboxName.length > NAME_MAX_LENGTH || !NAME_VALID_PATTERN.test(sandboxName)) {
    throw new Error("Cannot select rebuild recovery for an invalid sandbox name.");
  }
  return `.onboard-rebuild-${sandboxName}.json`;
}

/** Read the same protected transaction authority for recovery and state migration. */
export function readRetainedRebuildSession(
  stateDirectory: string,
  sandboxName: string,
  expectedGatewayPort?: number,
): JsonObject | null {
  const missing = Symbol("missing retained rebuild session");
  const value = readStateFile(
    path.join(stateDirectory, retainedRebuildSessionFileName(sandboxName)),
    missing,
    true,
  );
  if (value === missing) return null;
  const checkpoint = inspectCheckpoint(isObjectRecord(value) ? value.checkpoint : undefined);
  if (
    !isObjectRecord(value) ||
    value.version !== 1 ||
    checkpoint.status !== "loaded" ||
    checkpoint.checkpoint.sandboxRecreate?.sandboxName !== sandboxName ||
    value.sessionId !== checkpoint.checkpoint.sessionId ||
    !isObjectRecord(value.machine) ||
    value.machine.state !== checkpoint.checkpoint.machineState ||
    (expectedGatewayPort !== undefined &&
      checkpoint.checkpoint.sandboxRecreate.gatewayPort !== expectedGatewayPort)
  ) {
    throw new Error(
      `Retained rebuild recovery does not identify sandbox '${sandboxName}'` +
        (expectedGatewayPort === undefined ? "." : ` on gateway port ${expectedGatewayPort}.`),
    );
  }
  return value as JsonObject;
}

export type RetainedSandboxRecoveryReason =
  | "cancelled_after_sandbox_creation"
  | "retained_after_sandbox_creation_failure";

export interface RetainedSandboxResourceEvidence {
  readonly sharedInferenceProviders: readonly string[];
  readonly sandboxScopedProviders: readonly string[];
  readonly credentialEnvironmentVariables: readonly string[];
}

/** Authority observed before one native Docker create request, independent of session lifetime. */
export interface RetainedSandboxCreateAuthority {
  readonly schemaVersion: 1;
  readonly runtime: "native-linux-default-docker";
  readonly reservationSessionId: string;
  readonly gatewayStateDir: string;
  readonly daemonId: string;
}

export function parseRetainedSandboxCreateAuthority(
  value: unknown,
): RetainedSandboxCreateAuthority | null {
  if (
    !isObjectRecord(value) ||
    value.schemaVersion !== 1 ||
    value.runtime !== "native-linux-default-docker" ||
    !validSafeEvidence(value.reservationSessionId) ||
    typeof value.gatewayStateDir !== "string" ||
    !path.isAbsolute(value.gatewayStateDir) ||
    value.gatewayStateDir.length > 4096 ||
    /[\x00-\x1f\x7f]/u.test(value.gatewayStateDir) ||
    typeof value.daemonId !== "string" ||
    value.daemonId.length === 0 ||
    value.daemonId.length > 256 ||
    /[\s\x00-\x1f\x7f]/u.test(value.daemonId)
  )
    return null;
  return {
    schemaVersion: 1,
    runtime: "native-linux-default-docker",
    reservationSessionId: value.reservationSessionId,
    gatewayStateDir: value.gatewayStateDir,
    daemonId: value.daemonId,
  };
}

export interface RetainedSandboxRecoveryRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION | typeof CREATE_AUTHORITY_SCHEMA_VERSION;
  readonly recordId: string;
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly identityWasUnavailable: boolean;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string | null;
  readonly createAttemptNonce: string;
  readonly createAuthority?: RetainedSandboxCreateAuthority;
  readonly resources: RetainedSandboxResourceEvidence;
  readonly reason: RetainedSandboxRecoveryReason;
  readonly recordedAt: string;
}

interface RetainedSandboxRecoveryState {
  readonly schemaVersion: typeof SCHEMA_VERSION | typeof CREATE_AUTHORITY_SCHEMA_VERSION;
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
  readonly createAttemptNonce: string;
  readonly createAuthority?: RetainedSandboxCreateAuthority;
  readonly resources: RetainedSandboxResourceEvidence;
  readonly reason: RetainedSandboxRecoveryReason;
  readonly recordedAt?: string;
}

export function retainedSandboxRecoveryDocument(
  records: readonly RetainedSandboxRecoveryRecord[],
): RetainedSandboxRecoveryState {
  return {
    schemaVersion: records.some((record) => record.createAuthority !== undefined)
      ? CREATE_AUTHORITY_SCHEMA_VERSION
      : SCHEMA_VERSION,
    unresolved: records,
  };
}

const emptyState = (): RetainedSandboxRecoveryState => retainedSandboxRecoveryDocument([]);

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

function assertPrivateRecoveryFile(stat: fs.Stats): void {
  if (
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("Retained rebuild recovery must be a private file owned by the current user.");
  }
}

function readStateFile(
  filePath: string,
  missingValue: unknown = emptyState(),
  requirePrivate = false,
): unknown {
  const directory = openStateDirectory(filePath, false);
  if (directory === null) return missingValue;
  try {
    revalidateStateDirectory(directory);
    const file = openRegularFileNoFollow(filePath);
    try {
      if (requirePrivate) assertPrivateRecoveryFile(file.stat());
      const text = requirePrivate
        ? file.readBytes(16 * 1024 * 1024).toString("utf8")
        : file.readUtf8();
      if (requirePrivate) assertPrivateRecoveryFile(file.stat());
      const value = JSON.parse(text);
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
      return missingValue;
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
    fs.writeFileSync(
      descriptor,
      JSON.stringify(retainedSandboxRecoveryDocument(state.unresolved), null, 2),
    );
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

export function validSafeEvidence(value: unknown): value is string {
  return typeof value === "string" && SAFE_EVIDENCE_PATTERN.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validGatewayPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65535;
}

function parseEvidence(value: unknown): RetainedSandboxResourceEvidence | null {
  if (!isObjectRecord(value)) return null;
  const parse = (candidate: unknown): string[] | null =>
    Array.isArray(candidate) && candidate.every(validSafeEvidence)
      ? [...new Set(candidate)].sort()
      : null;
  const sharedInferenceProviders = parse(value.sharedInferenceProviders);
  const sandboxScopedProviders = parse(value.sandboxScopedProviders);
  const credentialEnvironmentVariables = parse(value.credentialEnvironmentVariables);
  return sharedInferenceProviders && sandboxScopedProviders && credentialEnvironmentVariables
    ? { sharedInferenceProviders, sandboxScopedProviders, credentialEnvironmentVariables }
    : null;
}

function parseRecord(value: unknown): RetainedSandboxRecoveryRecord | null {
  if (!isObjectRecord(value)) return null;
  const resources = parseEvidence(value.resources);
  const fingerprint = value.sandboxIdentityFingerprint;
  const reason = value.reason;
  const createAuthority = parseRetainedSandboxCreateAuthority(value.createAuthority);
  if (
    value.schemaVersion !==
      (value.createAuthority === undefined ? SCHEMA_VERSION : CREATE_AUTHORITY_SCHEMA_VERSION) ||
    typeof value.recordId !== "string" ||
    !FINGERPRINT_PATTERN.test(value.recordId) ||
    !validSandboxName(value.sandboxName) ||
    (fingerprint !== null &&
      (typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint))) ||
    value.identityWasUnavailable !== (fingerprint === null) ||
    !validSafeEvidence(value.gatewayName) ||
    !validGatewayPort(value.gatewayPort) ||
    (value.lifecycleGeneration !== null && !validSafeEvidence(value.lifecycleGeneration)) ||
    typeof value.createAttemptNonce !== "string" ||
    !CREATE_ATTEMPT_NONCE_PATTERN.test(value.createAttemptNonce) ||
    !resources ||
    (value.createAuthority !== undefined && !createAuthority) ||
    !["cancelled_after_sandbox_creation", "retained_after_sandbox_creation_failure"].includes(
      String(reason),
    ) ||
    !validTimestamp(value.recordedAt)
  ) {
    return null;
  }
  return {
    schemaVersion: createAuthority ? CREATE_AUTHORITY_SCHEMA_VERSION : SCHEMA_VERSION,
    recordId: value.recordId,
    sandboxName: value.sandboxName,
    sandboxIdentityFingerprint: fingerprint,
    identityWasUnavailable: fingerprint === null,
    gatewayName: value.gatewayName,
    gatewayPort: value.gatewayPort,
    lifecycleGeneration: value.lifecycleGeneration,
    createAttemptNonce: value.createAttemptNonce,
    resources,
    ...(createAuthority ? { createAuthority } : {}),
    reason: reason as RetainedSandboxRecoveryReason,
    recordedAt: value.recordedAt,
  };
}

function loadState(filePath: string): RetainedSandboxRecoveryState {
  let value = readStateFile(filePath);
  if (
    isObjectRecord(value) &&
    Array.isArray(value.unresolved) &&
    value.unresolved.some(
      (record) => isObjectRecord(record) && record.createAuthority !== undefined,
    )
  ) {
    value = readStateFile(filePath, emptyState(), true);
  }
  if (
    !isObjectRecord(value) ||
    ![SCHEMA_VERSION, CREATE_AUTHORITY_SCHEMA_VERSION].includes(Number(value.schemaVersion)) ||
    typeof value.schemaVersion !== "number"
  ) {
    throw new Error("Retained sandbox recovery state has an unsupported schema.");
  }
  const unresolved = Array.isArray(value.unresolved) ? value.unresolved.map(parseRecord) : null;
  if (
    !unresolved ||
    unresolved.includes(null) ||
    (value.schemaVersion === SCHEMA_VERSION && unresolved.some((record) => record?.createAuthority))
  ) {
    throw new Error("Retained sandbox recovery state is invalid; onboarding remains blocked.");
  }
  return retainedSandboxRecoveryDocument(unresolved as RetainedSandboxRecoveryRecord[]);
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
        input.createAttemptNonce,
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
    !CREATE_ATTEMPT_NONCE_PATTERN.test(input.createAttemptNonce) ||
    !parseEvidence(input.resources) ||
    (input.createAuthority !== undefined &&
      !parseRetainedSandboxCreateAuthority(input.createAuthority))
  ) {
    throw new Error("Cannot persist invalid retained sandbox recovery evidence.");
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
    schemaVersion: input.createAuthority ? CREATE_AUTHORITY_SCHEMA_VERSION : SCHEMA_VERSION,
    recordId: recoveryRecordId(input),
    sandboxName: input.sandboxName,
    sandboxIdentityFingerprint: input.sandboxIdentityFingerprint,
    identityWasUnavailable: input.sandboxIdentityFingerprint === null,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    lifecycleGeneration: input.lifecycleGeneration,
    createAttemptNonce: input.createAttemptNonce,
    resources: parseEvidence(input.resources)!,
    ...(input.createAuthority
      ? { createAuthority: parseRetainedSandboxCreateAuthority(input.createAuthority)! }
      : {}),
    reason: input.reason,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
  if (!validTimestamp(record.recordedAt)) {
    throw new Error("Cannot persist retained sandbox recovery with an invalid timestamp.");
  }
  const current = loadState(filePath);
  const existing = current.unresolved.find((candidate) => candidate.recordId === record.recordId);
  if (existing && !isDeepStrictEqual(existing.createAuthority, record.createAuthority)) {
    throw new Error("Cannot replace the original create authority of a retained recovery record.");
  }
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
  const recorded = state.unresolved.find((candidate) => candidate.recordId === expected.recordId);
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

/** Preserve the original tracking without asserting historical runtime cleanup. */
export function archiveRetainedSandboxRecoveryForLocalDiscard(
  filePath: string,
  record: RetainedSandboxRecoveryRecord,
  reservation: SandboxEntry | null,
): string {
  if (!retainedSandboxRecoveryAuthorityIsCurrent(filePath, record)) {
    throw new Error("Recovery authority changed before archival.");
  }
  const archivePath = path.join(
    path.dirname(filePath),
    ".retained-recovery-archive",
    `${record.recordId}.json`,
  );
  const directory = openStateDirectory(archivePath, true)!;
  try {
    const reservationSnapshot: unknown = JSON.parse(JSON.stringify(reservation));
    const missing = Symbol("missing recovery archive");
    const existing = readStateFile(archivePath, missing, true);
    if (existing === missing) {
      const archive = {
        schemaVersion: 1,
        operation: "forced-local-recovery-discard",
        originalResourceAbsence: "unverified",
        record,
        reservation: reservationSnapshot,
      };
      revalidateStateDirectory(directory);
      const published = publishExportFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`);
      if (!published.ok) {
        throw new Error("Could not durably archive recovery; active metadata was preserved.");
      }
    }
    const archived = readStateFile(archivePath, missing, true);
    if (
      !isObjectRecord(archived) ||
      archived.schemaVersion !== 1 ||
      archived.operation !== "forced-local-recovery-discard" ||
      archived.originalResourceAbsence !== "unverified" ||
      !isDeepStrictEqual(archived.record, record) ||
      (reservation !== null && !isDeepStrictEqual(archived.reservation, reservationSnapshot))
    ) {
      throw new Error("Recovery archive conflicts with the current record or reservation.");
    }
    revalidateStateDirectory(directory);
    fs.fsyncSync(directory.descriptor);
    return archivePath;
  } finally {
    fs.closeSync(directory.descriptor);
  }
}

/** Retire only the unchanged record after its caller qualifies retirement. */
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
  if (
    loadState(filePath).unresolved.some((candidate) => candidate.recordId === expected.recordId)
  ) {
    throw new Error("Retained sandbox recovery record remained after verified cleanup.");
  }
  return true;
}
