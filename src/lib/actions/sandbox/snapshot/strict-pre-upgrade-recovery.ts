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
  const deadlineError = `Strict pre-upgrade recovery retention did not complete the ${observation} before the backup deadline`;
  return {
    ...result,
    success: false,
    error: result.error ? `${result.error}. ${deadlineError}` : deadlineError,
  };
}

type ObservationOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

/** Remaining budget for one retention observation, or null when the caller
 * supplied no transaction deadline and keeps the previous contract. */
function remainingRetentionBudgetMs(
  deadlineMs: number | undefined,
  now: () => number,
): number | null {
  return deadlineMs === undefined ? null : Math.floor(deadlineMs - now());
}

/** Run one deadline-aware observation and wait for its child work to settle. */
async function observeWithinBudget<T>(
  observe: (deadlineMs?: number) => Promise<T>,
  budgetMs: number | null,
  deadlineMs: number | undefined,
  now: () => number,
): Promise<ObservationOutcome<T>> {
  if (budgetMs !== null && budgetMs <= 0) return { kind: "timeout" };
  try {
    const value = await observe(deadlineMs);
    return deadlineMs !== undefined && remainingRetentionBudgetMs(deadlineMs, now)! <= 0
      ? { kind: "timeout" }
      : { kind: "value", value };
  } catch (error) {
    return deadlineMs !== undefined && remainingRetentionBudgetMs(deadlineMs, now)! <= 0
      ? { kind: "timeout" }
      : { kind: "error", error };
  }
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
  const policyOutcome = await observeWithinBudget(
    (observationDeadlineMs) =>
      observationDeadlineMs === undefined
        ? captureRecordedSandboxBasePolicy(
            sandbox.name,
            "capture the live policy for pre-upgrade recovery",
          )
        : captureRecordedSandboxBasePolicy(
            sandbox.name,
            "capture the live policy for pre-upgrade recovery",
            undefined,
            observationDeadlineMs,
            now,
          ),
    remainingRetentionBudgetMs(deadlineMs, now),
    deadlineMs,
    now,
  );
  if (policyOutcome.kind === "error") throw policyOutcome.error;
  if (policyOutcome.kind === "timeout") {
    return discardIncompleteStrictBackup(sandbox, expiredRetentionResult(result, "policy capture"));
  }
  const mcpOutcome = await observeWithinBudget(
    (observationDeadlineMs) =>
      observationDeadlineMs === undefined
        ? observeMcpStateForRebuild(sandbox, runtimeSelection, true)
        : observeMcpStateForRebuild(sandbox, runtimeSelection, true, {
            deadlineMs: observationDeadlineMs,
            now,
          }),
    remainingRetentionBudgetMs(deadlineMs, now),
    deadlineMs,
    now,
  );
  if (mcpOutcome.kind === "error") throw mcpOutcome.error;
  if (mcpOutcome.kind === "timeout") {
    return discardIncompleteStrictBackup(
      sandbox,
      expiredRetentionResult(result, "MCP observation"),
    );
  }
  const mcpObservation = mcpOutcome.value;
  result.manifest = sandboxState.writeRebuildPolicyHandoff(result.manifest, policyOutcome.value);
  result.manifest = sandboxState.writeRebuildMcpHandoff(
    result.manifest,
    mcpObservation.entries,
    mcpObservation.runtimeSelection ?? runtimeSelection,
  );
  return result;
}
