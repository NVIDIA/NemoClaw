// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cloneAndDeepFreeze } from "../../../core/immutable";
import { captureSandboxRebuildAuthority } from "../../../state/registry/rebuild-authority";
import type { SandboxEntry } from "../../../state/registry/types";
import type { RuntimeProviderBundle } from "../../runtime-provider/contract";
import {
  normalizeRuntimeProviderIdentity,
  requireRuntimeProviderMutationAuthority,
} from "../../runtime-provider/registry";
import { readManagedWorkloadAuthority } from "../../workload/authority";
import {
  buildManagedWorkloadRebuildReceipt,
  type ManagedWorkloadRebuildHandoff,
} from "../../workload/rebuild";
import type { ManagedWorkloadRebuildPlan } from "./contract";
import { ManagedWorkloadRebuildTransactionError } from "./contract";

const PROTECTED_REBUILD_METADATA_FIELDS = new Set<keyof SandboxEntry>([
  "name",
  "pendingRouteReservation",
  "reservationSessionId",
  "openshellDriver",
  "fromDockerfile",
  "imageTag",
  "workload",
  "lifecycleGeneration",
  "lifecycleLiveIdentityFingerprint",
  "policyAuthority",
  "policyCreationReceipt",
]);

function safeReplacementMetadata(
  metadata: Readonly<Partial<SandboxEntry>> | undefined,
): Readonly<Partial<SandboxEntry>> {
  const source = metadata ?? {};
  const safe = Object.fromEntries(
    Object.entries(structuredClone(source)).filter(
      ([field]) => !PROTECTED_REBUILD_METADATA_FIELDS.has(field as keyof SandboxEntry),
    ),
  ) as Partial<SandboxEntry>;
  return cloneAndDeepFreeze(safe);
}

export function createManagedWorkloadRebuildPlan(input: {
  readonly previousEntry: SandboxEntry;
  readonly provider: RuntimeProviderBundle;
  readonly handoff: ManagedWorkloadRebuildHandoff;
  readonly replacementMetadata?: Readonly<Partial<SandboxEntry>>;
  readonly transactionId?: string;
}): ManagedWorkloadRebuildPlan {
  const handoff = cloneAndDeepFreeze(input.handoff);
  const providerId = input.provider.identity.id;
  if (normalizeRuntimeProviderIdentity(input.previousEntry.openshellDriver) !== providerId) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the durable sandbox driver does not select the supplied provider bundle",
    );
  }
  requireRuntimeProviderMutationAuthority(input.provider, "rebuild");
  if (
    handoff.providerId !== providerId ||
    handoff.agent !== input.previousEntry.agent ||
    handoff.replacement.source.contract.agent !== handoff.agent ||
    handoff.replacementProfile.profile.agent !== handoff.agent
  ) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the managed profile handoff does not match durable provider and agent authority",
    );
  }
  let durableAuthority: NonNullable<ReturnType<typeof readManagedWorkloadAuthority>>;
  try {
    const candidate = readManagedWorkloadAuthority(input.previousEntry);
    if (!candidate) {
      throw new Error("the durable row is not a managed workload");
    }
    durableAuthority = candidate;
  } catch (error) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the durable managed workload authority could not be validated",
      { cause: error },
    );
  }
  if (
    durableAuthority.agent !== handoff.agent ||
    !isDeepStrictEqual(durableAuthority.receipt, handoff.previousReceipt) ||
    !isDeepStrictEqual(durableAuthority.contract, handoff.previousContract) ||
    !isDeepStrictEqual(durableAuthority.profile, handoff.previousProfile) ||
    !isDeepStrictEqual(durableAuthority.corporateCa, handoff.corporateCa)
  ) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the managed profile handoff is stale against exact durable workload authority",
    );
  }
  if (
    handoff.previousReceipt.platform !== handoff.previousContract.platform ||
    handoff.replacement.source.contract.platform !== handoff.previousContract.platform
  ) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the managed rebuild handoff contains cross-platform authority drift",
    );
  }
  const previousAuthority = captureSandboxRebuildAuthority(input.previousEntry, providerId);
  const replacementReceipt = buildManagedWorkloadRebuildReceipt(handoff, input.provider);
  const transactionId = input.transactionId ?? randomUUID();
  if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,255}$/u.test(transactionId)) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the rebuild transaction identity is invalid",
    );
  }
  return cloneAndDeepFreeze({
    schemaVersion: 1,
    transactionId,
    sandboxName: input.previousEntry.name,
    providerId,
    agent: handoff.agent,
    previousAuthority,
    handoff,
    replacementReceipt,
    replacementMetadata: safeReplacementMetadata(input.replacementMetadata),
  });
}
