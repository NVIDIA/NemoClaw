// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../state/onboard-session";
import type {
  RebuildRegistryRecoveryV1,
  RebuildTransactionRecordV1,
} from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import type { RebuildBail } from "./rebuild-credential-preflight";
import {
  decideRebuildRecovery,
  observeRebuildRegistry,
  observeRebuildSession,
  type RebuildObservedLiveState,
  type RebuildRecoveryAction,
  type RebuildRecoveryRefusalCode,
} from "./rebuild-recovery";
import type { RebuildTransactionCoordinator } from "./rebuild-transaction-coordinator";

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
      // The journal is authoritative and the registry is a mutable fallback.
      // Remove restoration when either store owns the whole atomic transaction.
      registryRestored:
        decision.action === "create" && !registryEntry
          ? input.restoreRegistry(transaction.intent.source.registryRecovery)
          : false,
    },
  };
}

export async function publishAdoptedRebuildReplacement(
  plan: RebuildRecoveryPlan | null,
  transaction: RebuildTransactionCoordinator,
  readReplacement: () => SandboxEntry | null,
  bail: RebuildBail,
): Promise<void> {
  if (plan?.action !== "adopt") return;
  const replacement = readReplacement();
  if (!replacement) {
    bail("The transaction-correlated replacement disappeared before receipt publication.");
  }
  await transaction.markReplacementCreated(replacement);
}

export async function publishCreatedRebuildReplacement(
  plan: RebuildRecoveryPlan | null,
  transaction: RebuildTransactionCoordinator,
  replacement: SandboxEntry | null,
): Promise<void> {
  await (plan?.action === "recreate"
    ? transaction.markReplacementRecreated(replacement)
    : transaction.markReplacementCreated(replacement));
}
