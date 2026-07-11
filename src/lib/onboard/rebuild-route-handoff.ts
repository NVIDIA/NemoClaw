// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RecordedInferenceRoute } from "./provider-recovery";

export type RegistryInferenceRoute = Readonly<
  Omit<RecordedInferenceRoute, "source"> & {
    source: "registry";
  }
>;

/** Internal, non-persisted route handoff for one destructive rebuild. */
export type RebuildRouteHandoff = Readonly<{
  sandboxName: string;
  route: RegistryInferenceRoute;
}>;

/** Internal, non-persisted authority to upsert one preflighted provider during rebuild. */
export type RebuildProviderReconfigureHandoff = Readonly<{
  sandboxName: string;
  provider: string;
  model: string;
  credentialEnv: string;
  endpointUrl: string | null;
}>;

/**
 * Capture the pre-delete registry route as an immutable, defensive handoff.
 * The runtime source check keeps untyped callers from relabeling session state
 * as registry authority before the destructive rebuild begins.
 */
export function createRebuildRouteHandoff(
  sandboxName: string,
  route: RegistryInferenceRoute,
): RebuildRouteHandoff {
  if (route.source !== "registry") {
    throw new TypeError("Rebuild route handoff requires a registry-derived route");
  }
  const frozenRoute: RegistryInferenceRoute = Object.freeze({
    provider: route.provider,
    model: route.model,
    endpointUrl: route.endpointUrl,
    preferredInferenceApi: route.preferredInferenceApi,
    source: "registry",
  });
  return Object.freeze({ sandboxName, route: frozenRoute });
}

export function createRebuildProviderReconfigureHandoff(
  handoff: RebuildProviderReconfigureHandoff,
): RebuildProviderReconfigureHandoff {
  if (
    !handoff.sandboxName.trim() ||
    !handoff.provider.trim() ||
    !handoff.model.trim() ||
    !handoff.credentialEnv.trim()
  ) {
    throw new TypeError("Rebuild provider reconfigure handoff is incomplete");
  }
  return Object.freeze({ ...handoff });
}

/** Validate that a one-shot provider handoff still belongs to the authoritative resume target. */
export function validateRebuildProviderReconfigureHandoff(
  handoff: RebuildProviderReconfigureHandoff | null | undefined,
  target: RebuildProviderReconfigureHandoff,
): boolean {
  if (!handoff) return false;
  if (
    handoff.sandboxName !== target.sandboxName ||
    handoff.provider !== target.provider ||
    handoff.model !== target.model ||
    handoff.credentialEnv !== target.credentialEnv ||
    handoff.endpointUrl !== target.endpointUrl
  ) {
    throw new Error("Prepared provider reconfiguration does not match the authoritative target.");
  }
  return true;
}

/** Exact rebuild identity a provider-recovery receipt is bound to at preflight. */
export type ProviderRecoveryReceiptTarget = Readonly<{
  sandboxName: string;
  gatewayName: string;
  provider: string;
  model: string;
  route: RegistryInferenceRoute;
}>;

/**
 * One-shot authority to recover a recorded provider for an authoritative locked
 * rebuild. Minted after preflight validates the target, activated against the
 * live onboard session at provider selection, then rechecked inside the sandbox
 * and gateway mutation locks. `sessionId` is null until activation binds it.
 */
export type ProviderRecoveryReceipt = Readonly<{
  sandboxName: string;
  gatewayName: string;
  provider: string;
  model: string;
  route: RegistryInferenceRoute;
  nonce: string;
  expiresAtMs: number;
  sessionId: string | null;
}>;

function freezeRoute(route: RegistryInferenceRoute): RegistryInferenceRoute {
  if (route.source !== "registry") {
    throw new TypeError("Provider recovery receipt requires a registry-derived route");
  }
  return Object.freeze({
    provider: route.provider,
    model: route.model,
    endpointUrl: route.endpointUrl,
    preferredInferenceApi: route.preferredInferenceApi,
    source: "registry",
  });
}

function routesMatch(left: RegistryInferenceRoute, right: RegistryInferenceRoute): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.endpointUrl === right.endpointUrl &&
    left.preferredInferenceApi === right.preferredInferenceApi
  );
}

function receiptMatchesTarget(
  receipt: ProviderRecoveryReceipt,
  target: ProviderRecoveryReceiptTarget,
): boolean {
  return (
    receipt.sandboxName === target.sandboxName &&
    receipt.gatewayName === target.gatewayName &&
    receipt.provider === target.provider &&
    receipt.model === target.model &&
    routesMatch(receipt.route, target.route)
  );
}

/** Mint a target-bound, time-boxed recovery receipt after preflight validation. */
export function mintProviderRecoveryReceipt(
  target: ProviderRecoveryReceiptTarget,
  minting: { nonce: string; expiresAtMs: number },
): ProviderRecoveryReceipt {
  if (
    !target.sandboxName.trim() ||
    !target.gatewayName.trim() ||
    !target.provider.trim() ||
    !target.model.trim() ||
    !minting.nonce.trim() ||
    !Number.isFinite(minting.expiresAtMs)
  ) {
    throw new TypeError("Provider recovery receipt is incomplete");
  }
  return Object.freeze({
    sandboxName: target.sandboxName,
    gatewayName: target.gatewayName,
    provider: target.provider,
    model: target.model,
    route: freezeRoute(target.route),
    nonce: minting.nonce,
    expiresAtMs: minting.expiresAtMs,
    sessionId: null,
  });
}

function receiptIsWellFormed(
  receipt: ProviderRecoveryReceipt | null | undefined,
): receipt is ProviderRecoveryReceipt {
  return Boolean(
    receipt &&
      typeof receipt.sandboxName === "string" &&
      receipt.sandboxName &&
      typeof receipt.gatewayName === "string" &&
      receipt.gatewayName &&
      typeof receipt.provider === "string" &&
      receipt.provider &&
      typeof receipt.model === "string" &&
      receipt.model &&
      typeof receipt.nonce === "string" &&
      receipt.nonce &&
      Number.isFinite(receipt.expiresAtMs) &&
      receipt.route?.source === "registry",
  );
}

/**
 * Single-use ledger binding each minted receipt to exactly one onboard session
 * at provider selection, then answering in-lock rechecks for that binding. The
 * ledger is what makes recovery authorization one-shot: a second activation of
 * the same nonce is a replay and is refused.
 */
export function createProviderRecoveryReceiptLedger(): {
  activate(
    receipt: ProviderRecoveryReceipt | null | undefined,
    context: { target: ProviderRecoveryReceiptTarget; sessionId: string; nowMs: number },
  ): ProviderRecoveryReceipt | null;
  validateInLock(
    receipt: ProviderRecoveryReceipt | null | undefined,
    check: {
      sandboxName: string;
      gatewayName: string;
      sessionId: string | null | undefined;
      nowMs: number;
      reservationOwned: boolean;
    },
  ): boolean;
} {
  const activatedSessionByNonce = new Map<string, string>();
  return {
    activate(receipt, context) {
      if (!receiptIsWellFormed(receipt)) return null;
      if (!context.sessionId) return null;
      if (context.nowMs > receipt.expiresAtMs) return null;
      if (!receiptMatchesTarget(receipt, context.target)) return null;
      if (activatedSessionByNonce.has(receipt.nonce)) return null;
      activatedSessionByNonce.set(receipt.nonce, context.sessionId);
      return Object.freeze({ ...receipt, sessionId: context.sessionId });
    },
    validateInLock(receipt, check) {
      if (!receiptIsWellFormed(receipt)) return false;
      if (!check.reservationOwned) return false;
      if (!check.sessionId || receipt.sessionId !== check.sessionId) return false;
      if (activatedSessionByNonce.get(receipt.nonce) !== check.sessionId) return false;
      if (check.nowMs > receipt.expiresAtMs) return false;
      if (receipt.sandboxName !== check.sandboxName || receipt.gatewayName !== check.gatewayName) {
        return false;
      }
      return true;
    },
  };
}
