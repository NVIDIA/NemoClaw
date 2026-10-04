// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedWorkloadRebuildPlan,
  ManagedWorkloadRebuildProviderOperations,
  StagedManagedWorkloadReplacement,
} from "./contract";

export interface ManagedWorkloadReplacementRollback {
  run(): Promise<void>;
}

export function createManagedWorkloadPreparationAbort(
  plan: ManagedWorkloadRebuildPlan,
  operations: ManagedWorkloadRebuildProviderOperations,
): ManagedWorkloadReplacementRollback {
  let abort: Promise<void> | null = null;
  return {
    run(): Promise<void> {
      abort ??= operations.abortPreparation(plan);
      return abort;
    },
  };
}

/**
 * Collapse concurrent or repeated rollback attempts onto one exact-handle
 * provider call. The provider contract remains retry-safe for crash recovery;
 * one live transaction never races duplicate cleanup calls.
 */
export function createManagedWorkloadReplacementRollback(
  plan: ManagedWorkloadRebuildPlan,
  staged: StagedManagedWorkloadReplacement,
  operations: ManagedWorkloadRebuildProviderOperations,
): ManagedWorkloadReplacementRollback {
  let rollback: Promise<void> | null = null;
  return {
    run(): Promise<void> {
      rollback ??= operations.rollback(plan, staged);
      return rollback;
    },
  };
}
