// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../state/registry";
import type { BackupResult } from "../state/sandbox";
import * as sandboxState from "../state/sandbox";

export type SandboxBackupImpl = (sandboxName: string) => BackupResult;

export interface PreRecreateBackupOptions {
  sandboxName: string;
  sandboxEntry?: SandboxEntry | null;
  requireOpenClawImagePluginProvenance?: boolean;
  backupImpl?: SandboxBackupImpl;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
}

export type PreRecreateBackupFailureKind =
  | "none"
  | "partial"
  | "empty"
  | "threw"
  | "plugin-provenance";

export interface PreRecreateBackupResult {
  ok: boolean;
  backup: BackupResult | null;
  failureKind: PreRecreateBackupFailureKind;
  errorMessage?: string;
}

export function backupSandboxBeforeRecreate(
  opts: PreRecreateBackupOptions,
): PreRecreateBackupResult {
  const log = opts.log ?? ((m: string) => console.log(m));
  const errorLog = opts.errorLog ?? ((m: string) => console.error(m));
  const backupImpl = opts.backupImpl ?? sandboxState.backupSandboxState;
  const sandboxEntry = opts.sandboxEntry ?? null;
  const customOpenClaw =
    opts.requireOpenClawImagePluginProvenance === true ||
    (Boolean(sandboxEntry?.fromDockerfile) &&
      (!sandboxEntry?.agent || sandboxEntry.agent === "openclaw"));
  try {
    const backup = backupImpl(opts.sandboxName);
    if (backup.success && backup.manifest?.backupPath) {
      if (
        (customOpenClaw || backup.manifest.reconcileOpenClawImagePluginProvenance === true) &&
        !sandboxState.hasAuthoritativeOpenClawImagePluginProvenance(backup.manifest)
      ) {
        errorLog(
          "  Custom-image OpenClaw plugin provenance is missing; aborting recreate before delete.",
        );
        errorLog(
          "  Keep the sandbox and backup untouched; onboard under a new name and manually migrate user-owned state.",
        );
        errorLog(
          "  Or take an independent manual backup, then explicitly accept destructive recreation with NEMOCLAW_RECREATE_WITHOUT_BACKUP=1.",
        );
        return { ok: false, backup, failureKind: "plugin-provenance" };
      }
      log(
        `  ✓ State backed up (${backup.backedUpDirs.length} directories, ${backup.backedUpFiles.length} files)`,
      );
      return { ok: true, backup, failureKind: "none" };
    }
    if (backup.backedUpDirs.length > 0 || backup.backedUpFiles.length > 0) {
      errorLog(
        `  Partial backup: ${backup.backedUpDirs.length} dirs / ${backup.backedUpFiles.length} files saved; ${backup.failedDirs.length} dirs / ${backup.failedFiles.length} files failed.`,
      );
      errorLog("  Aborting recreate — failed entries would be lost on delete.");
      return { ok: false, backup, failureKind: "partial" };
    }
    errorLog("  State backup failed — aborting recreate to prevent data loss.");
    if (backup.error) errorLog(`  Reason: ${backup.error}`);
    return { ok: false, backup: null, failureKind: "empty" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog(`  State backup threw: ${message} — aborting recreate.`);
    return { ok: false, backup: null, failureKind: "threw", errorMessage: message };
  }
}

export function shouldSkipPreRecreateBackup(env: NodeJS.ProcessEnv): boolean {
  return env.NEMOCLAW_RECREATE_WITHOUT_BACKUP === "1";
}
