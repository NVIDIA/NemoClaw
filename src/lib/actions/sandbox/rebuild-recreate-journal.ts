// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  type SandboxRecreateObserver,
  type SandboxRecreateTarget,
} from "../../onboard/sandbox-recreate-probe";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  clearCompletedSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  planSandboxRecreateRecovery,
  type SandboxRecreateSourcePresence,
  sandboxRecreatePhaseReached,
} from "../../onboard/sandbox-recreate-transaction";
import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import type {
  CheckpointGatewayAuthority,
  CheckpointSandboxRecreatePhase,
} from "../../state/onboard-checkpoint-types";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import {
  listBackups,
  type RebuildManifest,
  type SnapshotEntry,
  validateRebuildRecoveryManifest,
} from "../../state/sandbox";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";

const REBUILD_RECOVERY_FILE = ".nemoclaw-rebuild-recovery.json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type RebuildRecoveryBackupRecord = {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly sandboxName: string;
  readonly backupTimestamp: string;
};

type RebuildRecoveryBackupIdentity = {
  readonly sandboxName: string;
  readonly agentName: string | null | undefined;
  readonly transactionId: string;
};

interface RebuildRecoveryBackupDeps {
  readonly listBackups?: typeof listBackups;
  readonly validateManifest?: typeof validateRebuildRecoveryManifest;
}

function validateRecoveryIdentity(input: RebuildRecoveryBackupIdentity): void {
  if (!UUID_PATTERN.test(input.transactionId)) {
    throw new Error("Rebuild recovery transaction identity is invalid.");
  }
}

function recoveryPath(backupPath: string): string {
  return path.join(backupPath, REBUILD_RECOVERY_FILE);
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
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(["backupTimestamp", "sandboxName", "schemaVersion", "transactionId"]) ||
      value.schemaVersion !== 1 ||
      typeof value.transactionId !== "string" ||
      !UUID_PATTERN.test(value.transactionId) ||
      typeof value.sandboxName !== "string" ||
      typeof value.backupTimestamp !== "string"
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
    throw error;
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
      throw new Error("Rebuild recovery backup record authority is invalid.");
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
      throw new Error("Rebuild recovery backup record changed while it was read.");
    }
    return parseRecoveryRecord(raw);
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

/** Bind one published backup to the active outer rebuild transaction. */
export function recordRebuildRecoveryBackup(
  input: RebuildRecoveryBackupIdentity & { readonly backupManifest: RebuildManifest },
  deps: RebuildRecoveryBackupDeps = {},
): void {
  validateRecoveryIdentity(input);
  const manifest = validatedRecoveryManifest(input, input.backupManifest, deps);
  const existing = readRecoveryRecord(manifest.backupPath);
  if (existing) {
    if (!recoveryRecordMatches(existing, input, manifest)) {
      throw new Error("Rebuild recovery backup already belongs to another transaction.");
    }
    return;
  }
  const record: RebuildRecoveryBackupRecord = {
    schemaVersion: 1,
    transactionId: input.transactionId,
    sandboxName: input.sandboxName,
    backupTimestamp: manifest.timestamp,
  };
  const descriptor = fs.openSync(
    recoveryPath(manifest.backupPath),
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
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
  input: RebuildRecoveryBackupIdentity & { readonly backupManifest: RebuildManifest },
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
  markDeleting(): void;
  observeSourceForDelete(): RebuildRecreateSourcePresence;
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
  const sourceEntry = registry.getSandbox(target.sandboxName);
  const observation = observe(target);
  const active = onboardSession.loadSession()?.checkpoint?.sandboxRecreate ?? null;
  const recovery = active
    ? planSandboxRecreateRecovery(active, observation, sourceEntry)
    : { action: "continue_delete" as const };
  if (recovery.action === "reject") {
    throw new Error(
      `Cannot resume sandbox '${target.sandboxName}' replacement: ${recovery.reason}.`,
    );
  }
  // A registered, ready same-name sandbox carrying the journaled target
  // generation and identity is the replacement this rebuild already proved.
  // The caller must retire the transaction instead of deleting it again.
  const acceptedTarget = recovery.action === "accept_target";

  const session = onboardSession.updateSession((current) => {
    const checkpoint = current.checkpoint ?? deriveCheckpointFromSession(current);
    current.checkpoint = {
      ...checkpoint,
      machineState: current.machine.state,
      updatedAt: new Date().toISOString(),
      sandboxIdentity: decisionSelected({ name: target.sandboxName, agent: agentName }),
      gatewayAuthority: decisionSelected(gatewayAuthority),
    };
    beginSandboxRecreateTransaction(current, {
      sandboxName: target.sandboxName,
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
      sourceEntry,
      observation,
      targetIntentFingerprint,
    });
    return current;
  });

  const transaction = session.checkpoint?.sandboxRecreate;
  if (!transaction) {
    throw new Error(
      `Sandbox '${target.sandboxName}' replacement journal could not be recorded before deletion.`,
    );
  }
  log(
    `Journaled replacement ${transaction.id} for '${target.sandboxName}' on ${target.gatewayName}:${String(target.gatewayPort)} at phase '${transaction.phase}'`,
  );

  let phase: CheckpointSandboxRecreatePhase = transaction.phase;
  const advance = (next: CheckpointSandboxRecreatePhase): void => {
    onboardSession.updateSession((current) => {
      phase = advanceSandboxRecreateTransaction(current, transaction.id, next).phase;
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
    markDeleting: () => {
      if (sandboxRecreatePhaseReached(phase, "deleted")) return;
      advance("deleting");
    },
    observeSourceForDelete: () => {
      const current = observe(target);
      if (current.state === "missing") return "missing";
      if (
        !transaction.sourceLiveIdentityFingerprint ||
        current.liveIdentityFingerprint !== transaction.sourceLiveIdentityFingerprint
      ) {
        throw new Error(
          `Cannot delete sandbox '${target.sandboxName}': the live same-name sandbox is not the journaled source.`,
        );
      }
      return "source";
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
