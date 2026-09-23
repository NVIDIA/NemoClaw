// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureRecordedSandboxBasePolicy } from "../../../policy";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";
import { observeMcpStateForRebuild } from "../rebuild-mcp-phase";

/** Discard a strict pre-upgrade snapshot that cannot carry complete recovery
 * authority, keeping the original failure visible. */
function discardIncompleteStrictBackup(
  sandbox: SandboxEntry,
  result: sandboxState.BackupResult,
): sandboxState.BackupResult {
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

function expiredRetentionResult(
  result: sandboxState.BackupResult,
  observation: string,
): sandboxState.BackupResult {
  const deadlineError = `Strict pre-upgrade recovery retention skipped the ${observation}: backup deadline expired`;
  return {
    ...result,
    success: false,
    error: result.error ? `${result.error}. ${deadlineError}` : deadlineError,
  };
}

/** Complete a strict pre-upgrade snapshot with the recovery authority that
 * becomes unavailable when the historical gateway is retired.
 *
 * `deadlineMs` bounds the live observations this retention needs. Both are
 * gateway round trips with no timeout of their own, and they run inside the
 * stopped-sandbox backup transaction while the container is still up, so an
 * unbounded wait here delays returning that container to its recorded
 * stopped state (#11936). */
export async function retainStrictPreUpgradeRecoveryState(
  sandbox: SandboxEntry,
  result: sandboxState.BackupResult,
  runtimeSelection: Parameters<typeof sandboxState.writeRebuildMcpHandoff>[2],
  deadlineMs?: number,
  now: () => number = Date.now,
): Promise<sandboxState.BackupResult> {
  if (!result.success) return discardIncompleteStrictBackup(sandbox, result);
  if (!result.manifest) {
    throw new Error(
      `Strict pre-upgrade backup for '${sandbox.name}' completed without a published manifest`,
    );
  }
  const expired = (): boolean => deadlineMs !== undefined && deadlineMs <= now();
  if (expired()) {
    return discardIncompleteStrictBackup(sandbox, expiredRetentionResult(result, "policy capture"));
  }
  const policyDocument = await captureRecordedSandboxBasePolicy(
    sandbox.name,
    "capture the live policy for pre-upgrade recovery",
  );
  if (expired()) {
    return discardIncompleteStrictBackup(
      sandbox,
      expiredRetentionResult(result, "MCP observation"),
    );
  }
  const mcpObservation = await observeMcpStateForRebuild(sandbox, runtimeSelection, true);
  result.manifest = sandboxState.writeRebuildPolicyHandoff(result.manifest, policyDocument);
  result.manifest = sandboxState.writeRebuildMcpHandoff(
    result.manifest,
    mcpObservation.entries,
    mcpObservation.runtimeSelection ?? runtimeSelection,
  );
  return result;
}
