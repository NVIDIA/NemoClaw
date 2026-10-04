// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { load } from "../../../state/registry/persistence";
import { sandboxRebuildAuthorityMatchesEntry } from "../../../state/registry/rebuild-authority";
import type { SandboxEntry } from "../../../state/registry/types";
import type { RuntimeProviderBundle } from "../../runtime-provider/contract";
import type { ManagedWorkloadRebuildHandoff } from "../../workload/rebuild";
import { type CommitSandboxRebuildAuthority, commitManagedWorkloadReplacement } from "./commit";
import type {
  ManagedWorkloadRebuildProviderOperations,
  ManagedWorkloadRebuildTransactionResult,
  PreparedManagedWorkloadReplacement,
  StagedManagedWorkloadReplacement,
} from "./contract";
import {
  ManagedWorkloadRebuildIndeterminatePublicationError,
  ManagedWorkloadRebuildTransactionError,
} from "./contract";
import { createStagedManagedWorkloadReplacement } from "./create";
import { createManagedWorkloadRebuildPlan } from "./plan";
import { prepareManagedWorkloadReplacement } from "./prepare";
import { rebindStagedManagedWorkloadProviders } from "./provider-rebind";
import { requireReadyManagedWorkloadReplacement } from "./readiness";
import { createManagedWorkloadRebuildRecoveryTask } from "./recovery";
import { restoreStagedManagedWorkloadState } from "./restore";
import {
  createManagedWorkloadPreparationAbort,
  createManagedWorkloadReplacementRollback,
} from "./rollback";

export interface RunManagedWorkloadRebuildTransactionInput {
  readonly previousEntry: SandboxEntry;
  readonly provider: RuntimeProviderBundle;
  readonly handoff: ManagedWorkloadRebuildHandoff;
  readonly operations: ManagedWorkloadRebuildProviderOperations;
  readonly replacementMetadata?: Readonly<Partial<SandboxEntry>>;
  readonly transactionId?: string;
}

export interface ManagedWorkloadRebuildTransactionDependencies {
  readonly getSandbox?: (sandboxName: string) => SandboxEntry | null;
  readonly commitAuthority?: CommitSandboxRebuildAuthority;
}

function readSandboxFromRegistry(sandboxName: string): SandboxEntry | null {
  return load().sandboxes[sandboxName] ?? null;
}

function rethrowWithRollback(
  error: unknown,
  rollbackError: unknown,
): ManagedWorkloadRebuildTransactionError {
  const phase = error instanceof ManagedWorkloadRebuildTransactionError ? error.phase : "rollback";
  const message =
    error instanceof Error ? error.message : "the staged replacement transaction failed";
  return new ManagedWorkloadRebuildTransactionError(phase, message, {
    cause: error,
    ...(rollbackError === undefined ? {} : { rollbackError }),
  });
}

async function failAfterCleanup(error: unknown, cleanup: () => Promise<void>): Promise<never> {
  let rollbackError: unknown;
  try {
    await cleanup();
  } catch (candidate) {
    rollbackError = candidate;
  }
  throw rethrowWithRollback(error, rollbackError);
}

/**
 * Execute a dormant, provider-neutral managed rebuild transaction.
 *
 * The durable row and provider-owned old runtime remain authoritative through
 * prepare, create, readiness, state restore, and provider rebind. Only the
 * exact final CAS publishes the replacement. The exact old runtime handle is
 * retired afterward, so no failure can turn a same-name lookup into deletion
 * authority.
 */
export async function runManagedWorkloadRebuildTransaction(
  input: RunManagedWorkloadRebuildTransactionInput,
  dependencies: ManagedWorkloadRebuildTransactionDependencies = {},
): Promise<ManagedWorkloadRebuildTransactionResult> {
  const readSandbox = dependencies.getSandbox ?? readSandboxFromRegistry;
  const plan = createManagedWorkloadRebuildPlan(input);
  if (input.operations.providerId !== plan.providerId) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      `provider operations '${input.operations.providerId}' do not match selected provider '${plan.providerId}'`,
    );
  }
  const abortPreparation = createManagedWorkloadPreparationAbort(plan, input.operations);
  const requireOldAuthority = (timing: "before" | "during"): void => {
    let stillAuthoritative: boolean;
    try {
      stillAuthoritative = sandboxRebuildAuthorityMatchesEntry(
        plan.previousAuthority,
        readSandbox(plan.sandboxName),
      );
    } catch (error) {
      throw new ManagedWorkloadRebuildTransactionError(
        "prepare",
        `the durable workload could not be revalidated ${timing} provider preparation`,
        { cause: error },
      );
    }
    if (!stillAuthoritative) {
      throw new ManagedWorkloadRebuildTransactionError(
        "prepare",
        `the durable workload changed ${timing} provider preparation`,
      );
    }
  };
  requireOldAuthority("before");

  let prepared: PreparedManagedWorkloadReplacement;
  try {
    prepared = await prepareManagedWorkloadReplacement(plan, input.operations);
  } catch (error) {
    return failAfterCleanup(error, () => abortPreparation.run());
  }
  try {
    requireOldAuthority("during");
  } catch (error) {
    return failAfterCleanup(error, () => abortPreparation.run());
  }

  let staged: StagedManagedWorkloadReplacement;
  try {
    staged = await createStagedManagedWorkloadReplacement(plan, prepared, input.operations);
  } catch (error) {
    return failAfterCleanup(error, () => abortPreparation.run());
  }
  const rollback = createManagedWorkloadReplacementRollback(plan, staged, input.operations);
  try {
    const ready = await requireReadyManagedWorkloadReplacement(plan, staged, input.operations);
    const restored = await restoreStagedManagedWorkloadState(plan, ready, input.operations);
    const rebound = await rebindStagedManagedWorkloadProviders(plan, restored, input.operations);
    const entry = commitManagedWorkloadReplacement(
      input.previousEntry,
      plan,
      rebound,
      dependencies.commitAuthority,
      readSandbox,
    );
    try {
      await input.operations.retirePrevious(plan, rebound);
      return { status: "committed", entry, previousCleanup: "complete" };
    } catch (cleanupError) {
      return {
        status: "committed",
        entry,
        previousCleanup: "pending",
        cleanupError,
        recoveryTask: createManagedWorkloadRebuildRecoveryTask(plan, rebound, "retire-previous"),
      };
    }
  } catch (error) {
    if (error instanceof ManagedWorkloadRebuildIndeterminatePublicationError) throw error;
    return failAfterCleanup(error, () => rollback.run());
  }
}
