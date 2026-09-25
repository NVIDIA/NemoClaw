// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { G, R, YW } from "../../cli/terminal-style";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildLog } from "./rebuild-credential-preflight";
import {
  abortUnregisteredOpenClawPostRestoreDoctor,
  beginUnregisteredOpenClawBackupQuiesce,
  beginUnregisteredOpenClawPostRestoreDoctor,
  promoteUnregisteredOpenClawBackupQuiesceToPostRestoreDoctor,
  type OpenClawPostRestoreDoctorWindow,
} from "./runtime/openclaw-lifecycle";
import * as snapshotRestore from "./snapshot/restore-authority";

export interface RebuildRestorePhaseInput {
  sandboxName: string;
  targetAgentType: string;
  targetImageIsCustom: boolean;
  backupManifest: RebuildBackupManifest;
  reconcileManagedDcodeObservability?: boolean;
  runtimeSelection?: OpenShellRuntimeSelection;
  log: RebuildLog;
}

export interface RebuildRestorePhaseResult {
  restoreSucceeded: boolean;
  openClawDoctorWindow?: OpenClawPostRestoreDoctorWindow;
}

/** Restore sandbox files. The replacement already received the captured live OpenShell policy. */
export async function runRebuildRestorePhase(
  input: RebuildRestorePhaseInput,
): Promise<RebuildRestorePhaseResult> {
  const { sandboxName, targetAgentType, backupManifest, runtimeSelection, log } = input;
  let restoreSucceeded = true;
  let openClawDoctorWindow: OpenClawPostRestoreDoctorWindow | undefined;
  if (targetAgentType === "openclaw") {
    log("Entering verified OpenClaw pre-restore quiesce window");
    const doctorWindow = await beginUnregisteredOpenClawBackupQuiesce(
      sandboxName,
      runtimeSelection,
    );
    log(`Pre-restore quiesce window: ${doctorWindow.ok ? "verified" : doctorWindow.stage}`);
    if (!doctorWindow.ok) {
      console.error(
        `  ${YW}OpenClaw state restore could not enter its gateway-down maintenance window.${R}`,
      );
      return { restoreSucceeded: false };
    }
    openClawDoctorWindow = doctorWindow.window;
  }
  if (backupManifest) {
    console.log("");
    console.log("  Restoring workspace state...");
    let restore: Awaited<
      ReturnType<typeof snapshotRestore.restoreRecreatedSandboxStateWithManagedAuthority>
    >;
    try {
      restore = await snapshotRestore.restoreRecreatedSandboxStateWithManagedAuthority(
        sandboxName,
        backupManifest,
        {
          targetAgentType,
          ...(runtimeSelection ? { runtimeSelection } : {}),
        },
        { getSandbox: (name) => loadRegistry().sandboxes[name] ?? null },
      );
    } catch (error) {
      if (openClawDoctorWindow) {
        await abortUnregisteredOpenClawPostRestoreDoctor(openClawDoctorWindow);
      }
      throw error;
    }
    log(
      `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}${restore.error ? `; error=${restore.error}` : ""}`,
    );
    restoreSucceeded = restore.success;
    if (!restore.success) {
      if (openClawDoctorWindow) {
        await abortUnregisteredOpenClawPostRestoreDoctor(openClawDoctorWindow);
        openClawDoctorWindow = undefined;
      }
      if (restore.error) console.error(`  Restore blocked: ${restore.error}`);
      console.error(`  ${YW}Partial restore:${R} ${restore.restoredDirs.join(", ") || "none"}`);
      console.error(`  Manual restore available from: ${backupManifest.backupPath}`);
    } else if (restoreSucceeded) {
      console.log(
        `  ${G}✓${R} State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    }
  }
  if (targetAgentType === "openclaw" && openClawDoctorWindow) {
    const quiesceWindow = openClawDoctorWindow;
    log("Promoting restored OpenClaw state into the post-upgrade doctor window");
    const promoted =
      await promoteUnregisteredOpenClawBackupQuiesceToPostRestoreDoctor(quiesceWindow);
    const doctorWindow = promoted.ok
      ? promoted
      : await beginUnregisteredOpenClawPostRestoreDoctor(sandboxName, runtimeSelection);
    log(`Post-restore doctor window: ${doctorWindow.ok ? "verified" : doctorWindow.stage}`);
    if (!doctorWindow.ok) {
      await abortUnregisteredOpenClawPostRestoreDoctor(quiesceWindow);
      console.error(
        `  ${YW}OpenClaw restored state could not enter its post-upgrade doctor window.${R}`,
      );
      return { restoreSucceeded: false };
    }
    openClawDoctorWindow = doctorWindow.window;
  }
  return {
    restoreSucceeded,
    ...(openClawDoctorWindow ? { openClawDoctorWindow } : {}),
  };
}
