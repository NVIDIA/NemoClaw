// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedWorkloadRebuildPlan,
  ManagedWorkloadRebuildProviderOperations,
  ReadyManagedWorkloadReplacement,
  StagedManagedWorkloadReplacement,
} from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";
import { validateNotReadyReason, validateReadyReplacement } from "./validation";

export async function requireReadyManagedWorkloadReplacement(
  plan: ManagedWorkloadRebuildPlan,
  staged: StagedManagedWorkloadReplacement,
  operations: ManagedWorkloadRebuildProviderOperations,
): Promise<ReadyManagedWorkloadReplacement> {
  try {
    const readiness = await operations.waitUntilReady(plan, staged);
    if (readiness.state === "not-ready") {
      throw new ManagedWorkloadRebuildTransactionError(
        "readiness",
        validateNotReadyReason(readiness.reason),
      );
    }
    return validateReadyReplacement(plan, staged, readiness.replacement);
  } catch (error) {
    if (error instanceof ManagedWorkloadRebuildTransactionError) throw error;
    throw new ManagedWorkloadRebuildTransactionError(
      "readiness",
      "the staged replacement did not prove readiness",
      { cause: error },
    );
  }
}
