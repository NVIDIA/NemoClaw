// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  compareAndSwapSandboxRebuildAuthority,
  type SandboxRebuildAuthoritySwapResult,
  sandboxRebuildAuthorityMatchesEntry,
  sandboxRebuildReplacementMatchesEntry,
} from "../../../state/registry/rebuild-authority";
import type { SandboxEntry } from "../../../state/registry/types";
import type { ManagedWorkloadRebuildPlan, ReboundManagedWorkloadReplacement } from "./contract";
import {
  ManagedWorkloadRebuildIndeterminatePublicationError,
  ManagedWorkloadRebuildTransactionError,
} from "./contract";
import { createManagedWorkloadRebuildRecoveryTask } from "./recovery";

export type CommitSandboxRebuildAuthority = (
  expected: ManagedWorkloadRebuildPlan["previousAuthority"],
  replacement: SandboxEntry,
) => SandboxRebuildAuthoritySwapResult;

export type ReadSandboxRebuildEntry = (sandboxName: string) => SandboxEntry | null;

function reconcileAmbiguousPublication(
  plan: ManagedWorkloadRebuildPlan,
  replacement: ReboundManagedWorkloadReplacement,
  candidate: SandboxEntry,
  publicationError: unknown,
  readSandbox?: ReadSandboxRebuildEntry,
): SandboxEntry {
  if (!readSandbox) {
    throw new ManagedWorkloadRebuildIndeterminatePublicationError(
      "publication failed without an authoritative reconciliation read",
      createManagedWorkloadRebuildRecoveryTask(plan, replacement, "reconcile-publication"),
      { cause: publicationError },
    );
  }
  let observed: SandboxEntry | null;
  try {
    observed = readSandbox(plan.sandboxName);
  } catch (reconciliationError) {
    throw new ManagedWorkloadRebuildIndeterminatePublicationError(
      "publication and authoritative reconciliation both failed",
      createManagedWorkloadRebuildRecoveryTask(plan, replacement, "reconcile-publication"),
      {
        cause: new AggregateError(
          [publicationError, reconciliationError],
          "managed workload publication and reconciliation failed",
        ),
      },
    );
  }
  if (observed && sandboxRebuildReplacementMatchesEntry(candidate, observed)) {
    return structuredClone(observed);
  }
  if (sandboxRebuildAuthorityMatchesEntry(plan.previousAuthority, observed)) {
    throw new ManagedWorkloadRebuildTransactionError(
      "registry-commit",
      "publication failed while the exact old authority remained durable",
      { cause: publicationError },
    );
  }
  throw new ManagedWorkloadRebuildIndeterminatePublicationError(
    "publication could not be reconciled to the replacement or exact old authority",
    createManagedWorkloadRebuildRecoveryTask(plan, replacement, "reconcile-publication"),
    { cause: publicationError },
  );
}

export function materializeManagedWorkloadReplacementEntry(
  previousEntry: SandboxEntry,
  plan: ManagedWorkloadRebuildPlan,
  replacement: ReboundManagedWorkloadReplacement,
): SandboxEntry {
  const {
    policyAuthority: _previousPolicyAuthority,
    policyCreationReceipt: _previousPolicyCreationReceipt,
    ...retainedPreviousEntry
  } = previousEntry;
  return structuredClone({
    ...retainedPreviousEntry,
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
    return reconcileAmbiguousPublication(plan, replacement, candidate, error, readSandbox);
  }
  if (result.status !== "committed") {
    throw new ManagedWorkloadRebuildTransactionError(
      "registry-commit",
      "the old workload no longer owns the exact durable authority",
    );
  }
  if (!sandboxRebuildReplacementMatchesEntry(candidate, result.entry)) {
    return reconcileAmbiguousPublication(
      plan,
      replacement,
      candidate,
      new Error("the commit adapter returned a mismatched committed entry"),
      readSandbox,
    );
  }
  return structuredClone(result.entry);
}
