// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { isErrnoException } from "../../core/errno";
import { isValidName } from "../../sandbox-name-contract";
import { isMcpLifecycleLockHeld } from "../mcp-lifecycle-lock/inspection";
import { MCP_LIFECYCLE_LOCK_DIRNAME } from "../mcp-lifecycle-lock-storage";
import { resolveNemoclawStateDir } from "../paths";

/**
 * Bounded upgrade diagnostic for state written by the removed Shields feature.
 *
 * Recovery files are never interpreted, trusted, or deleted here. In
 * particular, a timer marker can still name an old detached process whose
 * already-loaded code may act after this version is installed. Treat those
 * artifacts as a hard reuse boundary instead of reviving the retired
 * timer/state machine. The inert per-sandbox state record is retired only after
 * a caller proves a mutable rebuild or exact sandbox destruction.
 */
export interface RemovedImmutabilityMigrationInspection {
  readonly stateRecord: string | null;
  readonly recoveryArtifacts: readonly string[];
}

export interface RemovedImmutabilityUpgradeNotice {
  readonly affectedSandboxes: readonly string[];
  readonly hasUnattributedRecoveryState: boolean;
}

const LEGACY_PROVIDER_LEDGER_DIRNAME = "runtime-provider-lifecycle";
const LEGACY_PROVIDER_RECORD_NAMES = new Set([
  "prepared.json",
  "mutation-authorized.json",
  "fence-established.json",
  "completed.json",
]);
const MAX_LEGACY_LEDGER_ENTRIES = 4096;
const MAX_LEGACY_LEDGER_RECORD_BYTES = 128 * 1024;

interface LegacyProviderLedgerInspection {
  readonly artifactsBySandbox: ReadonlyMap<string, readonly string[]>;
  readonly ambiguousArtifacts: readonly string[];
  readonly noticeArtifacts: readonly string[];
}

function entryExists(entryPath: string): boolean {
  try {
    fs.lstatSync(entryPath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isRetirableLegacyStateRecord(recordPath: string): boolean {
  try {
    const opened = openRegularFileNoFollow(recordPath);
    try {
      opened.stat();
    } finally {
      opened.close();
    }
    return true;
  } catch {
    return false;
  }
}

function isLegacyTopLevelRecoveryEntry(entry: string): boolean {
  return (
    entry.startsWith("shields-timer-") ||
    entry.startsWith("shields-transition-") ||
    entry.startsWith("shields-external-policy-") ||
    entry.startsWith("shields-forward-policy-") ||
    entry.startsWith("policy-snapshot-")
  );
}

function legacyProviderRecordSandbox(
  recordPath: string,
  mustBeLifecycleRecord: boolean,
): { sandboxName: string | null; ambiguous: boolean } {
  let opened: ReturnType<typeof openRegularFileNoFollow>;
  try {
    opened = openRegularFileNoFollow(recordPath);
  } catch {
    return { sandboxName: null, ambiguous: mustBeLifecycleRecord };
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(opened.readBytes(MAX_LEGACY_LEDGER_RECORD_BYTES).toString("utf8"));
    } catch {
      return { sandboxName: null, ambiguous: mustBeLifecycleRecord };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { sandboxName: null, ambiguous: mustBeLifecycleRecord };
    }
    const sandboxName = (parsed as { sandboxName?: unknown }).sandboxName;
    if (typeof sandboxName === "string" && isValidName(sandboxName)) {
      return { sandboxName, ambiguous: false };
    }
    return { sandboxName: null, ambiguous: mustBeLifecycleRecord };
  } finally {
    opened.close();
  }
}

function inspectLegacyProviderLedger(stateDir: string): LegacyProviderLedgerInspection {
  const root = path.join(stateDir, LEGACY_PROVIDER_LEDGER_DIRNAME);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { artifactsBySandbox: new Map(), ambiguousArtifacts: [], noticeArtifacts: [] };
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { artifactsBySandbox: new Map(), ambiguousArtifacts: [root], noticeArtifacts: [] };
  }

  const artifactsBySandbox = new Map<string, string[]>();
  const ambiguousArtifacts: string[] = [];
  const noticeArtifacts: string[] = [];
  const recordArtifact = (
    recordPath: string,
    mustBeLifecycleRecord: boolean,
    quarantineUnit = recordPath,
  ): void => {
    const inspected = legacyProviderRecordSandbox(recordPath, mustBeLifecycleRecord);
    if (inspected.sandboxName) {
      const artifacts = artifactsBySandbox.get(inspected.sandboxName) ?? [];
      artifacts.push(quarantineUnit);
      artifactsBySandbox.set(inspected.sandboxName, artifacts);
    } else if (inspected.ambiguous) {
      ambiguousArtifacts.push(quarantineUnit);
    }
  };

  const rootEntries = fs.readdirSync(root).sort();
  if (rootEntries.length > MAX_LEGACY_LEDGER_ENTRIES) {
    return { artifactsBySandbox, ambiguousArtifacts: [root], noticeArtifacts };
  }
  for (const entry of rootEntries) {
    const entryPath = path.join(root, entry);
    if (entry === "runtime-target-claims") {
      let claimStat: fs.Stats;
      try {
        claimStat = fs.lstatSync(entryPath);
      } catch {
        ambiguousArtifacts.push(entryPath);
        continue;
      }
      if (claimStat.isSymbolicLink() || !claimStat.isDirectory()) {
        ambiguousArtifacts.push(entryPath);
        continue;
      }
      const claims = fs.readdirSync(entryPath).sort();
      if (claims.length > MAX_LEGACY_LEDGER_ENTRIES) {
        ambiguousArtifacts.push(entryPath);
        continue;
      }
      for (const claim of claims) {
        if (!/^[0-9a-f]{64}$/u.test(claim)) {
          ambiguousArtifacts.push(path.join(entryPath, claim));
          continue;
        }
        recordArtifact(path.join(entryPath, claim), true);
      }
      continue;
    }
    if (/^[0-9a-f]{64}\.retired$/u.test(entry)) continue;
    if (!/^[0-9a-f]{64}$/u.test(entry)) {
      ambiguousArtifacts.push(entryPath);
      continue;
    }
    let transactionStat: fs.Stats;
    try {
      transactionStat = fs.lstatSync(entryPath);
    } catch {
      ambiguousArtifacts.push(entryPath);
      continue;
    }
    if (transactionStat.isSymbolicLink() || !transactionStat.isDirectory()) {
      ambiguousArtifacts.push(entryPath);
      continue;
    }
    const transactionEntries = fs.readdirSync(entryPath).sort();
    if (transactionEntries.length > 64) {
      ambiguousArtifacts.push(entryPath);
      continue;
    }
    let lifecycleRecords = 0;
    for (const transactionEntry of transactionEntries) {
      if (!LEGACY_PROVIDER_RECORD_NAMES.has(transactionEntry)) continue;
      lifecycleRecords += 1;
      recordArtifact(path.join(entryPath, transactionEntry), true, entryPath);
    }
    if (lifecycleRecords === 0) {
      const preAuthorityOnly = transactionEntries.every(
        (transactionEntry) => transactionEntry === "state-mutation-intent.json",
      );
      (preAuthorityOnly ? noticeArtifacts : ambiguousArtifacts).push(entryPath);
    }
  }
  return { artifactsBySandbox, ambiguousArtifacts, noticeArtifacts };
}

function inspectRemovedImmutabilityMigrationState(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): RemovedImmutabilityMigrationInspection {
  // Command parsing owns the user-facing name error. Avoid deriving filesystem
  // keys from an invalid value if this preflight runs before normal validation.
  if (!isValidName(sandboxName)) {
    return {
      stateRecord: null,
      recoveryArtifacts: [],
    };
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return {
        stateRecord: null,
        recoveryArtifacts: [],
      };
    }
    throw error;
  }

  const stateRecordName = `shields-${sandboxName}.json`;
  const stateRecordPath = path.join(stateDir, stateRecordName);
  let stateRecord: string | null = null;
  const unsafeStateRecordArtifacts: string[] = [];
  if (entries.includes(stateRecordName)) {
    if (isRetirableLegacyStateRecord(stateRecordPath)) {
      stateRecord = stateRecordPath;
    } else {
      unsafeStateRecordArtifacts.push(stateRecordPath);
    }
  }
  const recoveryNames = entries.filter(isLegacyTopLevelRecoveryEntry);
  const nestedRecoveryPaths = inspectLegacyLifecycleSentinels(stateDir);
  const providerLedger = inspectLegacyProviderLedger(stateDir);
  const providerArtifacts = [...providerLedger.artifactsBySandbox.values()].flat();

  return {
    stateRecord,
    recoveryArtifacts: [
      ...new Set([
        ...recoveryNames.map((entry) => path.join(stateDir, entry)),
        ...nestedRecoveryPaths,
        ...providerArtifacts,
        ...providerLedger.ambiguousArtifacts,
        ...unsafeStateRecordArtifacts,
      ]),
    ].sort(),
  };
}

export function inspectRemovedImmutabilityMigration(
  sandboxName: string,
  stateDir = resolveNemoclawStateDir(),
): RemovedImmutabilityMigrationInspection {
  return inspectRemovedImmutabilityMigrationState(sandboxName, stateDir);
}

function inspectLegacyLifecycleSentinels(stateDir: string): string[] {
  const root = path.join(stateDir, MCP_LIFECYCLE_LOCK_DIRNAME);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return [];
    return [root];
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [root];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [root];
  }
  if (entries.length > MAX_LEGACY_LEDGER_ENTRIES) return [root];
  return entries
    .filter((entry) => entry.endsWith(".lock.deadline") || entry.endsWith(".lock.containment"))
    .map((entry) => path.join(root, entry))
    .sort();
}

export function reportRemovedImmutabilityUpgrade(
  options: {
    readonly stateDir?: string;
    readonly warn?: (message: string) => void;
  } = {},
): RemovedImmutabilityUpgradeNotice {
  const stateDir = path.resolve(options.stateDir ?? resolveNemoclawStateDir());
  let entries: string[];
  try {
    entries = fs.readdirSync(stateDir);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { affectedSandboxes: [], hasUnattributedRecoveryState: false };
    }
    throw error;
  }

  const affectedSandboxes = new Set<string>();
  let hasTopLevelRecoveryState = false;
  for (const entry of entries) {
    if (isLegacyTopLevelRecoveryEntry(entry)) {
      hasTopLevelRecoveryState = true;
      continue;
    }
    if (entry.startsWith("shields-") && entry.endsWith(".json")) {
      const candidate = entry.slice("shields-".length, -".json".length);
      if (isValidName(candidate)) affectedSandboxes.add(candidate);
    }
  }
  const providerLedger = inspectLegacyProviderLedger(stateDir);
  for (const sandboxName of providerLedger.artifactsBySandbox.keys()) {
    affectedSandboxes.add(sandboxName);
  }
  const noticeOnlyArtifacts = [
    ...new Set(providerLedger.noticeArtifacts.map((artifact) => path.resolve(artifact))),
  ].sort();
  const hasBlockingUnattributedRecoveryState =
    hasTopLevelRecoveryState ||
    inspectLegacyLifecycleSentinels(stateDir).length > 0 ||
    providerLedger.ambiguousArtifacts.length > 0;
  const hasUnattributedRecoveryState =
    hasBlockingUnattributedRecoveryState || noticeOnlyArtifacts.length > 0;
  const names = [...affectedSandboxes].sort();
  if (names.length > 0 || hasUnattributedRecoveryState) {
    const affected = names.length > 0 ? ` Affected sandbox records: ${names.join(", ")}.` : "";
    const unresolved = hasBlockingUnattributedRecoveryState
      ? " Unattributed transition or provider recovery state also remains."
      : "";
    const noticeOnly =
      noticeOnlyArtifacts.length > 0
        ? ` Nonblocking retired provider intent paths retained for review: ${noticeOnlyArtifacts.map((artifact) => JSON.stringify(artifact)).join(", ")}. These notice-only paths did not establish mutation authority and do not block lifecycle operations.`
        : "";
    const recovery =
      names.length > 0 || hasBlockingUnattributedRecoveryState
        ? " Back up trusted user data and rebuild or recreate affected sandboxes with the current version."
        : "";
    (options.warn ?? console.warn)(
      `Shields has been retired from NemoClaw. This release has no Shields commands or supported Shields posture.${affected}${unresolved}${noticeOnly}${recovery}`,
    );
  }
  return { affectedSandboxes: names, hasUnattributedRecoveryState };
}

export function enforceRemovedImmutabilityMigrationBoundary(
  sandboxName: string,
  options: {
    readonly allowStateRecord?: boolean;
    readonly stateDir?: string;
  } = {},
): RemovedImmutabilityMigrationInspection {
  const activeStateDir = path.resolve(options.stateDir ?? resolveNemoclawStateDir());
  const inspection = inspectRemovedImmutabilityMigrationState(sandboxName, activeStateDir);
  if (inspection.recoveryArtifacts.length > 0) {
    const artifacts = inspection.recoveryArtifacts
      .map((artifact) => JSON.stringify(path.resolve(artifact)))
      .join(", ");
    throw new Error(
      [
        `Sandbox '${sandboxName}' still has recovery artifacts from the removed Shields feature. Active NemoClaw state directory: ${JSON.stringify(activeStateDir)}. Blocking paths to quarantine: ${artifacts}.`,
        "NemoClaw will not interpret or delete them because an older detached process may still hold mutation authority.",
        "Reboot the host before any older NemoClaw binary can restart; stopping processes without a reboot is not sufficient authority-stop proof.",
        `After reboot, back up each listed blocking path, then move the original whole path into a quarantine directory outside ${JSON.stringify(activeStateDir)} without deleting, editing, or interpreting its contents. A printed provider path can be a whole transaction directory; move that whole directory.`,
        "If reboot or complete quarantine cannot be completed, leave every blocking path untouched and do not mutate any sandbox. A different requested sandbox name does not make unresolved legacy authority safe. Only after every listed path is outside the active state directory may you retry rebuild or recreate.",
      ].join(" "),
    );
  }
  if (inspection.stateRecord && options.allowStateRecord !== true) {
    throw new Error(
      [
        `Sandbox '${sandboxName}' has a state record from the removed Shields feature. Its current mutable posture cannot be proven.`,
        "Shields has been retired and this release has no command that can restore or lower that posture.",
        "Create a trusted snapshot or backup, then use the supported rebuild/recreate path before other mutations.",
      ].join(" "),
    );
  }
  return inspection;
}

export function retireRemovedImmutabilityStateRecord(
  sandboxName: string,
  verifiedDisposition: "mutable-rebuild" | "sandbox-destroyed",
  stateDir = resolveNemoclawStateDir(),
): boolean {
  if (!isMcpLifecycleLockHeld(sandboxName)) {
    throw new Error(
      `Cannot retire removed Shields state for '${sandboxName}' without its lifecycle lock`,
    );
  }
  const inspection = inspectRemovedImmutabilityMigration(sandboxName, stateDir);
  if (inspection.recoveryArtifacts.length > 0) {
    throw new Error(
      `Cannot retire removed Shields state for '${sandboxName}' while recovery artifacts remain`,
    );
  }
  if (!inspection.stateRecord) return false;

  const opened = openRegularFileNoFollow(inspection.stateRecord);
  let quarantined: ReturnType<typeof openRegularFileNoFollow> | null = null;
  const quarantinePath = path.join(
    stateDir,
    `.removed-immutability-${sandboxName}-${crypto.randomUUID()}.quarantine`,
  );
  try {
    // The caller reaches this point only after a successful mutable rebuild or
    // exact sandbox destruction. Holding the lifecycle lock excludes the old
    // timer path while the exact no-follow record is retired.
    const original = opened.stat();
    fs.renameSync(inspection.stateRecord, quarantinePath);
    quarantined = openRegularFileNoFollow(quarantinePath);
    const moved = quarantined.stat();
    if (moved.dev !== original.dev || moved.ino !== original.ino) {
      if (!entryExists(inspection.stateRecord)) {
        fs.renameSync(quarantinePath, inspection.stateRecord);
      }
      throw new Error(
        `Removed Shields state changed before exact retirement after ${verifiedDisposition}`,
      );
    }
    fs.unlinkSync(quarantinePath);
    if (entryExists(quarantinePath)) {
      throw new Error(`Removed Shields state quarantine survived ${verifiedDisposition}`);
    }
    const directoryFd = fs.openSync(stateDir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    quarantined?.close();
    opened.close();
  }
  return true;
}
