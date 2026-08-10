// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { RD as _RD, G, R, YW } from "../../cli/terminal-style";
import * as shields from "../../shields";
import { isShieldsTimerDeadlineExpired } from "../../state/mcp-lifecycle-lock/shields-timer-authority";

export interface BackupShieldsWindow {
  relocked: boolean;
  wasLocked: boolean;
}

export interface BackupShieldsWindowOptions {
  operation: string;
  reason: string;
  retryCommand: string;
  shieldsUpCommand: string;
  deferAutoRestoreWhileOwnerAlive?: boolean;
  allowLegacyHermesProtocol?: boolean;
}

export function openBackupShieldsWindow(
  sandboxName: string,
  options: BackupShieldsWindowOptions,
): BackupShieldsWindow | null {
  const window = {
    relocked: false,
    wasLocked: !shields.isShieldsDown(sandboxName),
  };
  if (!window.wasLocked) return window;

  console.log("");
  console.log(`  ${YW}Shields are UP${R} — temporarily unlocking for ${options.operation}...`);
  try {
    shields.shieldsDown(sandboxName, {
      reason: options.reason,
      timeout: "30m",
      throwOnError: true,
      ...(options.deferAutoRestoreWhileOwnerAlive ? { deferAutoRestoreWhileOwnerAlive: true } : {}),
      ...(options.allowLegacyHermesProtocol ? { allowLegacyHermesProtocol: true } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(`  ${_RD}Failed to auto-unlock shields:${R} ${message}`);
    console.error("  Sandbox is untouched — no data was lost.");
    console.error(`  Correct the reported issue, then retry \`${options.retryCommand}\`.`);
    console.error(
      "  If the trusted config posture cannot be recovered, restore a trusted backup and recreate the sandbox.",
    );
    return null;
  }
  return window;
}

export function relockBackupShieldsWindow(
  sandboxName: string,
  window: BackupShieldsWindow,
  sandboxStillExists: boolean,
  options: BackupShieldsWindowOptions,
): boolean {
  if (window.relocked) return true;
  // A deferred timer can expire while rebuild owns the lifecycle lock; settle it before success.
  if (!window.wasLocked && !options.deferAutoRestoreWhileOwnerAlive) return true;
  if (!window.wasLocked && !isShieldsTimerDeadlineExpired(sandboxName)) return true;
  if (!sandboxStillExists) {
    console.warn("");
    console.warn(`  ${YW}⚠${R} Cannot re-apply shields lockdown — sandbox no longer exists.`);
    console.warn(`  After recovery, run \`${options.shieldsUpCommand}\` to restore lockdown.`);
    return false;
  }

  console.log("");
  console.log("  Re-applying shields lockdown...");
  try {
    shields.shieldsUp(sandboxName, {
      throwOnError: true,
      ...(options.allowLegacyHermesProtocol ? { allowLegacyHermesProtocol: true } : {}),
    });
    console.log(`  ${G}✓${R} Shields restored to UP`);
    window.relocked = true;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${YW}⚠${R} Failed to re-apply shields lockdown: ${message}`);
    console.error(
      `  Correct the reported issue, then run \`${options.shieldsUpCommand}\` to restore lockdown before retrying \`${options.retryCommand}\`.`,
    );
    console.error(
      "  If lockdown cannot be restored, recover from a trusted backup and recreate the sandbox.",
    );
    return false;
  }
}
