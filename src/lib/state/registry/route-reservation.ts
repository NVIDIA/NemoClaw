// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { normalizeInferenceSelection, type InferenceSelection } from "../../inference/selection";
import { load } from "./persistence";
import type { SandboxEntry } from "./types";

const ROUTE_RESERVATION_KEY_LIST = [
  "credentialEnv",
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
  "preferredInferenceApi",
  "provider",
  "reservationSessionId",
] as const satisfies readonly (keyof SandboxEntry)[];
const ROUTE_RESERVATION_KEYS = new Set<keyof SandboxEntry>(ROUTE_RESERVATION_KEY_LIST);
const ROUTE_SELECTION_KEYS = [
  "provider",
  "model",
  "endpointUrl",
  "endpointSource",
  "credentialEnv",
  "preferredInferenceApi",
] as const;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface SandboxInferenceRouteReservationAuthority {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly sessionId: string;
  readonly selection: InferenceSelection;
}

export interface QualifiedSandboxInferenceRouteReservation {
  readonly authority: SandboxInferenceRouteReservationAuthority;
  /** Exact route-only projection; this object never grants sandbox authority. */
  readonly entry: Pick<SandboxEntry, "name"> & Partial<SandboxEntry>;
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

/** Return field names only so route diagnostics cannot disclose endpoint or credential data. */
export function sandboxInferenceRouteMismatchFields(
  actual: InferenceSelection,
  expected: InferenceSelection,
): (typeof ROUTE_SELECTION_KEYS)[number][] {
  const normalizedActual = normalizeSandboxInferenceRouteSelection(actual);
  const normalizedExpected = normalizeSandboxInferenceRouteSelection(expected);
  return ROUTE_SELECTION_KEYS.filter(
    (field) => !isDeepStrictEqual(normalizedActual[field], normalizedExpected[field]),
  );
}

function routeReservationEntry(
  entry: SandboxEntry,
): QualifiedSandboxInferenceRouteReservation["entry"] {
  const projected: Partial<SandboxEntry> = {};
  for (const key of ROUTE_RESERVATION_KEY_LIST) {
    if (Object.hasOwn(entry, key)) {
      Object.assign(projected, { [key]: structuredClone(entry[key]) });
    }
  }
  return projected as QualifiedSandboxInferenceRouteReservation["entry"];
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
export function isPublishedSandboxRegistration(entry: {
  pendingRouteReservation?: true;
}): boolean {
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
  return qualifySandboxInferenceRouteReservation(authority, entry, true);
}

/** Qualify an exact session-owned pending route without copying sandbox authority. */
export function qualifyPendingSandboxInferenceRouteReservation(
  authority: SandboxInferenceRouteReservationAuthority,
  entry: SandboxEntry | null,
): SandboxInferenceRouteReservationDisposition {
  return qualifySandboxInferenceRouteReservation(authority, entry, false);
}

/** Capture the exact pending route owned by one onboarding session. */
export function getOwnedSandboxInferenceRouteReservation(
  sandboxName: string,
  gatewayName: string,
  sessionId: string,
): QualifiedSandboxInferenceRouteReservation | null {
  const entry = load().sandboxes[sandboxName] ?? null;
  const disposition = qualifyPendingSandboxInferenceRouteReservation(
    {
      sandboxName,
      gatewayName,
      sessionId,
      selection: normalizeInferenceSelection(entry),
    },
    entry,
  );
  return disposition.kind === "owned" ? disposition.reservation : null;
}

function qualifySandboxInferenceRouteReservation(
  authority: SandboxInferenceRouteReservationAuthority,
  entry: SandboxEntry | null,
  requireRouteOnly: boolean,
): SandboxInferenceRouteReservationDisposition {
  if (!entry) return { kind: "missing" };
  if (entry.pendingRouteReservation !== true) return { kind: "not-reservation" };
  if (requireRouteOnly && !isRouteOnlySandboxReservation(entry)) {
    return { kind: "conflict", detail: "the inference route reservation is already completed" };
  }
  if (!isPendingReservationForSession(entry, authority.sessionId)) {
    return {
      kind: "conflict",
      detail: "the inference route reservation belongs to another onboarding session",
    };
  }
  if (
    requireRouteOnly &&
    Object.keys(entry).some((key) => !ROUTE_RESERVATION_KEYS.has(key as keyof SandboxEntry))
  ) {
    return { kind: "conflict", detail: "the inference route reservation has sandbox authority" };
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
      entry: routeReservationEntry(entry),
    },
  };
}

/** Requalify the same reservation generation before a protected operation. */
export function isCurrentSandboxInferenceRouteReservation(
  reservation: QualifiedSandboxInferenceRouteReservation,
  entry: SandboxEntry | null,
): boolean {
  const current = qualifyPendingSandboxInferenceRouteReservation(reservation.authority, entry);
  return (
    current.kind === "owned" && isDeepStrictEqual(current.reservation.entry, reservation.entry)
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
    sandboxInferenceRouteMismatchFields(
      normalizeInferenceSelection(entry),
      reservation.authority.selection,
    ).length === 0
  );
}
