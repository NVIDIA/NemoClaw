// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { managedDcodeConfigRestorePolicy } from "../state/dcode-config-restore-input";
import type {
  OpenClawImagePluginInstall,
  OpenClawManagedExtensionDiscoveryResult,
} from "../state/openclaw-plugin-restore";
import {
  OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR,
  type RecreatedSandboxRestoreOptions,
  type RestoreResult,
} from "../state/sandbox";
import type { SelectionDrift } from "./selection-drift";

export type CreatedSandboxFinalizationOptions = {
  sandboxName: string;
  restoreBackupPath: string | null;
  preUpgradeBackup: boolean;
  targetAgentType: string;
  discoverOpenClawImagePluginInstalls?: boolean;
  validateManagedDcode: boolean;
  provider: string;
  model: string;
  preferredInferenceApi: string | null;
};

export type CreatedSandboxFinalizationDeps = {
  discoverFreshOpenClawImagePluginInstalls(
    sandboxName: string,
  ): OpenClawManagedExtensionDiscoveryResult;
  restoreRecreatedSandboxState(
    sandboxName: string,
    backupPath: string,
    options: RecreatedSandboxRestoreOptions,
  ): RestoreResult;
  getDcodeSelectionDrift(
    sandboxName: string,
    provider: string,
    model: string,
    preferredInferenceApi: string | null,
  ): SelectionDrift;
  register(openclawImagePluginInstalls?: readonly OpenClawImagePluginInstall[]): void;
  note(message: string): void;
  error(message: string): void;
  exitProcess(code: number): never;
};

/** Restore state and validate the live managed DCode route before registry publication. */
export function finalizeCreatedSandbox(
  options: CreatedSandboxFinalizationOptions,
  deps: CreatedSandboxFinalizationDeps,
): void {
  let freshOpenClawImagePluginInstalls: readonly OpenClawImagePluginInstall[] | undefined;
  if (options.discoverOpenClawImagePluginInstalls === true) {
    const discovery = deps.discoverFreshOpenClawImagePluginInstalls(options.sandboxName);
    if (!discovery.ok) {
      deps.error(
        `  OpenClaw image plugin discovery failed for sandbox '${options.sandboxName}': ${discovery.error}`,
      );
      deps.error("  State was not restored and registry metadata was not updated.");
      deps.error("  Remove the unregistered sandbox before retrying:");
      deps.error(`    openshell sandbox delete ${JSON.stringify(options.sandboxName)}`);
      deps.error("  Then rerun the original `nemoclaw onboard --from <Dockerfile>` command.");
      if (options.restoreBackupPath) deps.error(`  Manual recovery: ${options.restoreBackupPath}`);
      return deps.exitProcess(1);
    }
    freshOpenClawImagePluginInstalls = discovery.pluginInstalls;
  }

  if (options.restoreBackupPath) {
    deps.note(
      options.preUpgradeBackup
        ? "  Restoring workspace state from pre-upgrade backup..."
        : "  Restoring workspace state from pre-recreate backup...",
    );
    const restore = deps.restoreRecreatedSandboxState(
      options.sandboxName,
      options.restoreBackupPath,
      {
        targetAgentType: options.targetAgentType,
        ...(freshOpenClawImagePluginInstalls !== undefined
          ? { freshOpenClawImagePluginInstalls }
          : {}),
        ...(options.validateManagedDcode
          ? { stateFileRestorePolicy: managedDcodeConfigRestorePolicy }
          : {}),
      },
    );
    if (restore.success) {
      deps.note(
        `  ✓ State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    } else {
      if (restore.error === OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR) {
        deps.error(
          `  OpenClaw image plugin provenance validation failed for sandbox '${options.sandboxName}': ${restore.error}`,
        );
        deps.error(
          "  The sandbox still exists, but registry metadata was not updated because a future rebuild would be unsafe.",
        );
        deps.error("  Remove the unregistered sandbox before retrying:");
        deps.error(`    openshell sandbox delete ${JSON.stringify(options.sandboxName)}`);
        deps.error("  Then rerun the original `nemoclaw onboard --from <Dockerfile>` command.");
        deps.error(`  Manual recovery: ${options.restoreBackupPath}`);
        return deps.exitProcess(1);
      }
      // Source-of-truth review:
      // - Invalid state: a fresh sandbox exists after an external workspace copy fails.
      // - Boundary: restore.success owns copy completeness; live validation owns route integrity.
      // - Source-fix constraint: rollback must span sandbox creation and external copies.
      // - Regression: the partial-workspace-restore test validates fresh config before registration.
      // - Removal: drop this fallback when restore failure can roll back sandbox creation atomically.
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
        "  A NemoClaw rebuild is unsafe here because no verified registry metadata exists.",
      );
      deps.error("  Remove the unregistered sandbox before retrying:");
      deps.error(`    openshell sandbox delete ${JSON.stringify(options.sandboxName)}`);
      deps.error("  Then rerun the original `nemoclaw onboard` command.");
      if (options.restoreBackupPath) {
        deps.error(`  Manual recovery: ${options.restoreBackupPath}`);
      }
      return deps.exitProcess(1);
    }
  }

  deps.register(freshOpenClawImagePluginInstalls);
}
