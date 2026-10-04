// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedWorkloadRebuildPlan,
  ManagedWorkloadRebuildProviderOperations,
  PreparedManagedWorkloadReplacement,
  StagedManagedWorkloadReplacement,
} from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";
import { validateStagedReplacement } from "./validation";

export async function createStagedManagedWorkloadReplacement(
  plan: ManagedWorkloadRebuildPlan,
  prepared: PreparedManagedWorkloadReplacement,
  operations: ManagedWorkloadRebuildProviderOperations,
): Promise<StagedManagedWorkloadReplacement> {
  try {
    return validateStagedReplacement(plan, prepared, await operations.create(plan, prepared));
  } catch (error) {
    throw new ManagedWorkloadRebuildTransactionError(
      "create",
      "the provider could not create an identity-bound staged replacement",
      { cause: error },
    );
  }
}
