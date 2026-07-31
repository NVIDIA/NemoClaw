// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ManagedWorkloadRebuildPlan,
  ManagedWorkloadRebuildProviderOperations,
  ReboundManagedWorkloadReplacement,
  RestoredManagedWorkloadReplacement,
} from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";
import { validateReboundReplacement } from "./validation";

export async function rebindStagedManagedWorkloadProviders(
  plan: ManagedWorkloadRebuildPlan,
  restored: RestoredManagedWorkloadReplacement,
  operations: ManagedWorkloadRebuildProviderOperations,
): Promise<ReboundManagedWorkloadReplacement> {
  try {
    return validateReboundReplacement(
      plan,
      restored,
      await operations.rebindProviders(plan, restored),
    );
  } catch (error) {
    throw new ManagedWorkloadRebuildTransactionError(
      "provider-rebind",
      "provider rebind did not preserve staged replacement authority",
      { cause: error },
    );
  }
}
