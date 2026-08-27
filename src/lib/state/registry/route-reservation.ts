// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { normalizeInferenceSelection, type InferenceSelection } from "../../inference/selection";
import { isWebSearchProvider } from "../../inference/web-search/provider";
import type { SandboxEntry } from "./types";

const ROUTE_RESERVATION_KEYS = new Set<keyof SandboxEntry>([
  "credentialEnv",
  "dashboardPort",
  "endpointSource",
  "endpointUrl",
  "gatewayName",
  "gatewayPort",
  "hostLocalInferenceProvenance",
  "hostLocalInferenceReceipt",
  "model",
  "name",
  "openshellDriver",
  "pendingRouteReservation",
  "pendingPolicyVerification",
  "preferredInferenceApi",
  "policies",
  "policyPresetsFinalized",
  "policyTier",
  "provider",
  "reservationSessionId",
  "webSearchEnabled",
  "webSearchProvider",
]);

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function validCarriedRouteMetadata(entry: SandboxEntry): boolean {
  if (
    entry.dashboardPort !== undefined &&
    entry.dashboardPort !== null &&
    (!Number.isSafeInteger(entry.dashboardPort) ||
      entry.dashboardPort < 1 ||
      entry.dashboardPort > 65_535)
  ) {
    return false;
  }
  if (
    entry.policies !== undefined &&
    (!Array.isArray(entry.policies) ||
      entry.policies.some(
        (value) => typeof value !== "string" || value.length === 0 || CONTROL_CHARACTER.test(value),
      ) ||
      new Set(entry.policies).size !== entry.policies.length)
  ) {
    return false;
  }
  if (
    entry.policyPresetsFinalized !== undefined &&
    typeof entry.policyPresetsFinalized !== "boolean"
  ) {
    return false;
  }
  if (
    entry.policyTier !== undefined &&
    entry.policyTier !== null &&
    (typeof entry.policyTier !== "string" ||
      entry.policyTier.length === 0 ||
      CONTROL_CHARACTER.test(entry.policyTier))
  ) {
    return false;
  }
  if (entry.webSearchEnabled !== undefined && typeof entry.webSearchEnabled !== "boolean") {
    return false;
  }
  return (
    entry.webSearchProvider === undefined ||
    entry.webSearchProvider === null ||
    isWebSearchProvider(entry.webSearchProvider)
  );
}

export interface SandboxInferenceRouteReservationAuthority {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly sessionId: string;
  readonly selection: InferenceSelection;
}

export interface QualifiedSandboxInferenceRouteReservation {
  readonly authority: SandboxInferenceRouteReservationAuthority;
  readonly entry: SandboxEntry;
}

/** Exact pending row admitted for one sandbox create transaction. */
export interface QualifiedPendingSandboxCreateReservation {
  readonly authority: SandboxInferenceRouteReservationAuthority;
  readonly entry: SandboxEntry;
}

export type SandboxInferenceRouteReservationDisposition =
  | { readonly kind: "missing" }
  | { readonly kind: "owned"; readonly reservation: QualifiedSandboxInferenceRouteReservation }
  | { readonly kind: "not-reservation" }
  | { readonly kind: "conflict"; readonly detail: string };

export function normalizeSandboxInferenceRouteSelection(input: InferenceSelection) {
  const normalized = normalizeInferenceSelection(input);
  return {
    provider: normalized.provider,
    model: normalized.model,
    endpointUrl: normalized.endpointUrl,
    endpointSource: normalized.endpointSource,
    credentialEnv: normalized.credentialEnv,
    preferredInferenceApi: normalized.preferredInferenceApi,
  };
}

/** Admit the full pending row used by a create, including preserved rebuild metadata. */
export function qualifyPendingSandboxCreateReservation(
  authority: SandboxInferenceRouteReservationAuthority,
  entry: SandboxEntry | null,
): QualifiedPendingSandboxCreateReservation {
  if (
    !entry ||
    entry.pendingRouteReservation !== true ||
    !authority.sessionId ||
    entry.reservationSessionId !== authority.sessionId ||
    entry.name !== authority.sandboxName ||
    entry.gatewayName !== authority.gatewayName ||
    !isDeepStrictEqual(
      normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(entry)),
      normalizeSandboxInferenceRouteSelection(authority.selection),
    )
  ) {
    throw new Error("The sandbox create route reservation is not owned by this onboarding session");
  }
  return { authority: structuredClone(authority), entry: structuredClone(entry) };
}

/** Compare the complete admitted create reservation before its first checkpoint write. */
export function isCurrentPendingSandboxCreateReservation(
  reservation: QualifiedPendingSandboxCreateReservation,
  entry: SandboxEntry | null,
): boolean {
  if (!entry) return false;
  try {
    const qualified = qualifyPendingSandboxCreateReservation(reservation.authority, entry);
    return isDeepStrictEqual(qualified.entry, reservation.entry);
  } catch {
    return false;
  }
}

/**
 * True only for an inference route reserved before sandbox registration.
 *
 * Structural parameter (only the two fields it reads) so display-layer entry
 * types that omit the rest of the durable registry shape can reuse this single
 * source of truth instead of re-deriving the predicate (#7609).
 */
export function isRouteOnlySandboxReservation(entry: {
  pendingRouteReservation?: true;
  createdAt?: string;
}): boolean {
  return entry.pendingRouteReservation === true && entry.createdAt === undefined;
}

/** True only for a completed registry entry available to normal sandbox consumers. */
export function isPublishedSandboxRegistration(entry: { pendingRouteReservation?: true }): boolean {
  return entry.pendingRouteReservation !== true;
}

/** Return true only when the pending inference route reservation belongs to the exact onboarding session. */
export function isPendingReservationForSession(
  entry: {
    pendingRouteReservation?: true;
    reservationSessionId?: string;
  } | null,
  sessionId: string | null | undefined,
): boolean {
  return (
    entry?.pendingRouteReservation === true &&
    Boolean(sessionId) &&
    entry.reservationSessionId === sessionId
  );
}

/** Qualify one exact pending route reservation without granting sandbox authority. */
export function classifySandboxInferenceRouteReservation(
  authority: SandboxInferenceRouteReservationAuthority,
  entry: SandboxEntry | null,
): SandboxInferenceRouteReservationDisposition {
  if (!entry) return { kind: "missing" };
  if (entry.pendingRouteReservation !== true) return { kind: "not-reservation" };
  if (!isRouteOnlySandboxReservation(entry)) {
    return { kind: "conflict", detail: "the inference route reservation is already completed" };
  }
  if (!isPendingReservationForSession(entry, authority.sessionId)) {
    return {
      kind: "conflict",
      detail: "the inference route reservation belongs to another onboarding session",
    };
  }
  if (Object.keys(entry).some((key) => !ROUTE_RESERVATION_KEYS.has(key as keyof SandboxEntry))) {
    return { kind: "conflict", detail: "the inference route reservation has sandbox authority" };
  }
  if (!validCarriedRouteMetadata(entry)) {
    return {
      kind: "conflict",
      detail: "the inference route reservation carry metadata is malformed",
    };
  }
  if (entry.name !== authority.sandboxName || entry.gatewayName !== authority.gatewayName) {
    return {
      kind: "conflict",
      detail: "the inference route reservation has another sandbox or gateway",
    };
  }
  const expectedSelection = normalizeSandboxInferenceRouteSelection(authority.selection);
  if (
    !authority.sessionId ||
    authority.sessionId.length > 256 ||
    CONTROL_CHARACTER.test(authority.sessionId) ||
    !expectedSelection.provider ||
    !expectedSelection.model ||
    !isDeepStrictEqual(
      normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(entry)),
      expectedSelection,
    )
  ) {
    return { kind: "conflict", detail: "the inference route reservation has another route" };
  }
  if (
    (entry.gatewayPort !== undefined &&
      (typeof entry.gatewayPort !== "number" ||
        !Number.isSafeInteger(entry.gatewayPort) ||
        entry.gatewayPort < 1 ||
        entry.gatewayPort > 65_535)) ||
    (entry.openshellDriver !== undefined &&
      (typeof entry.openshellDriver !== "string" || entry.openshellDriver.length === 0)) ||
    (entry.hostLocalInferenceReceipt !== undefined &&
      entry.hostLocalInferenceReceipt !== null &&
      (typeof entry.hostLocalInferenceReceipt !== "string" ||
        entry.hostLocalInferenceReceipt.length === 0)) ||
    (entry.hostLocalInferenceProvenance !== undefined &&
      (typeof entry.hostLocalInferenceProvenance !== "object" ||
        entry.hostLocalInferenceProvenance === null ||
        Array.isArray(entry.hostLocalInferenceProvenance) ||
        typeof entry.hostLocalInferenceReceipt !== "string"))
  ) {
    return { kind: "conflict", detail: "the inference route reservation is malformed" };
  }
  return {
    kind: "owned",
    reservation: {
      authority: {
        ...authority,
        selection: { ...authority.selection },
      },
      entry: structuredClone(entry),
    },
  };
}

/** Requalify the same reservation generation before a protected operation. */
export function isCurrentSandboxInferenceRouteReservation(
  reservation: QualifiedSandboxInferenceRouteReservation,
  entry: SandboxEntry | null,
): boolean {
  const current = classifySandboxInferenceRouteReservation(reservation.authority, entry);
  if (current.kind !== "owned") return false;
  const { pendingPolicyVerification: currentCheckpoint, ...currentRoute } =
    current.reservation.entry;
  const { pendingPolicyVerification: reservedCheckpoint, ...reservedRoute } = reservation.entry;
  return (
    isDeepStrictEqual(currentRoute, reservedRoute) &&
    (reservedCheckpoint === undefined ||
      isDeepStrictEqual(currentCheckpoint, reservedCheckpoint))
  );
}

/** Require the final registration to preserve the route selected by the reservation. */
export function sandboxRegistrationMatchesInferenceRouteReservation(
  entry: SandboxEntry,
  reservation: QualifiedSandboxInferenceRouteReservation,
): boolean {
  return (
    entry.name === reservation.authority.sandboxName &&
    entry.gatewayName === reservation.authority.gatewayName &&
    entry.pendingRouteReservation !== true &&
    isDeepStrictEqual(
      normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(entry)),
      normalizeSandboxInferenceRouteSelection(reservation.authority.selection),
    )
  );
}
