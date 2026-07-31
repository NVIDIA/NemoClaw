// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../../state/registry/types";
import {
  getSandbox,
} from "../../../state/registry";
import {
  sandboxRebuildAuthorityMatchesEntry,
} from "../../../state/registry/rebuild-authority";
import type { RuntimeProviderBundle } from "../../runtime-provider/contract";
import type { ManagedWorkloadRebuildHandoff } from "../../workload/rebuild";
import { commitManagedWorkloadReplacement, type CommitSandboxRebuildAuthority } from "./commit";
import type {
  ManagedWorkloadRebuildProviderOperations,
  ManagedWorkloadRebuildTransactionResult,
  StagedManagedWorkloadReplacement,
} from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";
import { createStagedManagedWorkloadReplacement } from "./create";
import { createManagedWorkloadRebuildPlan } from "./plan";
import { prepareManagedWorkloadReplacement } from "./prepare";
import { rebindStagedManagedWorkloadProviders } from "./provider-rebind";
import { requireReadyManagedWorkloadReplacement } from "./readiness";
import { restoreStagedManagedWorkloadState } from "./restore";
import { createManagedWorkloadReplacementRollback } from "./rollback";

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

function rethrowWithRollback(
  error: unknown,
  rollbackError: unknown,
): ManagedWorkloadRebuildTransactionError {
  const phase =
    error instanceof ManagedWorkloadRebuildTransactionError ? error.phase : "rollback";
  const message =
    error instanceof Error ? error.message : "the staged replacement transaction failed";
  return new ManagedWorkloadRebuildTransactionError(phase, message, {
    cause: error,
    ...(rollbackError === undefined ? {} : { rollbackError }),
  });
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
  const readSandbox = dependencies.getSandbox ?? getSandbox;
  const plan = createManagedWorkloadRebuildPlan(input);
  const stillAuthoritative = (): boolean =>
    sandboxRebuildAuthorityMatchesEntry(
      plan.previousAuthority,
      readSandbox(plan.sandboxName),
    );
  if (!stillAuthoritative()) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the durable workload changed before provider preparation",
    );
  }

  const prepared = await prepareManagedWorkloadReplacement(plan, input.operations);
  if (!stillAuthoritative()) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the durable workload changed during provider preparation",
    );
  }

  let staged: StagedManagedWorkloadReplacement | null = null;
  try {
    staged = await createStagedManagedWorkloadReplacement(
      plan,
      prepared,
      input.operations,
    );
    const rollback = createManagedWorkloadReplacementRollback(
      plan,
      staged,
      input.operations,
    );
    try {
      const ready = await requireReadyManagedWorkloadReplacement(
        plan,
        staged,
        input.operations,
      );
      const restored = await restoreStagedManagedWorkloadState(
        plan,
        ready,
        input.operations,
      );
      const rebound = await rebindStagedManagedWorkloadProviders(
        plan,
        restored,
        input.operations,
      );
      const entry = commitManagedWorkloadReplacement(
        input.previousEntry,
        plan,
        rebound,
        dependencies.commitAuthority,
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
        };
      }
    } catch (error) {
      let rollbackError: unknown;
      try {
        await rollback.run();
      } catch (candidate) {
        rollbackError = candidate;
      }
      throw rethrowWithRollback(error, rollbackError);
    }
  } catch (error) {
    if (error instanceof ManagedWorkloadRebuildTransactionError) throw error;
    throw new ManagedWorkloadRebuildTransactionError(
      staged === null ? "create" : "rollback",
      "the provider-owned staged replacement transaction failed",
      { cause: error },
    );
  }
}
