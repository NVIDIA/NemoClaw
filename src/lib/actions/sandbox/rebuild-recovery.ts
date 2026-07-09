// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fingerprintRebuildRegistryEntry,
  fingerprintRebuildReplacement,
  matchesRebuildTargetRegistry,
} from "../../rebuild-correlation";
import type { Session } from "../../state/onboard-session";
import type {
  RebuildRegistryRecoveryV1,
  RebuildTransactionRecordV1,
} from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { RebuildLiveState } from "./rebuild-flow-helpers";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";

export type RebuildObservedLiveState = "absent" | "not_ready" | "ready" | "unknown_present";
export type RebuildRecoveryAction = "adopt" | "create" | "recreate" | "resume";

export type RebuildRecoveryDecision =
  | { action: RebuildRecoveryAction }
  | { action: "refuse"; code: RebuildRecoveryRefusalCode };

export type RebuildRecoveryRefusalCode =
  | "REBUILD_RECOVERY_LIVE_STATE_AMBIGUOUS"
  | "REBUILD_RECOVERY_REGISTRY_CORRUPTED"
  | "REBUILD_RECOVERY_REGISTRY_MISMATCH"
  | "REBUILD_RECOVERY_SESSION_MISMATCH";

export type RebuildRegistryObservation =
  | "mismatch"
  | "missing"
  | "replacement"
  | "source"
  | "target";
export type RebuildSessionObservation = "matching" | "missing" | "unrelated";

export function observeRebuildRegistry(
  transaction: RebuildTransactionRecordV1,
  entry: SandboxEntry | null,
): RebuildRegistryObservation {
  if (!entry) return "missing";
  if (
    transaction.receipts.replacement?.identityFingerprint === fingerprintRebuildReplacement(entry)
  ) {
    return "replacement";
  }
  if (fingerprintRebuildRegistryEntry(entry) === transaction.intent.source.registryFingerprint) {
    return "source";
  }
  return matchesRebuildTargetRegistry(transaction, entry) ? "target" : "mismatch";
}

export function observeRebuildSession(
  transaction: RebuildTransactionRecordV1,
  session: Session | null,
  entry: SandboxEntry | null,
): RebuildSessionObservation {
  if (!session || !entry) return "missing";
  const correlation = session.metadata.rebuild;
  return session.sandboxName === transaction.intent.sandboxName &&
    correlation?.transactionId === transaction.transactionId &&
    correlation.imageFingerprint === transaction.intent.target.imageFingerprint &&
    correlation.configurationFingerprint === transaction.intent.target.configurationFingerprint &&
    correlation.replacementFingerprint === fingerprintRebuildReplacement(entry)
    ? "matching"
    : "unrelated";
}

/**
 * Pure recovery decision table. Collection of OpenShell, registry, backup, and
 * session evidence happens before this boundary; refusal never authorizes a
 * mutation or adoption.
 */
export function decideRebuildRecovery(input: {
  transaction: RebuildTransactionRecordV1;
  live: RebuildObservedLiveState;
  registry: RebuildRegistryObservation;
  session: RebuildSessionObservation;
}): RebuildRecoveryDecision {
  const { transaction, live, registry, session } = input;
  if (transaction.phase === "old_deleted") {
    if (live === "absent") {
      if (["source", "missing", "target"].includes(registry)) return { action: "create" };
      return {
        action: "refuse",
        code:
          registry === "mismatch"
            ? "REBUILD_RECOVERY_REGISTRY_CORRUPTED"
            : "REBUILD_RECOVERY_REGISTRY_MISMATCH",
      };
    }
    if (live !== "ready") {
      return { action: "refuse", code: "REBUILD_RECOVERY_LIVE_STATE_AMBIGUOUS" };
    }
    if (registry !== "target") {
      return { action: "refuse", code: "REBUILD_RECOVERY_REGISTRY_MISMATCH" };
    }
    return session === "matching"
      ? { action: "adopt" }
      : { action: "refuse", code: "REBUILD_RECOVERY_SESSION_MISMATCH" };
  }

  if (transaction.phase === "replacement_created") {
    if (registry !== "replacement") {
      return { action: "refuse", code: "REBUILD_RECOVERY_REGISTRY_MISMATCH" };
    }
    if (session !== "matching") {
      return { action: "refuse", code: "REBUILD_RECOVERY_SESSION_MISMATCH" };
    }
    if (live === "ready") return { action: "resume" };
    if (live === "absent") return { action: "recreate" };
    return { action: "refuse", code: "REBUILD_RECOVERY_LIVE_STATE_AMBIGUOUS" };
  }

  return { action: "create" };
}

/** Collect recovery evidence and apply only journal-owned registry restoration. */
export async function prepareRebuildRecoveryPreflight(input: {
  transaction: RebuildTransactionRecordV1 | null;
  resolveLiveState: () => Promise<RebuildLiveState | null>;
  readRegistryEntry: () => SandboxEntry | null;
  readSession: () => Session | null;
  restoreRegistry: (recovery: RebuildRegistryRecoveryV1) => boolean;
  log: RebuildLog;
  bail: RebuildBail;
}) {
  const liveState = await input.resolveLiveState();
  if (!liveState) return null;
  const transaction = input.transaction;
  if (!transaction || !["old_deleted", "replacement_created"].includes(transaction.phase)) {
    return { liveState, plan: null };
  }

  const registryEntry = input.readRegistryEntry();
  const decision = decideRebuildRecovery({
    transaction,
    live: liveState.observation,
    registry: observeRebuildRegistry(transaction, registryEntry),
    session: observeRebuildSession(transaction, input.readSession(), registryEntry),
  });
  if (decision.action === "refuse") {
    input.log("Durable rebuild recovery decision: refuse");
    printRebuildPreflightFailure(
      `the observed replacement cannot be proven to belong to rebuild transaction '${transaction.transactionId}' (${decision.code}).`,
      "Inspect the live sandbox, registry row, onboarding session, and validated backup; no recovery side effect was attempted.",
      "Rebuild replacement recovery failed",
      input.bail,
    );
    return null;
  }

  input.log(`Durable rebuild recovery decision: ${decision.action}`);
  if (
    decision.action === "create" &&
    !registryEntry &&
    input.restoreRegistry(transaction.intent.source.registryRecovery)
  ) {
    input.log("Restored missing registry recovery metadata from the rebuild journal");
  }
  return { liveState, plan: decision.action };
}
