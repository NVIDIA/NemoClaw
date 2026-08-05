// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../state/registry";
import * as notReadyRecreate from "./not-ready-recreate";
import {
  backupSandboxBeforeRecreate,
  type PreRecreateBackupResult,
} from "./sandbox-backup-on-recreate";
import type {
  SandboxRecreateObservation,
  SandboxRecreateSourceProof,
} from "./sandbox-recreate-transaction";

export interface PreUpgradeBackupBinding {
  sourceProof: () => SandboxRecreateSourceProof | null;
  gatewayName: string;
  gatewayPort: number;
  readRegistryEntry: () => SandboxEntry | null;
  observation: () => SandboxRecreateObservation;
}

interface SandboxRecreateSourceHolder {
  readonly sourceProof: SandboxRecreateSourceProof | null;
}

export interface JournalBoundPreUpgradeBackupInput<Runtime> {
  runtime: Runtime;
  openJournal: (() => Runtime) | null;
  gatewayName: string;
  gatewayPort: number;
  readRegistryEntry: () => SandboxEntry | null;
  observe: () => SandboxRecreateObservation;
}

export interface JournalBoundPreUpgradeBackupResult<Runtime> {
  runtime: Runtime;
  backupPath: string | null;
}

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

  const selectPreUpgradeBackup = (binding: PreUpgradeBackupBinding): string | null =>
    deps.selectPreUpgradeBackupForCreate({
      sourceProof: binding.sourceProof,
      gatewayName: binding.gatewayName,
      gatewayPort: binding.gatewayPort,
      registryEntry: sandboxEntry,
      readRegistryEntry: binding.readRegistryEntry,
      observation: binding.observation,
      existingSandboxEntry: sandboxEntry,
      requireOpenClawImagePluginProvenance: customOpenClawImage,
      sandboxName,
      note,
    });

  return {
    selectPreUpgradeBackup,
    // The journal opens only when selection actually asks for a source proof, so
    // a run that restores nothing leaves no transaction behind to complete.
    selectJournalBoundPreUpgradeBackup<Runtime extends SandboxRecreateSourceHolder>(
      binding: JournalBoundPreUpgradeBackupInput<Runtime>,
    ): JournalBoundPreUpgradeBackupResult<Runtime> {
      let runtime = binding.runtime;
      try {
        const backupPath = selectPreUpgradeBackup({
          sourceProof: () => {
            if (binding.openJournal) runtime = binding.openJournal();
            return runtime.sourceProof;
          },
          gatewayName: binding.gatewayName,
          gatewayPort: binding.gatewayPort,
          readRegistryEntry: binding.readRegistryEntry,
          observation: binding.observe,
        });
        return { runtime, backupPath };
      } catch (error) {
        if ("abandon" in runtime) (runtime as { abandon(): void }).abandon();
        throw error;
      }
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
