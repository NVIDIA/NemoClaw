// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../../state/registry/types";
import {
  compareAndSwapSandboxRebuildAuthority,
  type SandboxRebuildAuthoritySwapResult,
} from "../../../state/registry/rebuild-authority";
import type {
  ManagedWorkloadRebuildPlan,
  ReboundManagedWorkloadReplacement,
} from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";

export type CommitSandboxRebuildAuthority = (
  expected: ManagedWorkloadRebuildPlan["previousAuthority"],
  replacement: SandboxEntry,
) => SandboxRebuildAuthoritySwapResult;

export function materializeManagedWorkloadReplacementEntry(
  previousEntry: SandboxEntry,
  plan: ManagedWorkloadRebuildPlan,
  replacement: ReboundManagedWorkloadReplacement,
): SandboxEntry {
  return structuredClone({
    ...previousEntry,
    ...plan.replacementMetadata,
    name: plan.sandboxName,
    pendingRouteReservation: undefined,
    reservationSessionId: undefined,
    openshellDriver: plan.providerId,
    agent: plan.agent,
    fromDockerfile: null,
    imageTag: plan.replacementReceipt.reference,
    workload: plan.replacementReceipt,
    lifecycleGeneration: replacement.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: replacement.liveIdentityFingerprint,
  });
}

export function commitManagedWorkloadReplacement(
  previousEntry: SandboxEntry,
  plan: ManagedWorkloadRebuildPlan,
  replacement: ReboundManagedWorkloadReplacement,
  commit: CommitSandboxRebuildAuthority = compareAndSwapSandboxRebuildAuthority,
): SandboxEntry {
  const candidate = materializeManagedWorkloadReplacementEntry(
    previousEntry,
    plan,
    replacement,
  );
  let result: SandboxRebuildAuthoritySwapResult;
  try {
    result = commit(plan.previousAuthority, candidate);
  } catch (error) {
    throw new ManagedWorkloadRebuildTransactionError(
      "registry-commit",
      "the replacement registry entry could not be committed",
      { cause: error },
    );
  }
  if (result.status !== "committed") {
    throw new ManagedWorkloadRebuildTransactionError(
      "registry-commit",
      "the old workload no longer owns the exact durable authority",
    );
  }
  return result.entry;
}
