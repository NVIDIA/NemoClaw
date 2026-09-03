// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  checkpointGatewayAuthority,
  gatewayOwnerFromCheckpoint,
} from "../../onboard/gateway-authority-checkpoint";
import { describeGatewayOwnerForError, sameGatewayOwner } from "../../onboard/gateway-ownership";
import {
  GatewayAuthorityError,
  gatewayAuthorityFailureLines,
  isManagedPackagedServiceMigration,
  resolveGatewayRebuildAuthority,
} from "../../onboard/gateway-teardown-authority";
import {
  observeSandboxOnGateway,
  observeSandboxPresenceOnGateway,
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "../../onboard/sandbox-recreate-probe";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateDelete,
  clearCompletedSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  ownSandboxRecreateTransaction,
  type SandboxRecreateSourcePresence,
  sandboxRecreatePhaseReached,
} from "../../onboard/sandbox-recreate-transaction";
import { isValidName } from "../../sandbox-name-contract";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import type {
  CheckpointGatewayAuthority,
  CheckpointSandboxRecreatePhase,
} from "../../state/onboard-checkpoint-types";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import {
  clearRebuildPolicyHandoff,
  listBackups,
  type RebuildManifest,
  type SnapshotEntry,
  validateRebuildRecoveryManifest,
} from "../../state/sandbox";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";

const REBUILD_RECOVERY_FILE = ".nemoclaw-rebuild-recovery.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type RebuildRecoveryBackupRecordV1 = {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly backupTimestamp: string;
};

type RebuildRecoveryBackupRecordV2 = {
  readonly schemaVersion: 2;
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly backupTimestamp: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
};

type RebuildRecoveryBackupRecordV3 = {
  readonly schemaVersion: 3;
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly backupTimestamp: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly phase: "restore" | "cleanup";
};

type RebuildRecoveryBackupRecord =
  | RebuildRecoveryBackupRecordV1
  | RebuildRecoveryBackupRecordV2
  | RebuildRecoveryBackupRecordV3;

type RebuildRecoveryBackupIdentity = {
  readonly sandboxName: string;
  readonly agentName: string | null | undefined;
  readonly transactionId: string;
};

interface RebuildRecoveryBackupDeps {
  readonly listBackups?: typeof listBackups;
  readonly validateManifest?: typeof validateRebuildRecoveryManifest;
  readonly observePresence?: typeof observeSandboxPresenceOnGateway;
  readonly clearPolicyHandoff?: typeof clearRebuildPolicyHandoff;
}

function validateRecoveryIdentity(input: RebuildRecoveryBackupIdentity): void {
  if (!isValidName(input.sandboxName)) {
    throw new Error("Rebuild recovery sandbox identity is invalid.");
  }
  if (!UUID_PATTERN.test(input.transactionId)) {
    throw new Error("Rebuild recovery transaction identity is invalid.");
  }
}

function recoveryPath(backupPath: string): string {
  return path.join(backupPath, REBUILD_RECOVERY_FILE);
}

function invalidRecoveryRecordError(backupPath: string, detail: string, cause?: unknown): Error {
  return new Error(
    `Rebuild recovery marker at '${recoveryPath(backupPath)}' is invalid or unreadable (${detail}). ` +
      `Recovery remains at '${backupPath}'. Do not edit or remove the marker or retained policy handoff. ` +
      "Restore the marker's mode and ownership if those are the only damaged attributes, or restore the exact marker from a trusted backup, then rerun the same retirement command. " +
      "If no trusted marker is available, preserve the backup and ask a NemoClaw maintainer to inspect it.",
    { cause },
  );
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validatedRecoveryManifest(
  input: RebuildRecoveryBackupIdentity,
  manifest: RebuildManifest,
  deps: RebuildRecoveryBackupDeps,
): RebuildManifest {
  const validation = (deps.validateManifest ?? validateRebuildRecoveryManifest)(
    input.sandboxName,
    input.agentName,
    manifest,
  );
  if (!validation.ok) {
    throw new Error(`Rebuild recovery backup is invalid: ${validation.reason}.`);
  }
  return validation.manifest;
}

function parseRecoveryRecord(raw: string): RebuildRecoveryBackupRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const expectedKeys =
      value?.schemaVersion === 3
        ? [
            "backupTimestamp",
            "gatewayName",
            "gatewayPort",
            "phase",
            "sandboxName",
            "schemaVersion",
            "transactionId",
          ]
        : value?.schemaVersion === 2
        ? [
            "backupTimestamp",
            "gatewayName",
            "gatewayPort",
            "sandboxName",
            "schemaVersion",
            "transactionId",
          ]
        : ["backupTimestamp", "sandboxName", "schemaVersion", "transactionId"];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
      typeof value.transactionId !== "string" ||
      !UUID_PATTERN.test(value.transactionId) ||
      typeof value.sandboxName !== "string" ||
      !isValidName(value.sandboxName) ||
      typeof value.backupTimestamp !== "string" ||
      ((value.schemaVersion === 2 || value.schemaVersion === 3) &&
        (typeof value.gatewayName !== "string" ||
          !isValidName(value.gatewayName) ||
          !Number.isSafeInteger(value.gatewayPort) ||
          Number(value.gatewayPort) < 1 ||
          Number(value.gatewayPort) > 65_535)) ||
      (value.schemaVersion === 3 && value.phase !== "restore" && value.phase !== "cleanup")
    ) {
      return null;
    }
    return value as RebuildRecoveryBackupRecord;
  } catch {
    return null;
  }
}

function readRecoveryRecord(backupPath: string): RebuildRecoveryBackupRecord | null {
  const filePath = recoveryPath(backupPath);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const code = (error as NodeJS.ErrnoException).code;
    throw invalidRecoveryRecordError(
      backupPath,
      code ? `open failed with ${code}` : "open failed",
      error,
    );
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const uid = process.getuid?.();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      (uid !== undefined && before.uid !== BigInt(uid)) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size < 1n ||
      before.size > 4096n
    ) {
      throw invalidRecoveryRecordError(backupPath, "file authority is invalid");
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw invalidRecoveryRecordError(backupPath, "file changed while it was read");
    }
    const record = parseRecoveryRecord(raw);
    if (!record) {
      throw invalidRecoveryRecordError(backupPath, "content or schema is invalid");
    }
    return record;
  } finally {
    fs.closeSync(descriptor);
  }
}

function recoveryRecordMatches(
  record: RebuildRecoveryBackupRecord | null,
  input: RebuildRecoveryBackupIdentity,
  manifest: RebuildManifest,
): boolean {
  return (
    record?.transactionId === input.transactionId &&
    record.sandboxName === input.sandboxName &&
    record.backupTimestamp === manifest.timestamp
  );
}

function replaceRecoveryRecord(
  backupPath: string,
  record: RebuildRecoveryBackupRecordV3,
): void {
  const filePath = recoveryPath(backupPath);
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    syncDirectory(backupPath);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** Bind one published backup to the active outer rebuild transaction. */
export function recordRebuildRecoveryBackup(
  input: RebuildRecoveryBackupIdentity &
    Pick<SandboxRecreateTarget, "gatewayName" | "gatewayPort"> & {
      readonly backupManifest: RebuildManifest;
    },
  deps: RebuildRecoveryBackupDeps = {},
): void {
  validateRecoveryIdentity(input);
  if (
    !isValidName(input.gatewayName) ||
    !Number.isSafeInteger(input.gatewayPort) ||
    input.gatewayPort < 1 ||
    input.gatewayPort > 65_535
  ) {
    throw new Error("Rebuild recovery gateway identity is invalid.");
  }
  const manifest = validatedRecoveryManifest(input, input.backupManifest, deps);
  const existing = readRecoveryRecord(manifest.backupPath);
  if (existing) {
    if (!recoveryRecordMatches(existing, input, manifest)) {
      throw new Error("Rebuild recovery backup already belongs to another transaction.");
    }
    return;
  }
  const record: RebuildRecoveryBackupRecord = {
    schemaVersion: 3,
    transactionId: input.transactionId,
    sandboxName: input.sandboxName,
    backupTimestamp: manifest.timestamp,
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
    phase: "restore",
  };
  const descriptor = fs.openSync(
    recoveryPath(manifest.backupPath),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  syncDirectory(manifest.backupPath);
}

/** Report whether an exact recovery record has entered cleanup-only state. */
export function isRebuildRecoveryCleanupOnly(
  input: Omit<RebuildRecoveryBackupIdentity, "transactionId"> & {
    readonly transactionId?: string;
    readonly backupManifest: RebuildManifest;
  },
  deps: RebuildRecoveryBackupDeps = {},
): boolean {
  if (!isValidName(input.sandboxName)) {
    throw new Error("Rebuild recovery sandbox identity is invalid.");
  }
  const record = readRecoveryRecord(input.backupManifest.backupPath);
  if (!record) return false;
  const identity = {
    sandboxName: input.sandboxName,
    agentName: input.agentName,
    transactionId: input.transactionId ?? record.transactionId,
  };
  validateRecoveryIdentity(identity);
  const manifest = validatedRecoveryManifest(identity, input.backupManifest, deps);
  if (!recoveryRecordMatches(record, identity, manifest)) return false;
  return record?.schemaVersion === 3 && record.phase === "cleanup";
}

/** Persist cleanup-only state before removing the final handoff metadata. */
export function markRebuildRecoveryCleanupOnly(
  input: RebuildRecoveryBackupIdentity & { readonly backupManifest: RebuildManifest },
  deps: RebuildRecoveryBackupDeps = {},
): void {
  validateRecoveryIdentity(input);
  const manifest = validatedRecoveryManifest(input, input.backupManifest, deps);
  const record = readRecoveryRecord(manifest.backupPath);
  if (!record || !recoveryRecordMatches(record, input, manifest)) {
    throw new Error("Rebuild recovery backup record is missing or changed.");
  }
  if (record.schemaVersion === 1) {
    throw new Error("Rebuild recovery backup record lacks cleanup authority.");
  }
  if (record.schemaVersion === 3 && record.phase === "cleanup") return;
  replaceRecoveryRecord(manifest.backupPath, {
    ...record,
    schemaVersion: 3,
    phase: "cleanup",
  });
}

/** Find the exact backup bound to an interrupted replacement transaction. */
export function findRebuildRecoveryBackup(
  input: RebuildRecoveryBackupIdentity,
  deps: RebuildRecoveryBackupDeps = {},
): SnapshotEntry | null {
  validateRecoveryIdentity(input);
  for (const candidate of (deps.listBackups ?? listBackups)(input.sandboxName)) {
    const record = readRecoveryRecord(candidate.backupPath);
    if (record?.transactionId !== input.transactionId) continue;
    const manifest = validatedRecoveryManifest(input, candidate, deps);
    if (recoveryRecordMatches(record, input, manifest)) return candidate;
  }
  return null;
}

/** Retire the bounded recovery record after restore and post-restore succeed. */
export function clearRebuildRecoveryBackup(
  input: RebuildRecoveryBackupIdentity & {
    readonly backupManifest: RebuildManifest;
  },
  deps: RebuildRecoveryBackupDeps = {},
): void {
  validateRecoveryIdentity(input);
  const manifest = validatedRecoveryManifest(input, input.backupManifest, deps);
  if (!recoveryRecordMatches(readRecoveryRecord(manifest.backupPath), input, manifest)) {
    throw new Error("Rebuild recovery backup record is missing or changed.");
  }
  fs.unlinkSync(recoveryPath(manifest.backupPath));
  syncDirectory(manifest.backupPath);
}

export type RetiredRebuildRecovery = Readonly<{
  backupPath: string;
  gatewayName: string;
  transactionId: string;
}>;

/**
 * Retire one credential-bearing rebuild handoff only after its recorded
 * gateway proves the old sandbox absent and the operator attests that required
 * data recovery is complete.
 */
export function retireRebuildRecoveryBackup(
  input: Readonly<{
    sandboxName: string;
    transactionId: string;
    confirmDataRecovered: boolean;
  }>,
  deps: RebuildRecoveryBackupDeps = {},
): RetiredRebuildRecovery {
  validateRecoveryIdentity({ ...input, agentName: null });
  if (!input.confirmDataRecovered) {
    throw new Error(
      "Recovery retirement requires --yes to confirm that required data recovery is complete.",
    );
  }

  let selected:
    | {
        manifest: RebuildManifest;
        record: RebuildRecoveryBackupRecordV2 | RebuildRecoveryBackupRecordV3;
      }
    | undefined;
  for (const candidate of (deps.listBackups ?? listBackups)(input.sandboxName)) {
    const record = readRecoveryRecord(candidate.backupPath);
    if (record?.transactionId !== input.transactionId) continue;
    if (record.sandboxName !== input.sandboxName) {
      throw new Error(
        `Rebuild recovery identity does not match sandbox '${input.sandboxName}'. Recovery remains at '${candidate.backupPath}'.`,
      );
    }
    if (record.schemaVersion === 1) {
      throw new Error(
        `Rebuild recovery '${input.transactionId}' does not contain recorded gateway authority. Recovery remains at '${candidate.backupPath}'.`,
      );
    }
    const identity = {
      sandboxName: input.sandboxName,
      agentName: candidate.agentType,
      transactionId: input.transactionId,
    };
    const manifest = validatedRecoveryManifest(identity, candidate, deps);
    if (!recoveryRecordMatches(record, identity, manifest)) {
      throw new Error(
        `Rebuild recovery identity changed before retirement. Recovery remains at '${candidate.backupPath}'.`,
      );
    }
    selected = { manifest, record };
    break;
  }
  if (!selected) {
    throw new Error(
      `No exact rebuild recovery record exists for sandbox '${input.sandboxName}' and transaction '${input.transactionId}'.`,
    );
  }

  const { manifest, record } = selected;
  try {
    const presence = (deps.observePresence ?? observeSandboxPresenceOnGateway)({
      sandboxName: input.sandboxName,
      gatewayName: record.gatewayName,
    });
    if (presence !== "missing") {
      throw new Error(
        `OpenShell still reports sandbox '${input.sandboxName}' on recorded gateway '${record.gatewayName}'`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot retire rebuild recovery before confirmed sandbox deletion: ${detail}. Recovery remains at '${manifest.backupPath}'.`,
      { cause: error },
    );
  }

  if (!(deps.clearPolicyHandoff ?? clearRebuildPolicyHandoff)(manifest)) {
    throw new Error(
      `The retained rebuild policy handoff could not be removed. Recovery remains at '${manifest.backupPath}'.`,
    );
  }
  try {
    clearRebuildRecoveryBackup(
      {
        sandboxName: input.sandboxName,
        agentName: manifest.agentType,
        transactionId: input.transactionId,
        backupManifest: manifest,
      },
      deps,
    );
  } catch (error) {
    throw new Error(
      `The rebuild recovery marker could not be removed. Recovery remains at '${manifest.backupPath}'.`,
      { cause: error },
    );
  }
  return {
    backupPath: manifest.backupPath,
    gatewayName: record.gatewayName,
    transactionId: input.transactionId,
  };
}

export type RebuildRecreateJournalTarget = SandboxRecreateTarget;

export type RebuildSandboxObserver = SandboxRecreateObserver;

export type RebuildRecreateSourcePresence = SandboxRecreateSourcePresence;

export interface RebuildRecreateJournal {
  readonly id: string;
  readonly acceptedTarget: boolean;
  readonly sourceConfirmedAbsent: boolean;
  readonly gatewayAuthority: CheckpointGatewayAuthority;
  readonly targetGeneration: string;
  readonly targetIntentFingerprint: string;
  beginDelete(): RebuildRecreateSourcePresence;
  confirmDeleted(): void;
  completeAcceptedTarget(): void;
}

export function fingerprintRebuildRecreateTargetIntent(
  options: Pick<
    RebuildRecreateOnboardOpts,
    | "agent"
    | "endpointSource"
    | "recreateProvider"
    | "recreateModel"
    | "recreatePreferredInferenceApi"
    | "fromDockerfile"
    | "sandboxGpu"
    | "sandboxGpuDevice"
    | "controlUiPort"
    | "hostMounts"
    | "targetGatewayName"
    | "targetGatewayPort"
    | "toolDisclosure"
    | "dcodeAutoApprovalMode"
    | "observabilityEnabled"
  >,
): string {
  const hostMounts = (options.hostMounts ?? []).map(
    ({ source, target, readOnly, sourceIdentity }) => ({
      source,
      target,
      readOnly,
      sourceIdentity: sourceIdentity
        ? { device: sourceIdentity.device, inode: sourceIdentity.inode }
        : null,
    }),
  );
  return fingerprintSandboxRecreateValue({
    version: 1,
    agent: options.agent ?? null,
    endpointSource: options.endpointSource ?? null,
    provider: options.recreateProvider,
    model: options.recreateModel,
    preferredInferenceApi: options.recreatePreferredInferenceApi,
    fromDockerfile: options.fromDockerfile,
    sandboxGpu: options.sandboxGpu,
    sandboxGpuDevice: options.sandboxGpuDevice,
    controlUiPort: options.controlUiPort,
    // Preserve the version-1 fingerprint for existing mount-free journals.
    // A previous journal with mounts did not bind their source identity and
    // must remain incompatible with the stronger fingerprint.
    ...(hostMounts.length > 0 ? { hostMounts } : {}),
    gatewayName: options.targetGatewayName,
    gatewayPort: options.targetGatewayPort,
    toolDisclosure: options.toolDisclosure,
    dcodeAutoApprovalMode: options.dcodeAutoApprovalMode,
    observabilityEnabled: options.observabilityEnabled,
  });
}

export const observeRebuildSandbox = observeSandboxOnGateway;

export interface OpenRebuildRecreateJournalInput {
  readonly target: RebuildRecreateJournalTarget;
  readonly expectedGatewayAuthority: CheckpointGatewayAuthority;
  readonly agentName: string;
  readonly targetIntentFingerprint: string;
  readonly log: (message: string) => void;
  readonly observe?: RebuildSandboxObserver;
  /**
   * Invoked with ready-to-print lines when gateway authority cannot be
   * revalidated, so the command layer can fail cleanly (#8103).
   */
  readonly onAuthorityRefusal?: (lines: readonly string[]) => void;
}

export function openRebuildRecreateJournal(
  input: OpenRebuildRecreateJournalInput,
): RebuildRecreateJournal {
  const { target, agentName, targetIntentFingerprint, log } = input;
  const observe = input.observe ?? observeRebuildSandbox;
  // Authority revalidation runs before the destroy phase. Handing the refusal
  // to the caller lets rebuild report the migration and its remedy instead of
  // crashing with a Node stack trace (#8103). The dedicated rebuild resolver
  // permits its narrowly defined managed-service migration.
  let authority: ReturnType<typeof resolveGatewayRebuildAuthority>;
  try {
    authority = resolveGatewayRebuildAuthority({
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
    });
    const expectedAuthority = gatewayOwnerFromCheckpoint(input.expectedGatewayAuthority);
    if (
      !sameGatewayOwner(expectedAuthority, authority) &&
      !isManagedPackagedServiceMigration(expectedAuthority, authority)
    ) {
      throw new GatewayAuthorityError(
        "Gateway lifecycle authority changed after authoritative rebuild preflight " +
          `(${describeGatewayOwnerForError(expectedAuthority)} -> ${describeGatewayOwnerForError(authority)}). ` +
          "Retry the rebuild; the current run will not delete the source sandbox.",
      );
    }
  } catch (error) {
    if (!(error instanceof GatewayAuthorityError)) throw error;
    input.onAuthorityRefusal?.(gatewayAuthorityFailureLines(error, "sandbox rebuild"));
    throw error;
  }
  const gatewayAuthority = checkpointGatewayAuthority(authority);
  const owned = ownSandboxRecreateTransaction({
    sessionStore: {
      loadSession: onboardSession.loadSession,
      updateSession: onboardSession.updateSession,
      compareAndSwapSession: onboardSession.compareAndSwapSession,
    },
    sandboxName: target.sandboxName,
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
    targetIntentFingerprint,
    readRegistryEntry: () => registry.getSandbox(target.sandboxName),
    observe: () => observe(target),
    decorateCheckpoint: (current, checkpoint, now) => ({
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: now,
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(gatewayAuthority),
    }),
  });
  const { session, transaction, recovery } = owned;
  if (owned.replacedTransactionId) {
    log(
      `Replaced void journal ${owned.replacedTransactionId} with ${transaction.id} for '${target.sandboxName}'; its source sandbox is registered and live`,
    );
    console.log(
      `  Replaced the void replacement journal for '${target.sandboxName}'; its source sandbox is registered and live.`,
    );
  }
  const acceptedTarget = recovery.action === "accept_target";
  log(
    `Journaled replacement ${transaction.id} for '${target.sandboxName}' on ${target.gatewayName}:${String(target.gatewayPort)} at phase '${transaction.phase}'`,
  );

  const openingSessionId = session.sessionId;
  let currentTransaction = transaction;
  let phase: CheckpointSandboxRecreatePhase = transaction.phase;
  const revalidateGatewayAuthority = (): void => {
    const currentAuthority = resolveGatewayRebuildAuthority({
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
    });
    if (!sameGatewayOwner(authority, currentAuthority)) {
      throw new GatewayAuthorityError(
        "Gateway lifecycle authority changed after the recreate journal was recorded " +
          `(${describeGatewayOwnerForError(authority)} -> ${describeGatewayOwnerForError(currentAuthority)}). ` +
          "Retry the rebuild; the current run will not delete the source sandbox.",
      );
    }
  };
  const advance = (next: CheckpointSandboxRecreatePhase): void => {
    onboardSession.updateSession((current) => {
      currentTransaction = advanceSandboxRecreateTransaction(current, transaction.id, next);
      phase = currentTransaction.phase;
      return current;
    });
  };

  return {
    id: transaction.id,
    acceptedTarget,
    sourceConfirmedAbsent: recovery.action === "continue_create",
    gatewayAuthority,
    targetGeneration: transaction.targetGeneration,
    targetIntentFingerprint: transaction.targetIntentFingerprint,
    beginDelete: () => {
      const begun = beginSandboxRecreateDelete({
        sessionStore: {
          loadSession: onboardSession.loadSession,
          updateSession: onboardSession.updateSession,
          compareAndSwapSession: onboardSession.compareAndSwapSession,
        },
        openingSessionId,
        expectedTransaction: currentTransaction,
        targetIntentFingerprint,
        revalidateGatewayAuthority,
        readRegistryEntry: () => registry.getSandbox(target.sandboxName),
        observe: () => observe(target),
      });
      currentTransaction = begun.transaction;
      phase = currentTransaction.phase;
      return begun.sourcePresence;
    },
    confirmDeleted: () => {
      if (observe(target).state !== "missing") {
        throw new Error(
          `Cannot continue sandbox '${target.sandboxName}' replacement: OpenShell still reports the journaled source after delete.`,
        );
      }
      advance("deleted");
    },
    completeAcceptedTarget: () => {
      if (!acceptedTarget) {
        throw new Error(
          `Sandbox '${target.sandboxName}' replacement journal cannot be retired before its replacement is proven.`,
        );
      }
      for (const next of ["registry_committing", "completed"] as const) {
        if (!sandboxRecreatePhaseReached(phase, next)) advance(next);
      }
      onboardSession.updateSession((current) => {
        clearCompletedSandboxRecreateTransaction(current, transaction.id);
        return current;
      });
    },
  };
}
