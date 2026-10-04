// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedWorkloadRebuildPlan,
  ManagedWorkloadRebuildProviderOperations,
  PreparedManagedWorkloadReplacement,
} from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";
import { validatePreparedReplacement } from "./validation";

export async function prepareManagedWorkloadReplacement(
  plan: ManagedWorkloadRebuildPlan,
  operations: ManagedWorkloadRebuildProviderOperations,
): Promise<PreparedManagedWorkloadReplacement> {
  if (operations.providerId !== plan.providerId) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      `operation provider '${operations.providerId}' does not match '${plan.providerId}'`,
    );
  }
  try {
    return validatePreparedReplacement(plan, await operations.prepare(plan));
  } catch (error) {
    if (error instanceof ManagedWorkloadRebuildTransactionError) throw error;
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the provider did not produce exact old-workload authority",
      { cause: error },
    );
  }
}
