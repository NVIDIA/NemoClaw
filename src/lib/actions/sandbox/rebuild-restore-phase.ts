// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { G, R, YW } from "../../cli/terminal-style";
import * as sandboxConfig from "../../sandbox/config";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildLog } from "./rebuild-credential-preflight";
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
}

/** Restore sandbox files. The replacement already received the captured live OpenShell policy. */
export function runRebuildRestorePhase(input: RebuildRestorePhaseInput): RebuildRestorePhaseResult {
  const {
    sandboxName,
    targetAgentType,
    targetImageIsCustom,
    backupManifest,
    runtimeSelection,
    log,
  } = input;
  let restoreSucceeded = true;
  if (backupManifest) {
    console.log("");
    console.log("  Restoring workspace state...");
    const restore = snapshotRestore.restoreRecreatedSandboxStateWithManagedAuthority(
      sandboxName,
      backupManifest,
      {
        targetAgentType,
        ...(targetImageIsCustom ? { allowCustomImageWholeStateFileRestore: true } : {}),
        ...(runtimeSelection ? { runtimeSelection } : {}),
      },
      { getSandbox: (name) => loadRegistry().sandboxes[name] ?? null },
    );
    log(
      `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}${restore.error ? `; error=${restore.error}` : ""}`,
    );
    restoreSucceeded = restore.success;
    if (
      targetAgentType === "hermes" &&
      restore.restoredDirs.some(
        (directory) => directory === "dashboard-home" || directory === "profiles",
      )
    ) {
      const target = sandboxConfig.resolveAgentConfig(sandboxName);
      const seeded =
        target.agentName === "hermes"
          ? sandboxConfig.restoreHermesDashboardConfig(sandboxName, target)
          : "failed";
      log(`Hermes dashboard state after restore: ${seeded}`);
      if (seeded === "failed") restoreSucceeded = false;
    }
    if (!restore.success) {
      if (restore.error) console.error(`  Restore blocked: ${restore.error}`);
      console.error(`  ${YW}Partial restore:${R} ${restore.restoredDirs.join(", ") || "none"}`);
      console.error(`  Manual restore available from: ${backupManifest.backupPath}`);
    } else if (restoreSucceeded) {
      console.log(
        `  ${G}✓${R} State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    }
  }
  return {
    restoreSucceeded,
  };
}
