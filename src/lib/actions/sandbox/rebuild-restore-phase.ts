// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { G, R, YW } from "../../cli/terminal-style";
import * as sandboxConfig from "../../sandbox/config";
import { load as loadRegistry } from "../../state/registry/persistence";
import { readHermesOperatorConfigHandoff } from "../../state/sandbox";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildLog } from "./rebuild-credential-preflight";
import {
  applyHermesOperatorConfigSnapshot,
  type HermesOperatorConfigRestoreReport,
  parseHermesOperatorConfigSnapshot,
  verifyHermesOperatorConfigSnapshot,
} from "./rebuild-durable-config";
import * as snapshotRestore from "./snapshot/restore-authority";

export interface RebuildRestorePhaseInput {
  sandboxName: string;
  targetAgentType: string;
  targetImageIsCustom: boolean;
  backupManifest: RebuildBackupManifest;
  reconcileManagedDcodeObservability?: boolean;
  log: RebuildLog;
}

export interface RebuildRestorePhaseResult {
  restoreSucceeded: boolean;
  hermesOperatorConfigRestore?: HermesOperatorConfigRestoreReport;
}

const EMPTY_HERMES_OPERATOR_CONFIG_RESTORE: HermesOperatorConfigRestoreReport = {
  restoredKeys: [],
  droppedKeys: [],
};

function restoreHermesOperatorConfig(
  sandboxName: string,
  backupManifest: RebuildBackupManifest,
  log: RebuildLog,
): { success: boolean; report: HermesOperatorConfigRestoreReport } {
  if (!backupManifest?.hermesOperatorConfigHandoff) {
    return { success: true, report: EMPTY_HERMES_OPERATOR_CONFIG_RESTORE };
  }
  const document = readHermesOperatorConfigHandoff(backupManifest);
  const snapshot = document ? parseHermesOperatorConfigSnapshot(document, sandboxName) : null;
  if (!snapshot) {
    log("Hermes operator config handoff failed digest or schema validation");
    console.error(`  ${YW}Hermes operator config restore blocked:${R} invalid rebuild handoff`);
    return { success: false, report: EMPTY_HERMES_OPERATOR_CONFIG_RESTORE };
  }
  if (snapshot.entries.length === 0) {
    return {
      success: true,
      report: { restoredKeys: [], droppedKeys: snapshot.droppedKeys },
    };
  }

  try {
    const target = sandboxConfig.resolveAgentConfig(sandboxName);
    if (target.agentName !== "hermes") {
      throw new Error(`replacement config target is '${target.agentName}'`);
    }
    const current = sandboxConfig.readSandboxConfig(sandboxName, target);
    const merged = applyHermesOperatorConfigSnapshot(current, snapshot);
    sandboxConfig.writeSandboxConfig(sandboxName, target, merged);
    const verified = sandboxConfig.readSandboxConfig(sandboxName, target);
    const report = verifyHermesOperatorConfigSnapshot(verified, snapshot);
    const failedRestores = report.droppedKeys.filter((key) => !snapshot.droppedKeys.includes(key));
    log(
      `Hermes operator config restore: restored=${report.restoredKeys.join(",") || "none"}; dropped=${report.droppedKeys.join(",") || "none"}`,
    );
    return { success: failedRestores.length === 0, report };
  } catch (error) {
    const report = {
      restoredKeys: [],
      droppedKeys: [
        ...new Set([...snapshot.droppedKeys, ...snapshot.entries.map((entry) => entry.key)]),
      ].sort(),
    };
    log(
      `Hermes operator config restore failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(`  ${YW}Hermes operator config restore failed.${R}`);
    return { success: false, report };
  }
}

/** Restore sandbox files. The replacement already received the captured live OpenShell policy. */
export function runRebuildRestorePhase(input: RebuildRestorePhaseInput): RebuildRestorePhaseResult {
  const { sandboxName, targetAgentType, targetImageIsCustom, backupManifest, log } = input;
  let restoreSucceeded = true;
  let hermesOperatorConfigRestore: {
    success: boolean;
    report: HermesOperatorConfigRestoreReport;
  } | null = null;
  if (backupManifest) {
    console.log("");
    console.log("  Restoring workspace state...");
    const restore = snapshotRestore.restoreRecreatedSandboxStateWithManagedAuthority(
      sandboxName,
      backupManifest,
      {
        targetAgentType,
        ...(targetImageIsCustom ? { allowCustomImageWholeStateFileRestore: true } : {}),
      },
      { getSandbox: (name) => loadRegistry().sandboxes[name] ?? null },
    );
    log(
      `Restore result: success=${restore.success}, restored=${restore.restoredDirs.join(",")}; files=${restore.restoredFiles.join(",")}, failed=${restore.failedDirs.join(",")}; failedFiles=${restore.failedFiles.join(",")}${restore.error ? `; error=${restore.error}` : ""}`,
    );
    restoreSucceeded = restore.success;
    hermesOperatorConfigRestore =
      targetAgentType === "hermes"
        ? restoreHermesOperatorConfig(sandboxName, backupManifest, log)
        : null;
    if (hermesOperatorConfigRestore && !hermesOperatorConfigRestore.success) {
      restoreSucceeded = false;
    }
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
  if (targetAgentType === "hermes" && hermesOperatorConfigRestore === null) {
    hermesOperatorConfigRestore = {
      success: true,
      report: EMPTY_HERMES_OPERATOR_CONFIG_RESTORE,
    };
  }
  return {
    restoreSucceeded,
    ...(hermesOperatorConfigRestore
      ? { hermesOperatorConfigRestore: hermesOperatorConfigRestore.report }
      : {}),
  };
}
