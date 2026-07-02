// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "../../state/registry";

export interface RebuildRegistryRollbackOptions {
  sandboxName: string;
  preparedBackupRecovery: boolean;
  staleRecovery: boolean;
  getRecoveryRegistrySnapshot: () => registry.SandboxRegistry | null;
  log: (message: string) => void;
}

export interface RebuildRegistryRollback {
  recordRemoval(receipt: registry.SandboxRemovalReceipt | null): void;
  restoreForRetry(): void;
}

interface RebuildRegistryRollbackDeps {
  restoreSandboxEntry?: typeof registry.restoreSandboxEntry;
  restoreSandboxEntryIfMissing?: typeof registry.restoreSandboxEntryIfMissing;
}

/**
 * Own the retry metadata removed during rebuild without moving any destructive
 * operation. Prepared recovery restores its latest validated snapshot;
 * ordinary and stale rebuilds restore only a missing removal receipt.
 */
export function createRebuildRegistryRollback(
  options: RebuildRegistryRollbackOptions,
  deps: RebuildRegistryRollbackDeps = {},
): RebuildRegistryRollback {
  const restoreSandboxEntry = deps.restoreSandboxEntry ?? registry.restoreSandboxEntry;
  const restoreSandboxEntryIfMissing =
    deps.restoreSandboxEntryIfMissing ?? registry.restoreSandboxEntryIfMissing;
  let removedRegistryEntry: registry.SandboxEntry | null = null;
  let registryEntryRemoved = false;
  let rollbackAttempted = false;

  return {
    recordRemoval(receipt): void {
      removedRegistryEntry = receipt?.entry ?? null;
      registryEntryRemoved = receipt !== null;
    },

    restoreForRetry(): void {
      if (rollbackAttempted) return;

      const recoveryRegistrySnapshot = options.getRecoveryRegistrySnapshot();
      const snapshotEntry = recoveryRegistrySnapshot?.sandboxes?.[options.sandboxName];
      if (options.preparedBackupRecovery && snapshotEntry) {
        rollbackAttempted = true;
        try {
          restoreSandboxEntry(snapshotEntry, {
            reclaimDefault:
              recoveryRegistrySnapshot?.defaultSandbox === options.sandboxName
                ? options.sandboxName
                : null,
          });
          options.log("Recovery recreate failed: restored preserved registry entry for retry");
        } catch (error) {
          options.log(
            `Failed to restore registry entry after recovery recreate failure: ${String(error)}`,
          );
        }
        return;
      }

      if (!registryEntryRemoved || !removedRegistryEntry) return;
      rollbackAttempted = true;
      try {
        const restored = restoreSandboxEntryIfMissing({
          ...removedRegistryEntry,
          imageTag: null,
        });
        const recreateLabel = options.staleRecovery ? "Stale-recovery recreate" : "Recreate";
        options.log(
          restored
            ? `${recreateLabel} failed: restored registry metadata for retry`
            : "Recreate failed: kept the replacement registry metadata already present",
        );
      } catch (error) {
        options.log(`Failed to restore registry metadata after recreate failure: ${String(error)}`);
      }
    },
  };
}
