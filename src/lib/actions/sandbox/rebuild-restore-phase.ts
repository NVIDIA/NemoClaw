// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import type { SandboxCommandResult } from "../../adapters/sandbox/command-transport";
import { G, R, YW } from "../../cli/terminal-style";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildLog } from "./rebuild-credential-preflight";
import {
  abortUnregisteredOpenClawPostRestoreDoctor,
  beginUnregisteredOpenClawBackupQuiesce,
  type OpenClawPostRestoreDoctorWindow,
} from "./runtime/openclaw-lifecycle";
import {
  hermesDashboardStateMigrationRecoveryGuidance,
  migrateHermesLegacyDashboardState,
} from "./snapshot-hermes-gateway-hint";
import * as snapshotRestore from "./snapshot/restore-authority";

export interface RebuildRestorePhaseInput {
  sandboxName: string;
  targetAgentType: string;
  backupManifest: RebuildBackupManifest;
  runtimeSelection?: OpenShellRuntimeSelection;
  log: RebuildLog;
  migrateHermesLegacyDashboardState?: (
    sandboxName: string,
    runtimeSelection?: OpenShellRuntimeSelection,
  ) => Promise<SandboxCommandResult | null>;
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
    let hermesDashboardStateMigrationSucceeded = true;
    if (targetAgentType === "hermes" && restore.success) {
      const migrate = input.migrateHermesLegacyDashboardState ?? migrateHermesLegacyDashboardState;
      let migration: SandboxCommandResult | null = null;
      try {
        migration = await migrate(sandboxName, runtimeSelection);
      } catch (error) {
        log(
          `Hermes legacy dashboard-state migration transport failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      hermesDashboardStateMigrationSucceeded = migration?.status === 0;
      log(
        `Hermes legacy dashboard-state migration: ${hermesDashboardStateMigrationSucceeded ? "complete" : `failed${migration ? ` (exit ${migration.status})` : " (transport unavailable)"}`}`,
      );
      if (!hermesDashboardStateMigrationSucceeded) {
        restoreSucceeded = false;
        console.error(`  ${YW}Hermes legacy dashboard-state migration failed.${R}`);
        const detail = migration?.stderr.trim();
        if (detail) console.error(`  ${detail.slice(0, 500)}`);
        console.error(`  ${hermesDashboardStateMigrationRecoveryGuidance(sandboxName)}`);
      }
    }
    if (!restore.success || !hermesDashboardStateMigrationSucceeded) {
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
    log("Keeping restored OpenClaw state in the verified gateway-down maintenance window");
  }
  return {
    restoreSucceeded,
    ...(openClawDoctorWindow ? { openClawDoctorWindow } : {}),
  };
}
