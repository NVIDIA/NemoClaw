// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { captureSandboxRebuildAuthority } from "../../../state/registry/rebuild-authority";
import type { SandboxEntry } from "../../../state/registry/types";
import type { RuntimeProviderBundle } from "../../runtime-provider/contract";
import {
  normalizeRuntimeProviderIdentity,
  requireRuntimeProviderMutationAuthority,
} from "../../runtime-provider/registry";
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
  return Object.freeze(safe);
}

export function createManagedWorkloadRebuildPlan(input: {
  readonly previousEntry: SandboxEntry;
  readonly provider: RuntimeProviderBundle;
  readonly handoff: ManagedWorkloadRebuildHandoff;
  readonly replacementMetadata?: Readonly<Partial<SandboxEntry>>;
  readonly transactionId?: string;
}): ManagedWorkloadRebuildPlan {
  const providerId = input.provider.identity.id;
  if (normalizeRuntimeProviderIdentity(input.previousEntry.openshellDriver) !== providerId) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the durable sandbox driver does not select the supplied provider bundle",
    );
  }
  requireRuntimeProviderMutationAuthority(input.provider, "rebuild");
  if (
    input.handoff.providerId !== providerId ||
    input.handoff.agent !== input.previousEntry.agent
  ) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the managed profile handoff does not match durable provider and agent authority",
    );
  }
  if (!isDeepStrictEqual(input.handoff.previousReceipt, input.previousEntry.workload)) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the managed profile handoff is stale against the durable workload receipt",
    );
  }
  if (
    input.handoff.previousReceipt.platform !== input.handoff.previousContract.platform ||
    input.handoff.replacement.source.contract.platform !== input.handoff.previousContract.platform
  ) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the managed rebuild handoff contains cross-platform authority drift",
    );
  }
  const previousAuthority = captureSandboxRebuildAuthority(input.previousEntry, providerId);
  const replacementReceipt = buildManagedWorkloadRebuildReceipt(input.handoff, input.provider);
  const transactionId = input.transactionId ?? randomUUID();
  if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,255}$/u.test(transactionId)) {
    throw new ManagedWorkloadRebuildTransactionError(
      "prepare",
      "the rebuild transaction identity is invalid",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    transactionId,
    sandboxName: input.previousEntry.name,
    providerId,
    agent: input.handoff.agent,
    previousAuthority,
    handoff: input.handoff,
    replacementReceipt,
    replacementMetadata: safeReplacementMetadata(input.replacementMetadata),
  });
}
