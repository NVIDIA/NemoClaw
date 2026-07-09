// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fingerprintRebuildRegistryEntry,
  fingerprintRebuildReplacement,
  fingerprintRebuildValue,
} from "../../rebuild-correlation";
import type { Session } from "../../state/onboard-session";
import type { RebuildTransactionRecordV1 } from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";

export type RebuildObservedLiveState = "absent" | "not_ready" | "ready" | "unknown_present";
export type RebuildRecoveryAction = "adopt" | "create" | "recreate" | "resume";

export type RebuildRecoveryDecision =
  | { action: RebuildRecoveryAction }
  | { action: "refuse"; code: RebuildRecoveryRefusalCode };

export type RebuildRecoveryRefusalCode =
  | "REBUILD_RECOVERY_LIVE_STATE_AMBIGUOUS"
  | "REBUILD_RECOVERY_REGISTRY_MISMATCH"
  | "REBUILD_RECOVERY_SESSION_MISMATCH";

export type RebuildRegistryObservation =
  | "mismatch"
  | "missing"
  | "replacement"
  | "source"
  | "target";
export type RebuildSessionObservation = "matching" | "missing" | "unrelated";

/** Stable target fields that are published by the recreated onboard run. */
export function matchesRebuildTargetRegistry(
  transaction: RebuildTransactionRecordV1,
  entry: SandboxEntry,
): boolean {
  const target = transaction.intent.target;
  const endpointMatches =
    target.endpointFingerprint === null
      ? entry.endpointUrl == null
      : typeof entry.endpointUrl === "string" &&
        fingerprintRebuildValue(entry.endpointUrl) === target.endpointFingerprint;
  const configurationMatches =
    fingerprintRebuildValue({
      fromDockerfile: entry.fromDockerfile ?? null,
      preferredInferenceApi: entry.preferredInferenceApi ?? null,
      compatibleEndpointReasoning: entry.compatibleEndpointReasoning ?? null,
      policyTier: entry.policyTier ?? null,
    }) === target.configurationFingerprint;

  return (
    entry.name === transaction.intent.sandboxName &&
    entry.agent === target.agent &&
    entry.provider === target.provider &&
    entry.model === target.model &&
    (entry.credentialEnv ?? null) === target.credentialEnv &&
    (entry.gatewayName ?? "nemoclaw") === target.gatewayName &&
    (entry.gatewayPort ?? 8080) === target.gatewayPort &&
    entry.toolDisclosure === target.toolDisclosure &&
    entry.observabilityEnabled === target.observabilityEnabled &&
    endpointMatches &&
    configurationMatches
  );
}

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
      return registry === "source" || registry === "missing"
        ? { action: "create" }
        : { action: "refuse", code: "REBUILD_RECOVERY_REGISTRY_MISMATCH" };
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
