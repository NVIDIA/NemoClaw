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

function installerRestoreOnRecreateFromEnv(): boolean {
  return process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE === "1";
}

export interface PreUpgradeBackupSelectInput {
  liveExists: boolean;
  hasExistingRegistryEntry: boolean;
  sandboxName: string;
  note: (message: string) => void;
}

export function selectPreUpgradeBackupForCreate(input: PreUpgradeBackupSelectInput): string | null {
  if (input.liveExists || !input.hasExistingRegistryEntry) return null;
  if (!installerRestoreOnRecreateFromEnv()) return null;
  const latest = sandboxState.getLatestBackup(input.sandboxName);
  if (latest?.backupPath) {
    input.note(
      `  Found pre-upgrade backup for '${input.sandboxName}'; it will be restored after recreation.`,
    );
    return latest.backupPath;
  }
  input.note(
    `  No pre-upgrade backup found for '${input.sandboxName}'. Recreated sandbox will start with fresh state.`,
  );
  return null;
}

export function applyNonInteractiveNotReadyDecision(
  sandboxName: string,
  note: (message: string) => void,
): string | null {
  const installerRestoreOnRecreate = installerRestoreOnRecreateFromEnv();
  const latest = installerRestoreOnRecreate ? sandboxState.getLatestBackup(sandboxName) : null;
  const decision = decideNonInteractiveNotReadyAction({
    sandboxName,
    installerRestoreOnRecreate,
    latestBackupPath: latest?.backupPath ?? null,
  });
  if (decision.kind === "exit") {
    console.error(`  Sandbox '${sandboxName}' already exists but is not ready.`);
    console.error("  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.");
    process.exit(1);
  }
  note(decision.note);
  return decision.restoreBackupPath;
}
