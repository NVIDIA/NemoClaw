// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedWorkloadRebuildPlan,
  ManagedWorkloadRebuildProviderOperations,
  ReadyManagedWorkloadReplacement,
  RestoredManagedWorkloadReplacement,
} from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";
import { validateRestoredReplacement } from "./validation";

export async function restoreStagedManagedWorkloadState(
  plan: ManagedWorkloadRebuildPlan,
  ready: ReadyManagedWorkloadReplacement,
  operations: ManagedWorkloadRebuildProviderOperations,
): Promise<RestoredManagedWorkloadReplacement> {
  try {
    return validateRestoredReplacement(plan, ready, await operations.restoreState(plan, ready));
  } catch (error) {
    throw new ManagedWorkloadRebuildTransactionError(
      "restore",
      "state restore did not produce an identity-bound receipt",
      { cause: error },
    );
  }
}
