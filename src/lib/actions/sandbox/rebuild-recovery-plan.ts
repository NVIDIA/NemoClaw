// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../state/onboard-session";
import type {
  RebuildRegistryRecoveryV1,
  RebuildTransactionRecordV1,
} from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import {
  decideRebuildRecovery,
  observeRebuildRegistry,
  observeRebuildSession,
  type RebuildObservedLiveState,
  type RebuildRecoveryAction,
  type RebuildRecoveryRefusalCode,
} from "./rebuild-recovery";

export interface RebuildRecoveryPlan {
  action: RebuildRecoveryAction;
  replacementAlreadyPresent: boolean;
  registryRestored: boolean;
}

export type RebuildRecoveryReconciliation =
  | { ok: true; plan: RebuildRecoveryPlan | null }
  | { ok: false; code: RebuildRecoveryRefusalCode; transactionId: string };

export function reconcileRebuildRecovery(input: {
  transaction: RebuildTransactionRecordV1 | null;
  live: RebuildObservedLiveState;
  readRegistryEntry: () => SandboxEntry | null;
  readSession: () => Session | null;
  restoreRegistry: (recovery: RebuildRegistryRecoveryV1) => boolean;
}): RebuildRecoveryReconciliation {
  const { transaction } = input;
  if (
    !transaction ||
    (transaction.phase !== "old_deleted" && transaction.phase !== "replacement_created")
  ) {
    return { ok: true, plan: null };
  }

  const registryEntry = input.readRegistryEntry();
  const decision = decideRebuildRecovery({
    transaction,
    live: input.live,
    registry: observeRebuildRegistry(transaction, registryEntry),
    session: observeRebuildSession(transaction, input.readSession(), registryEntry),
  });
  if (decision.action === "refuse") {
    return { ok: false, code: decision.code, transactionId: transaction.transactionId };
  }

  return {
    ok: true,
    plan: {
      action: decision.action,
      replacementAlreadyPresent: decision.action === "adopt" || decision.action === "resume",
      // Source of truth: the durable journal; the registry is a mutable fallback.
      // Remove restoration when the journal owns the complete recovery snapshot
      // or registry updates become atomic with transaction publication; #6433
      // tracks that durable-transaction migration.
      registryRestored:
        decision.action === "create" && !registryEntry
          ? input.restoreRegistry(transaction.intent.source.registryRecovery)
          : false,
    },
  };
}
