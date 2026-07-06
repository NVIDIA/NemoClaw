// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { managedDcodeConfigRestorePolicy } from "../state/dcode-config-restore-input";
import type { RestoreOptions, RestoreResult } from "../state/sandbox";
import type { SelectionDrift } from "./selection-drift";

export type CreatedSandboxFinalizationOptions = {
  sandboxName: string;
  restoreBackupPath: string | null;
  preUpgradeBackup: boolean;
  validateManagedDcode: boolean;
  provider: string;
  model: string;
  preferredInferenceApi: string | null;
};

export type CreatedSandboxFinalizationDeps = {
  restoreSandboxState(
    sandboxName: string,
    backupPath: string,
    options?: RestoreOptions,
  ): RestoreResult;
  getDcodeSelectionDrift(
    sandboxName: string,
    provider: string,
    model: string,
    preferredInferenceApi: string | null,
  ): SelectionDrift;
  register(): void;
  note(message: string): void;
  error(message: string): void;
  exitProcess(code: number): never;
};

/** Restore state and validate the live managed DCode route before registry publication. */
export function finalizeCreatedSandbox(
  options: CreatedSandboxFinalizationOptions,
  deps: CreatedSandboxFinalizationDeps,
): void {
  if (options.restoreBackupPath) {
    deps.note(
      options.preUpgradeBackup
        ? "  Restoring workspace state from pre-upgrade backup..."
        : "  Restoring workspace state from pre-recreate backup...",
    );
    const restore = deps.restoreSandboxState(
      options.sandboxName,
      options.restoreBackupPath,
      options.validateManagedDcode
        ? { stateFileRestorePolicy: managedDcodeConfigRestorePolicy }
        : undefined,
    );
    if (restore.success) {
      deps.note(
        `  ✓ State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    } else {
      deps.error(`  Warning: partial restore. Manual recovery: ${options.restoreBackupPath}`);
    }
  }

  if (options.validateManagedDcode) {
    const finalSelection = deps.getDcodeSelectionDrift(
      options.sandboxName,
      options.provider,
      options.model,
      options.preferredInferenceApi,
    );
    if (finalSelection.changed || finalSelection.unknown) {
      deps.error(
        `  DCode live model/provider validation failed for sandbox '${options.sandboxName}'. The sandbox still exists, but its live route is unverified and registry metadata was not updated.`,
      );
      deps.error(
        `  To recover, run \`nemoclaw ${options.sandboxName} rebuild\` or repair /sandbox/.deepagents/config.toml before retrying.`,
      );
      if (options.restoreBackupPath) {
        deps.error(`  Manual recovery: ${options.restoreBackupPath}`);
      }
      return deps.exitProcess(1);
    }
  }

  deps.register();
}
