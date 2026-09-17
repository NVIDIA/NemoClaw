// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  enforceRemovedImmutabilityMigrationBoundary,
  reportRemovedImmutabilityUpgrade,
} from "../../../state/migrations/removed-immutability";
import { connectSandbox, validateHermesPortablePrewarmSandboxName } from "../connect";
import { withSandboxLifecycleLock } from "../lifecycle/lock";

/**
 * Private, non-interactive GFN prewarm entry.
 *
 * The connect action still owns authority requalification, recovery, health
 * proof, publication, and rollback. This wrapper preserves the public
 * command's retired-state boundary and lifecycle lock while omitting only
 * Oclif discovery/parsing. It refuses non-Hermes lifecycle authority.
 */
export async function prewarmHermesPortableSandbox(sandboxName: string): Promise<void> {
  validateHermesPortablePrewarmSandboxName(sandboxName);
  try {
    reportRemovedImmutabilityUpgrade();
  } catch (error) {
    console.warn(
      `Shields has been retired from NemoClaw, but legacy upgrade state could not be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  enforceRemovedImmutabilityMigrationBoundary(sandboxName);
  await withSandboxLifecycleLock(sandboxName, async () => {
    enforceRemovedImmutabilityMigrationBoundary(sandboxName);
    await connectSandbox(sandboxName, {
      probeOnly: true,
      requireHermesPortablePrewarmAuthority: true,
    });
  });
}
