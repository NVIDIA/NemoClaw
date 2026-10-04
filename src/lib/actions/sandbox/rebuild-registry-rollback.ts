// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RegistryRemovalReceipt } from "../../state/registry-reversible-removal";
import type { SandboxEntry, SandboxRegistry } from "../../state/registry/types";

type SandboxRemovalReceipt = RegistryRemovalReceipt<SandboxEntry>;

export interface RebuildRegistryRollbackOptions {
  sandboxName: string;
  preparedBackupRecovery: boolean;
  staleRecovery: boolean;
  getRecoveryRegistrySnapshot: () => SandboxRegistry | null;
  log: (message: string) => void;
}

export interface RebuildRegistryRollback {
  recordRemoval(receipt: SandboxRemovalReceipt | null): void;
  restoreForRetry(): void;
}

interface RebuildRegistryRollbackDeps {
  restoreSandboxEntry: (
    entry: SandboxEntry,
    options?: {
      defaultTransition?: {
        readonly from: string | null;
        readonly to: string;
        readonly expectedRevision: number;
      };
    },
  ) => void;
  restoreSandboxEntryIfMissing: (receipt: SandboxRemovalReceipt) => boolean;
}

/**
 * Own the retry metadata removed during rebuild without moving any destructive
 * operation. Prepared recovery restores its latest validated snapshot;
 * ordinary and stale rebuilds restore only a missing removal receipt.
 */
export function createRebuildRegistryRollback(
  options: RebuildRegistryRollbackOptions,
  deps: RebuildRegistryRollbackDeps,
): RebuildRegistryRollback {
  const { restoreSandboxEntry, restoreSandboxEntryIfMissing } = deps;
  let removedRegistryReceipt: SandboxRemovalReceipt | null = null;
  let registryEntryRemoved = false;
  let rollbackAttempted = false;

  return {
    recordRemoval(receipt): void {
      removedRegistryReceipt = receipt;
      registryEntryRemoved = receipt !== null;
    },

    restoreForRetry(): void {
      if (rollbackAttempted) return;

      const recoveryRegistrySnapshot = options.getRecoveryRegistrySnapshot();
      const snapshotEntry = recoveryRegistrySnapshot?.sandboxes?.[options.sandboxName];
      const shouldRestoreRecoverySnapshot =
        options.preparedBackupRecovery ||
        (options.staleRecovery && removedRegistryReceipt === null);
      if (shouldRestoreRecoverySnapshot && snapshotEntry) {
        rollbackAttempted = true;
        try {
          const defaultTransition = removedRegistryReceipt?.wasDefault
            ? {
                from: removedRegistryReceipt.fallbackDefault,
                to: options.sandboxName,
                expectedRevision: removedRegistryReceipt.postRemovalDefaultSelectionRevision,
              }
            : undefined;
          restoreSandboxEntry(snapshotEntry, {
            ...(defaultTransition ? { defaultTransition } : {}),
          });
          options.log("Recovery recreate failed: restored preserved registry entry for retry");
        } catch (error) {
          options.log(
            `Failed to restore registry entry after recovery recreate failure: ${String(error)}`,
          );
        }
        return;
      }

      if (!registryEntryRemoved || !removedRegistryReceipt) return;
      rollbackAttempted = true;
      try {
        const restored = restoreSandboxEntryIfMissing({
          ...removedRegistryReceipt,
          entry: {
            ...removedRegistryReceipt.entry,
            imageTag: null,
          },
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
