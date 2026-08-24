// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type BackupShieldsWindow,
  openBackupShieldsWindow,
  relockBackupShieldsWindow,
} from "./backup-shields-window";
import type { SandboxPolicyAuthority } from "../../adapters/openshell/policy-authority";
import * as shields from "../../shields";

export type RebuildShieldsWindow = BackupShieldsWindow & {
  policyAuthority?: SandboxPolicyAuthority;
  sourceDeleted?: boolean;
};

function rebuildShieldsWindowOptions(sandboxName: string, cliName: string) {
  return {
    operation: "rebuild backup",
    reason: "auto-unlock for rebuild",
    retryCommand: `${cliName} ${sandboxName} rebuild`,
    shieldsUpCommand: `${cliName} ${sandboxName} shields up`,
    // The timer's deadline remains authoritative if rebuild dies, but it
    // must not lock a replacement halfway through an active recreate. The
    // exact rebuild PID/start identity acts as a renewable liveness lease;
    // after owner death the timer retries until restoration can complete.
    deferAutoRestoreWhileOwnerAlive: true,
    // Existing Hermes sandboxes may predate the sealed root-guard protocol.
    // Only the replacement flow may use this descriptor-safe compatibility
    // transition; ordinary backup-all keeps the strict current protocol.
    allowLegacyHermesProtocol: true,
  };
}

export function openRebuildShieldsWindow(
  sandboxName: string,
  cliName: string,
  policyAuthority: SandboxPolicyAuthority = "nemoclaw-managed",
): RebuildShieldsWindow | null {
  if (policyAuthority === "externally-managed") {
    return {
      policyAuthority,
      relocked: false,
      sourceDeleted: false,
      wasLocked: !shields.isShieldsDown(sandboxName),
    };
  }
  const window = openBackupShieldsWindow(
    sandboxName,
    rebuildShieldsWindowOptions(sandboxName, cliName),
  );
  return window ? { ...window, policyAuthority, sourceDeleted: false } : null;
}

export function openAbsentRebuildShieldsWindow(
  sandboxName: string,
  policyAuthority: SandboxPolicyAuthority,
): { staleSandboxWasLocked: boolean; window: RebuildShieldsWindow } {
  const wasLocked = !shields.isShieldsDown(sandboxName);
  if (policyAuthority === "externally-managed") {
    return {
      staleSandboxWasLocked: false,
      window: { policyAuthority, relocked: false, sourceDeleted: true, wasLocked },
    };
  }
  return {
    staleSandboxWasLocked: wasLocked,
    window: { policyAuthority, relocked: false, sourceDeleted: true, wasLocked: false },
  };
}

export function markRebuildShieldsSourceDeleted(window: RebuildShieldsWindow): void {
  window.sourceDeleted = true;
}

export function printRebuildShieldsRecovery(
  sandboxName: string,
  window: RebuildShieldsWindow,
  cliName: string,
): void {
  if (!window.wasLocked) return;
  if (window.policyAuthority === "externally-managed") {
    console.error("    4. Retry the rebuild to rebind the retained config lockdown.");
    return;
  }
  console.error(`    4. Restore shields lockdown:`);
  console.error(`       ${cliName} ${sandboxName} shields up`);
}

export function relockRebuildShieldsWindow(
  sandboxName: string,
  window: RebuildShieldsWindow,
  sandboxStillExists: boolean,
  cliName: string,
): boolean {
  if (window.policyAuthority === "externally-managed") {
    if (window.relocked) return true;
    if (!window.wasLocked || window.sourceDeleted !== true) {
      window.relocked = true;
      return true;
    }
    if (!sandboxStillExists) {
      console.error(
        `  Cannot rebind the retained config lockdown because sandbox '${sandboxName}' is absent.`,
      );
      return false;
    }
    try {
      shields.rebindReplacementConfigLock(sandboxName, true);
      window.relocked = true;
      return true;
    } catch (error) {
      console.error(
        `  Failed to rebind the retained config lockdown: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
  return relockBackupShieldsWindow(
    sandboxName,
    window,
    sandboxStillExists,
    rebuildShieldsWindowOptions(sandboxName, cliName),
  );
}
