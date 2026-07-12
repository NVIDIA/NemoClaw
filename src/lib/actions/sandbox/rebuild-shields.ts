// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { RD as _RD, G, R, YW } from "../../cli/terminal-style";
import * as shields from "../../shields";

export interface RebuildShieldsWindow {
  relocked: boolean;
  wasLocked: boolean;
}

export function openRebuildShieldsWindow(
  sandboxName: string,
  cliName: string,
): RebuildShieldsWindow | null {
  const window = {
    relocked: false,
    wasLocked: !shields.isShieldsDown(sandboxName),
  };
  if (!window.wasLocked) return window;

  console.log("");
  console.log(`  ${YW}Shields are UP${R} — temporarily unlocking for rebuild backup...`);
  try {
    shields.shieldsDown(sandboxName, {
      reason: "auto-unlock for rebuild",
      // Rebuild owns the normal close path, while the bounded timer remains
      // recovery authority if the host process is killed mid-backup/recreate.
      timeout: "30m",
      throwOnError: true,
      // The timer's deadline remains authoritative if rebuild dies, but it
      // must not lock a replacement halfway through an active recreate. The
      // exact rebuild PID/start identity acts as a renewable liveness lease;
      // after owner death the timer retries until restoration can complete.
      deferAutoRestoreWhileOwnerAlive: true,
      // Existing Hermes sandboxes may predate the sealed root-guard protocol.
      // This narrowly scoped rebuild path may use the descriptor-safe legacy
      // transition so the old image can be backed up and replaced. Interactive
      // shields commands remain fail-closed and require the rebuild.
      allowLegacyHermesProtocol: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(`  ${_RD}Failed to auto-unlock shields:${R} ${message}`);
    console.error("  Sandbox is untouched — no data was lost.");
    console.error(
      `  Correct the reported issue, then retry \`${cliName} ${sandboxName} rebuild\`.`,
    );
    console.error(
      "  If the trusted config posture cannot be recovered, restore a trusted backup and recreate the sandbox.",
    );
    return null;
  }
  return window;
}

export function printRebuildShieldsRecovery(
  sandboxName: string,
  window: RebuildShieldsWindow,
  cliName: string,
): void {
  if (!window.wasLocked) return;
  console.error(`    4. Restore shields lockdown:`);
  console.error(`       ${cliName} ${sandboxName} shields up`);
}

export function relockRebuildShieldsWindow(
  sandboxName: string,
  window: RebuildShieldsWindow,
  sandboxStillExists: boolean,
  cliName: string,
): boolean {
  if (!window.wasLocked || window.relocked) return true;
  if (!sandboxStillExists) {
    console.warn("");
    console.warn(`  ${YW}⚠${R} Cannot re-apply shields lockdown — sandbox no longer exists.`);
    console.warn(
      `  After recovery, run \`${cliName} ${sandboxName} shields up\` to restore lockdown.`,
    );
    return false;
  }

  console.log("");
  console.log("  Re-applying shields lockdown...");
  try {
    shields.shieldsUp(sandboxName, {
      throwOnError: true,
      allowLegacyHermesProtocol: true,
    });
    console.log(`  ${G}✓${R} Shields restored to UP`);
    window.relocked = true;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${YW}⚠${R} Failed to re-apply shields lockdown: ${message}`);
    console.error(
      `  Retry \`${cliName} ${sandboxName} rebuild\` after correcting the reported issue. If lockdown cannot be restored, recover from a trusted backup and recreate the sandbox.`,
    );
    return false;
  }
}
