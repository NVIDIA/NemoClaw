// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureRecordedSandboxBasePolicy } from "../../../policy";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";
import { observeMcpStateForRebuild } from "../rebuild-mcp-phase";

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
    if (sandboxState.removeSandboxStateBackup(sandbox.name, backupPath)) {
      const { manifest: _removedManifest, ...withoutPartialBackup } = result;
      return withoutPartialBackup;
    }
    const cleanupError = `Failed strict pre-upgrade backup at '${backupPath}' could not be removed`;
    return {
      ...result,
      error: result.error ? `${result.error}. ${cleanupError}` : cleanupError,
    };
  }
  if (!result.manifest) {
    throw new Error(
      `Strict pre-upgrade backup for '${sandbox.name}' completed without a published manifest`,
    );
  }
  const policyDocument = await captureRecordedSandboxBasePolicy(
    sandbox.name,
    "capture the live policy for pre-upgrade recovery",
  );
  const mcpObservation = await observeMcpStateForRebuild(sandbox, runtimeSelection, true);
  result.manifest = sandboxState.writeRebuildPolicyHandoff(result.manifest, policyDocument);
  result.manifest = sandboxState.writeRebuildMcpHandoff(
    result.manifest,
    mcpObservation.entries,
    mcpObservation.runtimeSelection ?? runtimeSelection,
  );
  return result;
}
