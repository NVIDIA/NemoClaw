// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  compareAndSwapSandboxRebuildAuthority,
  type SandboxRebuildAuthoritySwapResult,
  sandboxRebuildReplacementMatchesEntry,
} from "../../../state/registry/rebuild-authority";
import type { SandboxEntry } from "../../../state/registry/types";
import type { ManagedWorkloadRebuildPlan, ReboundManagedWorkloadReplacement } from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";

export type CommitSandboxRebuildAuthority = (
  expected: ManagedWorkloadRebuildPlan["previousAuthority"],
  replacement: SandboxEntry,
) => SandboxRebuildAuthoritySwapResult;

export type ReadSandboxRebuildEntry = (sandboxName: string) => SandboxEntry | null;

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
  readSandbox?: ReadSandboxRebuildEntry,
): SandboxEntry {
  const candidate = materializeManagedWorkloadReplacementEntry(previousEntry, plan, replacement);
  let result: SandboxRebuildAuthoritySwapResult;
  try {
    result = commit(plan.previousAuthority, candidate);
  } catch (error) {
    const observed = readSandbox?.(plan.sandboxName) ?? null;
    if (observed && sandboxRebuildReplacementMatchesEntry(candidate, observed)) {
      return structuredClone(observed);
    }
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
