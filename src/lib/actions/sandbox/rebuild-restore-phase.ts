// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import { G, R, YW } from "../../cli/terminal-style";
import * as policies from "../../policy";
import * as sandboxState from "../../state/sandbox";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildLog } from "./rebuild-credential-preflight";

export interface RebuildRestorePhaseInput {
  sandboxName: string;
  backupManifest: RebuildBackupManifest;
  policyPresets: string[];
  log: RebuildLog;
}

export interface RebuildRestorePhaseResult {
  restoreSucceeded: boolean;
  restoredPresets: string[];
  failedPresets: string[];
}

/**
 * Restore preserved workspace state and gateway-owned built-in policy presets.
 * Boundary coverage: rebuild-flow.test.ts exercises full/partial state restore,
 * stale recovery, successful presets, and incomplete preset recovery reporting.
 */
export function runRebuildRestorePhase(input: RebuildRestorePhaseInput): RebuildRestorePhaseResult {
  const { sandboxName, backupManifest, policyPresets, log } = input;
  let restoreSucceeded = true;
  if (backupManifest) {
    console.log("");
    console.log("  Restoring workspace state...");
    log(`Restoring from: ${backupManifest.backupPath} into sandbox: ${sandboxName}`);
    const restore = sandboxState.restoreSandboxState(sandboxName, backupManifest.backupPath);
    log(
      `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}`,
    );
    restoreSucceeded = restore.success;
    if (!restore.success) {
      console.error(`  Partial restore: ${restore.restoredDirs.join(", ") || "none"}`);
      console.error(`  Failed: ${restore.failedDirs.join(", ")}`);
      if (restore.failedFiles.length > 0) {
        console.error(`  Failed files: ${restore.failedFiles.join(", ")}`);
      }
      console.error(`  Manual restore available from: ${backupManifest.backupPath}`);
    } else {
      console.log(
        `  ${G}\u2713${R} State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    }
  }

  const restoredPresets: string[] = [];
  const failedPresets: string[] = [];
  if (policyPresets.length > 0) {
    console.log("");
    console.log("  Restoring policy presets...");
    log(`Policy presets to restore: [${policyPresets.join(",")}]`);
    for (const presetName of policyPresets) {
      try {
        log(`Applying preset: ${presetName}`);
        const applied = policies.applyPreset(sandboxName, presetName);
        if (applied) restoredPresets.push(presetName);
        else failedPresets.push(presetName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Failed to apply preset '${presetName}': ${message}`);
        failedPresets.push(presetName);
      }
    }
    if (restoredPresets.length > 0) {
      console.log(`  ${G}\u2713${R} Policy presets restored: ${restoredPresets.join(", ")}`);
    }
    if (failedPresets.length > 0) {
      console.error(`  ${YW}\u26a0${R} Failed to restore presets: ${failedPresets.join(", ")}`);
      console.error(`    Re-apply manually with: ${CLI_NAME} ${sandboxName} policy-add`);
    }
  }

  return { restoreSucceeded, restoredPresets, failedPresets };
}
