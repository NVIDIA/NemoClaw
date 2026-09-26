// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureRecordedSandboxBasePolicy } from "../../../policy";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";
import { observeMcpStateForRebuild } from "../rebuild-mcp-phase";

/** Remove a strict snapshot that cannot serve as a recovery point. Returns the
 * cleanup failure message, or null when the snapshot was removed. */
function removeUnusableStrictBackup(sandboxName: string, backupPath: string): string | null {
  if (sandboxState.removeSandboxStateBackup(sandboxName, backupPath)) return null;
  return `Failed strict pre-upgrade backup at '${backupPath}' could not be removed`;
}

/** Complete a strict pre-upgrade snapshot with the recovery authority that
 * becomes unavailable when the historical gateway is retired. */
export async function retainStrictPreUpgradeRecoveryState(
  sandbox: SandboxEntry,
  result: sandboxState.BackupResult,
  runtimeSelection: Parameters<typeof sandboxState.writeRebuildMcpHandoff>[2],
): Promise<sandboxState.BackupResult> {
  if (!result.success) {
    const backupPath = result.manifest?.backupPath;
    if (!backupPath) return result;
    const cleanupError = removeUnusableStrictBackup(sandbox.name, backupPath);
    if (!cleanupError) {
      const { manifest: _removedManifest, ...withoutPartialBackup } = result;
      return withoutPartialBackup;
    }
    return {
      ...result,
      error: result.error ? `${result.error}. ${cleanupError}` : cleanupError,
    };
  }
  const manifest = result.manifest;
  if (!manifest) {
    throw new Error(
      `Strict pre-upgrade backup for '${sandbox.name}' completed without a published manifest`,
    );
  }
  try {
    const policyDocument = await captureRecordedSandboxBasePolicy(
      sandbox.name,
      "capture the live policy for pre-upgrade recovery",
    );
    const mcpObservation = await observeMcpStateForRebuild(sandbox, runtimeSelection, true);
    const withPolicyHandoff = sandboxState.writeRebuildPolicyHandoff(manifest, policyDocument);
    result.manifest = sandboxState.writeRebuildMcpHandoff(
      withPolicyHandoff,
      mcpObservation.entries,
      mcpObservation.runtimeSelection ?? runtimeSelection,
    );
    return result;
  } catch (error) {
    // The snapshot is already published, but without its recovery handoffs it
    // cannot restore once the historical gateway is retired.
    const cleanupError = removeUnusableStrictBackup(sandbox.name, manifest.backupPath);
    if (!cleanupError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}. ${cleanupError}`, { cause: error });
  }
}
