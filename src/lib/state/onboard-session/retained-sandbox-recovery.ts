// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";

const SCHEMA_VERSION = 1;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_EVIDENCE_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const NAME_MAX_LENGTH = 63;
const NAME_VALID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

export function retainedSandboxRecoveryFile(sessionDirectory: string): string {
  return path.join(sessionDirectory, "retained-sandbox-recovery.json");
}

export type RetainedSandboxRecoveryReason =
  | "cancelled_after_sandbox_creation"
  | "retained_after_sandbox_creation_failure";

export interface RetainedSandboxResourceEvidence {
  readonly sharedInferenceProviders: readonly string[];
  readonly sandboxScopedProviders: readonly string[];
  readonly credentialEnvironmentVariables: readonly string[];
}

export interface RetainedSandboxVerifiedEffectivePolicyIdentity {
  readonly hash: string;
  readonly activeVersion: number;
}

export interface RetainedSandboxRecoveryRecord {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly recordId: string;
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly identityWasUnavailable: boolean;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string | null;
  readonly verifiedEffectivePolicyIdentity: RetainedSandboxVerifiedEffectivePolicyIdentity | null;
  readonly resources: RetainedSandboxResourceEvidence;
  readonly reason: RetainedSandboxRecoveryReason;
  readonly recordedAt: string;
}

interface RetainedSandboxAdministratorResolutionReceipt {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly receiptId: string;
  readonly recordId: string;
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly outcome: "removed_verified_identity" | "confirmed_absent_without_identity";
  readonly resolvedAt: string;
}

interface RetainedSandboxRecoveryState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly unresolved: readonly RetainedSandboxRecoveryRecord[];
  readonly resolutions: readonly RetainedSandboxAdministratorResolutionReceipt[];
}

export interface RecordRetainedSandboxRecoveryInput {
  readonly sandboxName: string;
  readonly sandboxIdentityFingerprint: string | null;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string | null;
  readonly verifiedEffectivePolicyIdentity: RetainedSandboxVerifiedEffectivePolicyIdentity | null;
  readonly resources: RetainedSandboxResourceEvidence;
  readonly reason: RetainedSandboxRecoveryReason;
  readonly recordedAt?: string;
}

const emptyState = (): RetainedSandboxRecoveryState => ({
  schemaVersion: SCHEMA_VERSION,
  unresolved: [],
  resolutions: [],
});

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStateFile(filePath: string): unknown {
  try {
    const file = openRegularFileNoFollow(filePath);
    try {
      return JSON.parse(file.readUtf8());
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
  }
}

function writeStateFile(filePath: string, state: RetainedSandboxRecoveryState): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
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
      throw error;
    }
  }
  const temporary = path.join(
    directory,
    `.retained-sandbox-recovery.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    const descriptor = fs.openSync(temporary, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filePath);
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
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
  const resources = parseEvidence(value.resources);
  const fingerprint = value.sandboxIdentityFingerprint;
  const verifiedEffectivePolicyIdentity = parseVerifiedEffectivePolicyIdentity(
    value.verifiedEffectivePolicyIdentity,
  );
  const reason = value.reason;
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.recordId !== "string" ||
    !FINGERPRINT_PATTERN.test(value.recordId) ||
    !validSandboxName(value.sandboxName) ||
    (fingerprint !== null &&
      (typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint))) ||
    value.identityWasUnavailable !== (fingerprint === null) ||
    !validSafeEvidence(value.gatewayName) ||
    !validGatewayPort(value.gatewayPort) ||
    (value.lifecycleGeneration !== null && !validSafeEvidence(value.lifecycleGeneration)) ||
    verifiedEffectivePolicyIdentity === undefined ||
    !resources ||
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
    identityWasUnavailable: fingerprint === null,
    gatewayName: value.gatewayName,
    gatewayPort: value.gatewayPort,
    lifecycleGeneration: value.lifecycleGeneration,
    verifiedEffectivePolicyIdentity,
    resources,
    reason: reason as RetainedSandboxRecoveryReason,
    recordedAt: value.recordedAt,
  };
}

function parseReceipt(value: unknown): RetainedSandboxAdministratorResolutionReceipt | null {
  if (!isObjectRecord(value)) return null;
  const fingerprint = value.sandboxIdentityFingerprint;
  const outcome = value.outcome;
  if (
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.receiptId !== "string" ||
    !FINGERPRINT_PATTERN.test(value.receiptId) ||
    typeof value.recordId !== "string" ||
    !FINGERPRINT_PATTERN.test(value.recordId) ||
    !validSandboxName(value.sandboxName) ||
    (fingerprint !== null &&
      (typeof fingerprint !== "string" || !FINGERPRINT_PATTERN.test(fingerprint))) ||
    !validSafeEvidence(value.gatewayName) ||
    !validGatewayPort(value.gatewayPort) ||
    !["removed_verified_identity", "confirmed_absent_without_identity"].includes(String(outcome)) ||
    !validTimestamp(value.resolvedAt)
  ) {
    return null;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    receiptId: value.receiptId,
    recordId: value.recordId,
    sandboxName: value.sandboxName,
    sandboxIdentityFingerprint: fingerprint,
    gatewayName: value.gatewayName,
    gatewayPort: value.gatewayPort,
    outcome: outcome as RetainedSandboxAdministratorResolutionReceipt["outcome"],
    resolvedAt: value.resolvedAt,
  };
}

function loadState(filePath: string): RetainedSandboxRecoveryState {
  const value = readStateFile(filePath);
  if (!isObjectRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Retained sandbox recovery state has an unsupported schema.");
  }
  const unresolved = Array.isArray(value.unresolved) ? value.unresolved.map(parseRecord) : null;
  const resolutions = Array.isArray(value.resolutions) ? value.resolutions.map(parseReceipt) : null;
  if (!unresolved || unresolved.includes(null) || !resolutions || resolutions.includes(null)) {
    throw new Error("Retained sandbox recovery state is invalid; onboarding remains blocked.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    unresolved: unresolved as RetainedSandboxRecoveryRecord[],
    resolutions: resolutions as RetainedSandboxAdministratorResolutionReceipt[],
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
    !parseEvidence(input.resources)
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
    schemaVersion: SCHEMA_VERSION,
    recordId: recoveryRecordId(input),
    sandboxName: input.sandboxName,
    sandboxIdentityFingerprint: input.sandboxIdentityFingerprint,
    identityWasUnavailable: input.sandboxIdentityFingerprint === null,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    lifecycleGeneration: input.lifecycleGeneration,
    verifiedEffectivePolicyIdentity: input.verifiedEffectivePolicyIdentity
      ? { ...input.verifiedEffectivePolicyIdentity }
      : null,
    resources: parseEvidence(input.resources)!,
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
