// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as sandboxState from "../state/sandbox";

export interface NotReadyRecreateInput {
  sandboxName: string;
  installerRestoreOnRecreate: boolean;
  latestBackupPath: string | null;
}

export type NotReadyRecreateDecision =
  | { kind: "exit" }
  | {
      kind: "recreate";
      restoreBackupPath: string | null;
      note: string;
    };

export function decideNonInteractiveNotReadyAction(
  input: NotReadyRecreateInput,
): NotReadyRecreateDecision {
  if (!input.installerRestoreOnRecreate) {
    return { kind: "exit" };
  }
  if (input.latestBackupPath) {
    return {
      kind: "recreate",
      restoreBackupPath: input.latestBackupPath,
      note: `  Sandbox '${input.sandboxName}' exists but is not ready — recreating and restoring pre-upgrade backup.`,
    };
  }
  return {
    kind: "recreate",
    restoreBackupPath: null,
    note: `  Sandbox '${input.sandboxName}' exists but is not ready — recreating (no pre-upgrade backup found).`,
  };
}

export class NotReadySandboxError extends Error {
  readonly sandboxName: string;
  readonly hints: readonly string[];

  constructor(sandboxName: string) {
    super(`Sandbox '${sandboxName}' already exists but is not ready.`);
    this.name = "NotReadySandboxError";
    this.sandboxName = sandboxName;
    this.hints = [
      `  Sandbox '${sandboxName}' already exists but is not ready.`,
      "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.",
    ];
  }
}

export function installerRestoreOnRecreateFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE === "1";
}

export interface PreUpgradeBackupSelectInput {
  liveExists: boolean;
  hasExistingRegistryEntry: boolean;
  sandboxName: string;
  note: (message: string) => void;
}

export function selectPreUpgradeBackupForCreate(input: PreUpgradeBackupSelectInput): string | null {
  // Source-of-truth review for the two drift returns below:
  //   invalid state         = registry/gateway inconsistency (a registry entry
  //                           exists while the gateway still reports the sandbox
  //                           live, or the registry has no entry at all).
  //   source boundary       = pruneStaleSandboxEntry is best-effort and the
  //                           gateway may be mid-recreate, so the two stores can
  //                           disagree at this point.
  //   source-fix constraint = a real fix needs atomic registry/gateway sync,
  //                           which is out of scope for this PR.
  //   regression test       = selectPreUpgradeBackupForCreate returns null when
  //                           liveExists=true and when hasExistingRegistryEntry=false
  //                           (see not-ready-recreate.test.ts).
  //   removal condition     = drop these guards once registry/gateway sync is atomic.
  if (input.liveExists) {
    console.debug(
      `  Registry entry exists for '${input.sandboxName}' but gateway reports sandbox live — skipping pre-upgrade backup select.`,
    );
    return null;
  }
  if (!input.hasExistingRegistryEntry) {
    console.debug(
      `  No registry entry for '${input.sandboxName}' — skipping pre-upgrade backup select.`,
    );
    return null;
  }
  // Installer contract: the installer MUST set
  // NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE=1 after a successful pre-upgrade
  // backup. A missing flag alongside an existing registry entry means the
  // expected installer signal never arrived (installer bug, partial upgrade, or
  // manual intervention); making the installer always set the flag is a
  // separate PR.
  if (!installerRestoreOnRecreateFromEnv(process.env)) {
    console.warn(
      `  Registry entry exists for '${input.sandboxName}' but installer restore flag not set — skipping pre-upgrade backup select.`,
    );
    return null;
  }
  const latest = sandboxState.getLatestBackup(input.sandboxName);
  if (latest?.backupPath) {
    input.note(
      `  Found pre-upgrade backup for '${input.sandboxName}'; it will be restored after recreation.`,
    );
    return latest.backupPath;
  }
  // A guaranteed pre-upgrade backup is out of scope: the backup may have been
  // manually deleted, the disk may be full, or a prior upgrade attempt may have
  // removed it. Warn about the hidden data-loss risk and continue with fresh state.
  console.warn(
    `  Installer requested restore but no pre-upgrade backup found for '${input.sandboxName}' — recreated sandbox will start fresh.`,
  );
  input.note(
    `  No pre-upgrade backup found for '${input.sandboxName}'. Recreated sandbox will start with fresh state.`,
  );
  return null;
}

export function applyNonInteractiveNotReadyDecision(
  sandboxName: string,
  note: (message: string) => void,
): string | null {
  const installerRestoreOnRecreate = installerRestoreOnRecreateFromEnv(process.env);
  const latest = installerRestoreOnRecreate ? sandboxState.getLatestBackup(sandboxName) : null;
  const decision = decideNonInteractiveNotReadyAction({
    sandboxName,
    installerRestoreOnRecreate,
    latestBackupPath: latest?.backupPath ?? null,
  });
  if (decision.kind === "exit") {
    throw new NotReadySandboxError(sandboxName);
  }
  // Same out-of-scope rationale as selectPreUpgradeBackupForCreate: when the
  // installer requested a restore but no backup exists, the recreate proceeds
  // without one. Surface the hidden data-loss risk instead of failing silently.
  if (installerRestoreOnRecreate && decision.restoreBackupPath === null) {
    console.warn(
      `  Installer requested restore but no pre-upgrade backup found for '${sandboxName}' — recreated sandbox will start fresh.`,
    );
  }
  note(decision.note);
  return decision.restoreBackupPath;
}

export type NonInteractiveNotReadyOutcome =
  | { kind: "proceed"; restoreBackupPath: string | null }
  | { kind: "blocked"; hints: readonly string[] };

// CLI entry points own process.exit; this keeps applyNonInteractiveNotReadyDecision
// throw-based (and unit-testable without mocking process.exit) while giving
// onboard.ts a plain value to branch on for the exit itself.
export function resolveNotReadyOutcome(
  sandboxName: string,
  note: (message: string) => void,
): NonInteractiveNotReadyOutcome {
  try {
    return {
      kind: "proceed",
      restoreBackupPath: applyNonInteractiveNotReadyDecision(sandboxName, note),
    };
  } catch (error) {
    if (!(error instanceof NotReadySandboxError)) throw error;
    return { kind: "blocked", hints: error.hints };
  }
}
