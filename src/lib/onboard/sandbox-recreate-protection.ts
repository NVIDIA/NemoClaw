// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../state/registry";
import * as notReadyRecreate from "./not-ready-recreate";
import {
  backupSandboxBeforeRecreate,
  type PreRecreateBackupResult,
} from "./sandbox-backup-on-recreate";

export interface SandboxRecreateProtectionOptions {
  sandboxName: string;
  sandboxEntry: SandboxEntry | null;
  customOpenClawImage: boolean;
  note(message: string): void;
}

interface SandboxRecreateProtectionDeps {
  selectPreUpgradeBackupForCreate: typeof notReadyRecreate.selectPreUpgradeBackupForCreate;
  resolveNotReadyOutcome: typeof notReadyRecreate.resolveNotReadyOutcome;
  backupSandboxBeforeRecreate: typeof backupSandboxBeforeRecreate;
}

const defaultDeps: SandboxRecreateProtectionDeps = {
  selectPreUpgradeBackupForCreate: notReadyRecreate.selectPreUpgradeBackupForCreate,
  resolveNotReadyOutcome: notReadyRecreate.resolveNotReadyOutcome,
  backupSandboxBeforeRecreate,
};

/** Bind the shared state-preservation checks used by every onboard recreation path. */
export function createSandboxRecreateProtection(
  options: SandboxRecreateProtectionOptions,
  deps: SandboxRecreateProtectionDeps = defaultDeps,
) {
  const { sandboxName, sandboxEntry, customOpenClawImage, note } = options;

  return {
    selectPreUpgradeBackup(liveExists: boolean): string | null {
      return deps.selectPreUpgradeBackupForCreate({
        liveExists,
        hasExistingRegistryEntry: sandboxEntry !== null,
        existingSandboxEntry: sandboxEntry,
        requireOpenClawImagePluginProvenance: customOpenClawImage,
        sandboxName,
        note,
      });
    },
    resolveNotReadyOutcome(): notReadyRecreate.NonInteractiveNotReadyOutcome {
      return deps.resolveNotReadyOutcome(sandboxName, note, sandboxEntry, customOpenClawImage);
    },
    backup(): PreRecreateBackupResult {
      return deps.backupSandboxBeforeRecreate({
        sandboxName,
        sandboxEntry,
        requireOpenClawImagePluginProvenance: customOpenClawImage,
      });
    },
  };
}
