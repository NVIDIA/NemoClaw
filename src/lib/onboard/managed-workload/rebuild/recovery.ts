// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cloneAndDeepFreeze } from "../../../core/immutable";
import type {
  ManagedWorkloadRebuildPlan,
  ManagedWorkloadRebuildRecoveryTask,
  StagedManagedWorkloadReplacement,
} from "./contract";

export function createManagedWorkloadRebuildRecoveryTask(
  plan: ManagedWorkloadRebuildPlan,
  replacement: StagedManagedWorkloadReplacement,
  operation: ManagedWorkloadRebuildRecoveryTask["operation"],
): ManagedWorkloadRebuildRecoveryTask {
  return cloneAndDeepFreeze({
    schemaVersion: 1,
    owner: "durable-managed-workload-recovery",
    operation,
    transactionId: plan.transactionId,
    sandboxName: plan.sandboxName,
    providerId: plan.providerId,
    previousRuntimeHandle: replacement.previousRuntimeHandle,
    stagingHandle: replacement.stagingHandle,
    previousAuthority: plan.previousAuthority,
    replacement: {
      agent: plan.agent,
      receipt: plan.replacementReceipt,
      lifecycleGeneration: replacement.lifecycleGeneration,
      liveIdentityFingerprint: replacement.liveIdentityFingerprint,
    },
  });
}
