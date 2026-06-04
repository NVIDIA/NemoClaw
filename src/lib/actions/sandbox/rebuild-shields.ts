// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { G, R, RD as _RD, YW } from "../../cli/terminal-style";
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
      skipTimer: true,
      throwOnError: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error(`  ${_RD}Failed to auto-unlock shields:${R} ${message}`);
    console.error("  Sandbox is untouched — no data was lost.");
    console.error(
      `  Run \`${cliName} ${sandboxName} shields down\` manually, then retry rebuild.`,
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
    console.warn(
      `  ${YW}⚠${R} Cannot re-apply shields lockdown — sandbox no longer exists.`,
    );
    console.warn(
      `  After recovery, run \`${cliName} ${sandboxName} shields up\` to restore lockdown.`,
    );
    return false;
  }

  console.log("");
  console.log("  Re-applying shields lockdown...");
  try {
    shields.shieldsUp(sandboxName, { throwOnError: true });
    console.log(`  ${G}✓${R} Shields restored to UP`);
    window.relocked = true;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${YW}⚠${R} Failed to re-apply shields lockdown: ${message}`);
    console.error(
      `  Run \`${cliName} ${sandboxName} shields up\` manually to restore lockdown.`,
    );
    return false;
  }
}
