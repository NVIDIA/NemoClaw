// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type { InferenceSelection } from "../inference/selection";
import {
  inferenceSelectionRegistryFields,
  normalizeInferenceSelection,
} from "../inference/selection";
import { parseServingProfileProvenance } from "../inference/serving/profile-provenance";
import { normalizeToolDisclosure } from "../tool-disclosure";
import {
  cloneSandboxHostLocalInferenceProvenance,
  cloneSandboxHostLocalInferenceReceipt,
  requireSandboxHostLocalInferenceProvenance,
} from "./registry/host-local-inference";
import { withLock } from "./registry/lock";
import { load, save } from "./registry/persistence";
import {
  isCurrentSandboxInferenceRouteReservation,
  isCurrentPendingSandboxCreateReservation,
  normalizeSandboxInferenceRouteSelection,
  sandboxRegistrationMatchesInferenceRouteReservation,
  type QualifiedPendingSandboxCreateReservation,
  type QualifiedSandboxInferenceRouteReservation,
} from "./registry/route-reservation";
export {
  classifySandboxInferenceRouteReservation,
  isCurrentSandboxInferenceRouteReservation,
  isCurrentPendingSandboxCreateReservation,
  isPendingReservationForSession,
  isPublishedSandboxRegistration,
  isRouteOnlySandboxReservation,
  normalizeSandboxInferenceRouteSelection,
  qualifyPendingSandboxCreateReservation,
  sandboxRegistrationMatchesInferenceRouteReservation,
  type QualifiedSandboxInferenceRouteReservation,
  type QualifiedPendingSandboxCreateReservation,
  type SandboxInferenceRouteReservationAuthority,
  type SandboxInferenceRouteReservationDisposition,
} from "./registry/route-reservation";
import { cloneSandboxWorkloadReceipt } from "./registry/workload";
import { normalizeSandboxMcpState } from "./registry-mcp";
import {
  normalizePendingSandboxCreateIdentity,
  normalizeSandboxPolicyAttribution,
  retainedDefaultSandbox,
} from "./registry-normalization";
import * as reversibleRemoval from "./registry-reversible-removal";

export {
  getSandboxEntryDisplayInference,
  getSandboxEntryInference,
  type SandboxEntryDisplayInference,
  type SandboxEntryInference,
} from "./registry-entry-view";
export {
  cloneSandboxHostLocalInferenceProvenance,
  cloneSandboxHostLocalInferenceReceipt,
  requireSandboxHostLocalInferenceProvenance,
};
export {
  addExtraProvider,
  listExtraProviders,
  removeExtraProvider,
} from "./registry/extra-providers";
export {
  listManagedMcpCredentialReservations,
  type ManagedMcpCredentialReservation,
} from "./registry/mcp-credential-reservations";

import { isDcodeAutoApprovalMode } from "../onboard/dcode-auto-approval";
import { cloneSandboxHostMounts, hasUnsafeHostMountTerminalText } from "./registry/host-mount";
import type { PendingSandboxCreateIdentity, SandboxEntry } from "./registry/types";
import {
  cloneSandboxMessagingState,
  getConfiguredMessagingChannels as getRegistryConfiguredMessagingChannels,
  getDisabledChannels as getRegistryDisabledChannels,
  setChannelDisabled as setRegistryChannelDisabled,
} from "./registry-messaging";

// Compatibility exports for #7694. The registry/types, registry/lock, and
// registry/persistence modules are authoritative. New code must import those
// modules directly. Remove these exports after facade callers migrate.
export {
  acquireLock,
  classifyExistingLock,
  LOCK_DIR,
  LOCK_MAX_RETRIES,
  LOCK_OWNER,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  type RegistryLockDecision,
  releaseLock,
  withLock,
} from "./registry/lock";
export { load, REGISTRY_FILE, save } from "./registry/persistence";
export type {
  SandboxEntry,
  SandboxGpuProofResult,
  SandboxGpuProofStatus,
  SandboxHostMount,
  PendingSandboxCreateIdentity,
  SandboxRegistry,
  SandboxWorkloadReceipt,
} from "./registry/types";
export type { McpBridgeEntry, SandboxMcpState } from "./registry-mcp";
export {
  getConfiguredMessagingChannelsFromEntry,
  getDisabledMessagingChannelsFromEntry,
  getHydratedMessagingPlanFromEntry,
  getMessagingPlanFromEntry,
  type SandboxMessagingState,
} from "./registry-messaging";
export { hasUnsafeHostMountTerminalText, normalizeSandboxPolicyAttribution };

export type SandboxRemovalReceipt = reversibleRemoval.RegistryRemovalReceipt<SandboxEntry>;

export function getSandbox(name: string): SandboxEntry | null {
  return load().sandboxes[name] || null;
}

export function getDefault(): string | null {
  const data = load();
  if (
    data.defaultSandbox &&
    data.sandboxes[data.defaultSandbox] &&
    data.sandboxes[data.defaultSandbox].pendingRouteReservation !== true
  ) {
    return data.defaultSandbox;
  }
  const names = Object.values(data.sandboxes)
    .filter((sandbox) => sandbox.pendingRouteReservation !== true)
    .map((sandbox) => sandbox.name);
  return names.length > 0 ? names[0] || null : null;
}

function pendingVerifiedCreateEntry(
  reservation: QualifiedPendingSandboxCreateReservation,
  checkpoint: PendingSandboxCreateIdentity,
): SandboxEntry {
  return normalizeSandboxPolicyAttribution({
    ...reservation.entry,
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    pendingCreateIdentity: checkpoint,
  });
}

function assertPendingCreateIdentityMatchesRegistration(
  recordedEntry: SandboxEntry | undefined,
  requestedEntry: SandboxEntry,
  authority:
    | {
        readonly reservation: QualifiedPendingSandboxCreateReservation;
        readonly checkpoint: PendingSandboxCreateIdentity;
      }
    | undefined,
): void {
  const checkpoint = normalizePendingSandboxCreateIdentity(recordedEntry?.pendingCreateIdentity);
  const expectedCheckpoint = normalizePendingSandboxCreateIdentity(authority?.checkpoint);
  if (!authority) {
    if (checkpoint) {
      throw new Error(
        "Cannot publish a verified create checkpoint without exact transaction authority",
      );
    }
    return;
  }
  if (!checkpoint || !expectedCheckpoint || !isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
    throw new Error(
      "Cannot publish a sandbox registration after its verified create checkpoint changed",
    );
  }
  const reservation = authority.reservation;
  if (
    !isCurrentPendingSandboxCreateReservation(reservation, reservation.entry) ||
    !recordedEntry ||
    !isDeepStrictEqual(recordedEntry, pendingVerifiedCreateEntry(reservation, expectedCheckpoint))
  ) {
    throw new Error(
      "Cannot publish a sandbox registration after its verified create transaction changed",
    );
  }
  const commonChecks = [
    ["pending route reservation", recordedEntry?.pendingRouteReservation === true],
    [
      "reservation session",
      recordedEntry?.reservationSessionId === reservation.authority.sessionId,
    ],
    [
      "recorded lifecycle generation",
      recordedEntry?.lifecycleGeneration === checkpoint.lifecycleGeneration,
    ],
    [
      "recorded lifecycle identity",
      recordedEntry?.lifecycleLiveIdentityFingerprint === checkpoint.sandboxIdentityFingerprint,
    ],
    ["sandbox name", checkpoint.sandboxName === requestedEntry.name],
    ["gateway name", checkpoint.gatewayName === requestedEntry.gatewayName],
    ["gateway port", checkpoint.gatewayPort === requestedEntry.gatewayPort],
    [
      "requested lifecycle generation",
      checkpoint.lifecycleGeneration === requestedEntry.lifecycleGeneration,
    ],
    [
      "requested lifecycle identity",
      checkpoint.sandboxIdentityFingerprint === requestedEntry.lifecycleLiveIdentityFingerprint,
    ],
    ["reservation sandbox", reservation.authority.sandboxName === requestedEntry.name],
    ["reservation gateway", reservation.authority.gatewayName === requestedEntry.gatewayName],
    [
      "recorded inference route",
      isDeepStrictEqual(
        normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(recordedEntry)),
        normalizeSandboxInferenceRouteSelection(reservation.authority.selection),
      ),
    ],
    [
      "requested inference route",
      isDeepStrictEqual(
        normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(requestedEntry)),
        normalizeSandboxInferenceRouteSelection(reservation.authority.selection),
      ),
    ],
  ] as const;
  const mismatches: string[] = commonChecks.filter(([, matches]) => !matches).map(([name]) => name);
  if (mismatches.length > 0) {
    throw new Error(
      `Cannot publish a sandbox registration that differs from its verified create checkpoint (${mismatches.join(", ")})`,
    );
  }
}

/** Persist the exact verified create boundary before any unrelated post-create effect. */
export function recordPendingSandboxCreateIdentity(
  reservation: QualifiedPendingSandboxCreateReservation,
  value: PendingSandboxCreateIdentity,
  options: { readonly expected?: PendingSandboxCreateIdentity } = {},
): SandboxEntry {
  const checkpoint = normalizePendingSandboxCreateIdentity(value);
  const expected = normalizePendingSandboxCreateIdentity(options.expected);
  const { authority } = reservation;
  const name = authority.sandboxName;
  if (
    !checkpoint ||
    !authority.sessionId ||
    checkpoint.sandboxName !== name ||
    checkpoint.gatewayName !== authority.gatewayName ||
    !isCurrentPendingSandboxCreateReservation(reservation, reservation.entry)
  ) {
    throw new Error("Cannot record an incomplete verified sandbox create checkpoint");
  }
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[name];
    const recordedCheckpoint = normalizePendingSandboxCreateIdentity(
      current?.pendingCreateIdentity,
    );
    if (!current) {
      throw new Error(
        `Cannot record sandbox '${name}' create identity after its route reservation changed`,
      );
    }
    const desiredEntry = pendingVerifiedCreateEntry(reservation, checkpoint);
    if (isDeepStrictEqual(current, desiredEntry)) {
      return structuredClone(current);
    }
    if (expected === undefined) {
      if (
        recordedCheckpoint !== undefined ||
        !isCurrentPendingSandboxCreateReservation(reservation, current)
      ) {
        throw new Error(
          `Cannot record sandbox '${name}' create identity after its route reservation changed`,
        );
      }
    } else {
      const expectedEntry = pendingVerifiedCreateEntry(reservation, expected);
      if (
        !recordedCheckpoint ||
        !isDeepStrictEqual(current, expectedEntry) ||
        checkpoint.lifecycleGeneration !== expected.lifecycleGeneration ||
        checkpoint.gatewayName !== expected.gatewayName ||
        checkpoint.gatewayPort !== expected.gatewayPort ||
        checkpoint.sandboxName !== expected.sandboxName
      ) {
        throw new Error(
          `Cannot replace sandbox '${name}' verified create checkpoint without exact authority`,
        );
      }
    }
    data.sandboxes[name] = desiredEntry;
    save(data);
    return structuredClone(desiredEntry);
  });
}

/** Re-read one durable verified create checkpoint before releasing an effect. */
export function requireCurrentPendingSandboxCreateIdentity(
  reservation: QualifiedPendingSandboxCreateReservation,
  expected: PendingSandboxCreateIdentity,
): SandboxEntry {
  const checkpoint = normalizePendingSandboxCreateIdentity(expected);
  const { authority } = reservation;
  const name = authority.sandboxName;
  const current = load().sandboxes[name];
  if (
    !checkpoint ||
    !isCurrentPendingSandboxCreateReservation(reservation, reservation.entry) ||
    !current ||
    !isDeepStrictEqual(current, pendingVerifiedCreateEntry(reservation, checkpoint))
  ) {
    throw new Error(
      `Cannot continue sandbox '${name}' creation after its verified checkpoint changed`,
    );
  }
  return structuredClone(current);
}

export function registerSandbox(
  entry: SandboxEntry,
  routeReservation?: QualifiedSandboxInferenceRouteReservation,
  options: {
    pending?: boolean;
    reservationSessionId?: string;
    verifiedCreate?: {
      readonly reservation: QualifiedPendingSandboxCreateReservation;
      readonly checkpoint: PendingSandboxCreateIdentity;
    };
  } = {},
): SandboxEntry {
  return withLock(() => {
    const data = load();
    const recordedEntry = data.sandboxes[entry.name];
    if (entry.pendingCreateIdentity !== undefined) {
      throw new Error("Cannot publish a caller-supplied pending create identity");
    }
    if (routeReservation && options.pending !== true && !options.verifiedCreate) {
      throw new Error(
        "Cannot consume a create route reservation without its pending create identity",
      );
    }
    if (
      routeReservation &&
      options.verifiedCreate &&
      !isDeepStrictEqual(routeReservation, options.verifiedCreate.reservation)
    ) {
      throw new Error(
        "Cannot publish a verified sandbox create with a different route reservation authority",
      );
    }
    if (
      routeReservation &&
      ((!options.verifiedCreate &&
        !isCurrentSandboxInferenceRouteReservation(
          routeReservation,
          data.sandboxes[entry.name] ?? null,
        )) ||
        !sandboxRegistrationMatchesInferenceRouteReservation(entry, routeReservation))
    ) {
      throw new Error("Cannot register a sandbox after its inference route reservation changed");
    }
    if (
      !routeReservation &&
      !options.verifiedCreate &&
      recordedEntry?.pendingRouteReservation === true &&
      typeof recordedEntry.reservationSessionId === "string" &&
      recordedEntry.reservationSessionId.length > 0 &&
      (options.pending !== true ||
        typeof options.reservationSessionId !== "string" ||
        options.reservationSessionId.length === 0 ||
        options.reservationSessionId !== recordedEntry.reservationSessionId)
    ) {
      throw new Error("Cannot stage a sandbox after its inference route reservation changed");
    }
    if (options.reservationSessionId) {
      if (
        recordedEntry?.pendingRouteReservation !== true ||
        recordedEntry.reservationSessionId !== options.reservationSessionId ||
        recordedEntry.gatewayName !== entry.gatewayName ||
        !isDeepStrictEqual(
          normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(recordedEntry)),
          normalizeSandboxInferenceRouteSelection(normalizeInferenceSelection(entry)),
        )
      ) {
        throw new Error("Cannot stage a sandbox after its inference route reservation changed");
      }
    }
    if (
      recordedEntry?.pendingRouteReservation === true &&
      options.pending !== true &&
      !options.verifiedCreate
    ) {
      throw new Error(
        "Cannot publish a pending sandbox create without its pending create identity",
      );
    }
    const servingProfileProvenance = parseServingProfileProvenance(entry.servingProfileProvenance);
    if (entry.servingProfileProvenance !== undefined && !servingProfileProvenance) {
      throw new Error("Cannot register a sandbox with invalid serving profile provenance");
    }
    const normalizedPolicyEntry = normalizeSandboxPolicyAttribution(entry);
    assertPendingCreateIdentityMatchesRegistration(
      recordedEntry,
      normalizedPolicyEntry,
      options.verifiedCreate,
    );
    const reservedGenerationChanged =
      recordedEntry?.pendingRouteReservation === true &&
      recordedEntry.lifecycleGeneration !== normalizedPolicyEntry.lifecycleGeneration;
    const reservedFingerprintChanged =
      recordedEntry?.pendingRouteReservation === true &&
      recordedEntry.lifecycleLiveIdentityFingerprint !==
        normalizedPolicyEntry.lifecycleLiveIdentityFingerprint;
    if (reservedGenerationChanged !== reservedFingerprintChanged) {
      throw new Error(
        "Cannot register a sandbox after only part of its reserved lifecycle identity changed",
      );
    }
    if (retainedDefaultSandbox(data.defaultSandbox, data.sandboxes) === null) {
      data.defaultSandbox = null;
    }
    const hostLocalInferenceReceipt = cloneSandboxHostLocalInferenceReceipt(
      entry.hostLocalInferenceReceipt,
    );
    if (entry.hostLocalInferenceReceipt !== undefined && hostLocalInferenceReceipt === undefined) {
      throw new Error("Cannot register a sandbox with an invalid host-local inference receipt");
    }
    const hostLocalInferenceProvenance = cloneSandboxHostLocalInferenceProvenance(
      entry.hostLocalInferenceProvenance,
    );
    if (
      entry.hostLocalInferenceProvenance !== undefined &&
      (!hostLocalInferenceProvenance || typeof hostLocalInferenceReceipt !== "string")
    ) {
      throw new Error("Cannot register a sandbox with invalid host-local inference provenance");
    }
    if (hostLocalInferenceProvenance && typeof hostLocalInferenceReceipt === "string") {
      requireSandboxHostLocalInferenceProvenance(
        hostLocalInferenceProvenance,
        hostLocalInferenceReceipt,
      );
      const reserved = data.sandboxes[entry.name];
      if (
        reserved?.pendingRouteReservation !== true ||
        reserved.hostLocalInferenceReceipt !== hostLocalInferenceReceipt ||
        !isDeepStrictEqual(reserved.hostLocalInferenceProvenance, hostLocalInferenceProvenance) ||
        reserved.provider !== entry.provider ||
        reserved.model !== entry.model ||
        reserved.endpointUrl !== entry.endpointUrl ||
        reserved.endpointSource !== entry.endpointSource ||
        reserved.credentialEnv !== entry.credentialEnv ||
        reserved.preferredInferenceApi !== entry.preferredInferenceApi ||
        reserved.openshellDriver !== entry.openshellDriver ||
        reserved.gatewayName !== entry.gatewayName ||
        reserved.gatewayPort !== entry.gatewayPort
      ) {
        throw new Error(
          "Cannot register a sandbox after its host-local inference reservation changed",
        );
      }
    }
    const registered: SandboxEntry = {
      name: entry.name,
      createdAt: entry.createdAt || new Date().toISOString(),
      servingProfileProvenance: servingProfileProvenance ?? undefined,
      ...inferenceSelectionRegistryFields(entry),
      gpuEnabled: entry.gpuEnabled || false,
      hostGpuDetected: entry.hostGpuDetected === true,
      sandboxGpuEnabled: entry.sandboxGpuEnabled === true,
      sandboxGpuMode: entry.sandboxGpuMode || null,
      sandboxGpuDevice: entry.sandboxGpuDevice || null,
      sandboxGpuProof: entry.sandboxGpuProof ?? null,
      hostMounts:
        Array.isArray(entry.hostMounts) && entry.hostMounts.length > 0
          ? cloneSandboxHostMounts(entry.hostMounts)
          : undefined,
      openshellDriver: entry.openshellDriver || null,
      openshellVersion: entry.openshellVersion || null,
      webSearchEnabled:
        typeof entry.webSearchEnabled === "boolean" ? entry.webSearchEnabled : undefined,
      // Preserve absence on reconstructed legacy rows. Only a freshly built
      // sandbox registration may claim the new progressive default.
      toolDisclosure: normalizeToolDisclosure(entry.toolDisclosure) ?? undefined,
      observabilityEnabled:
        typeof entry.observabilityEnabled === "boolean" ? entry.observabilityEnabled : undefined,
      dcodeAutoApprovalMode: isDcodeAutoApprovalMode(entry.dcodeAutoApprovalMode)
        ? entry.dcodeAutoApprovalMode
        : undefined,
      webSearchProvider:
        entry.webSearchEnabled === true &&
        (entry.webSearchProvider === "brave" || entry.webSearchProvider === "tavily")
          ? entry.webSearchProvider
          : null,
      agent: entry.agent || null,
      agentVersion: entry.agentVersion || null,
      openclawImagePluginInstalls: Array.isArray(entry.openclawImagePluginInstalls)
        ? entry.openclawImagePluginInstalls.map((install) => ({
            ...install,
            ...(install.loadPaths !== undefined ? { loadPaths: [...install.loadPaths] } : {}),
          }))
        : undefined,
      nemoclawVersion: entry.nemoclawVersion || null,
      fromDockerfile: entry.fromDockerfile || null,
      hermesAuthMethod:
        entry.hermesAuthMethod === "oauth" || entry.hermesAuthMethod === "api_key"
          ? entry.hermesAuthMethod
          : null,
      imageTag: entry.imageTag || null,
      workload: cloneSandboxWorkloadReceipt(entry.workload),
      ...(hostLocalInferenceReceipt !== undefined ? { hostLocalInferenceReceipt } : {}),
      ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
      lifecycleGeneration: entry.lifecycleGeneration,
      lifecycleLiveIdentityFingerprint: entry.lifecycleLiveIdentityFingerprint,
      messaging: cloneSandboxMessagingState(entry.messaging),
      mcp: normalizeSandboxMcpState(entry.mcp),
      hermesToolGateways:
        Array.isArray(entry.hermesToolGateways) && entry.hermesToolGateways.length > 0
          ? [...entry.hermesToolGateways]
          : undefined,
      hermesDashboardEnabled: entry.hermesDashboardEnabled === true ? true : undefined,
      hermesDashboardPort: entry.hermesDashboardPort ?? undefined,
      hermesDashboardInternalPort: entry.hermesDashboardInternalPort ?? undefined,
      hermesDashboardTui: entry.hermesDashboardTui === true ? true : undefined,
      hermesApiPort: entry.hermesApiPort ?? undefined,
      dashboardPort: entry.dashboardPort ?? undefined,
      dashboardRemoteBindPrepared: entry.dashboardRemoteBindPrepared === true ? true : undefined,
      gatewayName: entry.gatewayName ?? undefined,
      gatewayPort: entry.gatewayPort ?? undefined,
      pendingRouteReservation: options.pending === true ? true : undefined,
      reservationSessionId: options.pending === true ? options.reservationSessionId : undefined,
    };
    data.sandboxes[entry.name] = registered;
    save(
      options.pending === true
        ? data
        : reversibleRemoval.claimInitialDefaultInRegistry(data, entry.name),
    );
    return structuredClone(registered);
  });
}

type SandboxInferenceRouteReservation = Pick<
  InferenceSelection,
  | "provider"
  | "model"
  | "endpointUrl"
  | "endpointSource"
  | "credentialEnv"
  | "preferredInferenceApi"
> & {
  gatewayName: string;
  gatewayPort?: number;
  openshellDriver?: string;
  reservationSessionId?: string;
  hostLocalInferenceReceipt?: string | null;
  hostLocalInferenceProvenance?: SandboxEntry["hostLocalInferenceProvenance"];
};

interface SandboxInferenceRouteReservationOptions {
  /** Refuse instead of changing any existing registry row. */
  requireAbsent?: boolean;
}

/**
 * Persist a route dependency before releasing the shared-gateway mutation
 * lock. A newly reserved row deliberately does not claim the default sandbox;
 * normal sandbox registration replaces it after creation completes.
 */
export function reserveSandboxInferenceRoute(
  name: string,
  route: SandboxInferenceRouteReservation,
  options: SandboxInferenceRouteReservationOptions = {},
): boolean {
  return withLock(() => {
    const data = load();
    const existing = data.sandboxes[name];
    if (options.requireAbsent === true && existing !== undefined) return false;
    const normalized = normalizeInferenceSelection(route);
    const provenance = cloneSandboxHostLocalInferenceProvenance(route.hostLocalInferenceProvenance);
    if (
      route.hostLocalInferenceProvenance !== undefined &&
      (!provenance || typeof route.hostLocalInferenceReceipt !== "string")
    ) {
      throw new Error("Cannot reserve invalid host-local inference provenance");
    }
    if (provenance && typeof route.hostLocalInferenceReceipt === "string") {
      requireSandboxHostLocalInferenceProvenance(provenance, route.hostLocalInferenceReceipt);
      if (
        !Number.isSafeInteger(route.gatewayPort) ||
        Number(route.gatewayPort) < 1 ||
        Number(route.gatewayPort) > 65_535 ||
        typeof route.openshellDriver !== "string" ||
        route.openshellDriver.length === 0
      ) {
        throw new Error(
          "Cannot reserve host-local inference provenance without exact runtime and gateway authority",
        );
      }
    }
    const sameExplicitHostLocalRoute =
      existing?.hostLocalInferenceProvenance !== undefined &&
      Boolean(provenance) &&
      typeof route.hostLocalInferenceReceipt === "string" &&
      existing.hostLocalInferenceReceipt === route.hostLocalInferenceReceipt &&
      isDeepStrictEqual(existing.hostLocalInferenceProvenance, provenance) &&
      existing.provider === normalized.provider &&
      existing.model === normalized.model &&
      existing.endpointUrl === normalized.endpointUrl &&
      existing.endpointSource === normalized.endpointSource &&
      existing.credentialEnv === normalized.credentialEnv &&
      existing.preferredInferenceApi === normalized.preferredInferenceApi &&
      existing.gatewayName === route.gatewayName &&
      existing.gatewayPort === route.gatewayPort &&
      existing.openshellDriver === route.openshellDriver;
    if (existing?.hostLocalInferenceProvenance !== undefined && !sameExplicitHostLocalRoute) {
      throw new Error("Cannot change an explicit host-local inference lifecycle reservation");
    }
    if (existing?.pendingRouteReservation === true) {
      const sameReservation =
        (sameExplicitHostLocalRoute &&
          existing.reservationSessionId === undefined &&
          route.reservationSessionId === undefined) ||
        (Boolean(route.reservationSessionId) &&
          existing.reservationSessionId === route.reservationSessionId &&
          existing.gatewayName === route.gatewayName &&
          existing.gatewayPort === (route.gatewayPort ?? existing.gatewayPort) &&
          existing.openshellDriver === (route.openshellDriver ?? existing.openshellDriver) &&
          existing.hostLocalInferenceReceipt ===
            (route.hostLocalInferenceReceipt === undefined
              ? existing.hostLocalInferenceReceipt
              : route.hostLocalInferenceReceipt) &&
          isDeepStrictEqual(
            existing.hostLocalInferenceProvenance,
            route.hostLocalInferenceProvenance ?? existing.hostLocalInferenceProvenance,
          ) &&
          isDeepStrictEqual(
            normalizeInferenceSelection(existing),
            normalizeInferenceSelection(route),
          ));
      if (!sameReservation) {
        if (existing.pendingCreateIdentity) {
          throw new Error(
            `Cannot replace sandbox '${name}' while its verified create checkpoint is incomplete`,
          );
        }
        const detail =
          existing.reservationSessionId !== route.reservationSessionId
            ? "belongs to another onboarding session"
            : "cannot change before the owning create transaction completes";
        throw new Error(
          `Cannot replace sandbox '${name}': its inference route reservation ${detail}`,
        );
      }
      return true;
    }
    const existingForReservation: SandboxEntry = existing
      ? { ...existing }
      : { name, pendingRouteReservation: true };
    const next = normalizeSandboxPolicyAttribution({
      ...existingForReservation,
      pendingRouteReservation: true,
      reservationSessionId:
        route.reservationSessionId ??
        (existing?.pendingRouteReservation === true ? existing.reservationSessionId : undefined),
      provider: normalized.provider,
      model: normalized.model,
      endpointUrl: normalized.endpointUrl,
      endpointSource: normalized.endpointSource,
      credentialEnv: normalized.credentialEnv,
      preferredInferenceApi: normalized.preferredInferenceApi,
      ...(route.hostLocalInferenceReceipt !== undefined
        ? { hostLocalInferenceReceipt: route.hostLocalInferenceReceipt }
        : {}),
      ...(provenance ? { hostLocalInferenceProvenance: provenance } : {}),
      gatewayName: route.gatewayName,
      gatewayPort:
        route.gatewayPort ??
        (existing?.gatewayName === route.gatewayName ? existing.gatewayPort : undefined),
      ...(route.openshellDriver === undefined ? {} : { openshellDriver: route.openshellDriver }),
    });
    data.sandboxes[name] = next;
    save(data);
    return true;
  });
}

const HOST_LOCAL_INFERENCE_LIFECYCLE_AUTHORITY_FIELDS = new Set<keyof SandboxEntry>([
  "credentialEnv",
  "endpointSource",
  "endpointUrl",
  "gatewayName",
  "gatewayPort",
  "hostLocalInferenceReceipt",
  "model",
  "openshellDriver",
  "preferredInferenceApi",
  "provider",
]);

function changesHostLocalInferenceLifecycleAuthority(
  current: SandboxEntry,
  updates: Partial<SandboxEntry>,
): boolean {
  if (
    Object.prototype.hasOwnProperty.call(updates, "hostLocalInferenceProvenance") &&
    !isDeepStrictEqual(updates.hostLocalInferenceProvenance, current.hostLocalInferenceProvenance)
  ) {
    return true;
  }
  if (!current.hostLocalInferenceProvenance) return false;
  return Object.entries(updates).some(
    ([field, value]) =>
      HOST_LOCAL_INFERENCE_LIFECYCLE_AUTHORITY_FIELDS.has(field as keyof SandboxEntry) &&
      !isDeepStrictEqual(value, current[field as keyof SandboxEntry]),
  );
}

export function updateSandbox(name: string, updates: Partial<SandboxEntry>): boolean {
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[name];
    if (!current) return false;
    if (Object.prototype.hasOwnProperty.call(updates, "pendingCreateIdentity")) {
      throw new Error(
        `Refusing to change sandbox '${name}' verified create checkpoint outside its transaction.`,
      );
    }
    if (current.pendingCreateIdentity) {
      throw new Error(
        `Refusing to update sandbox '${name}' while its verified create checkpoint is incomplete.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, "name") && updates.name !== name) {
      return false;
    }
    if (changesHostLocalInferenceLifecycleAuthority(current, updates)) return false;
    data.sandboxes[name] = normalizeSandboxPolicyAttribution({ ...current, ...updates });
    save(data);
    return true;
  });
}

/** Publish a missing gateway port only while the complete qualified row remains current. */
export function compareAndSetSandboxGatewayPort(
  name: string,
  expected: SandboxEntry,
  gatewayPort: number,
): boolean {
  const expectedSnapshot = structuredClone(expected);
  if (
    expectedSnapshot.name !== name ||
    expectedSnapshot.gatewayPort !== undefined ||
    !Number.isSafeInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65_535
  ) {
    return false;
  }
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[name];
    if (
      !current ||
      current.gatewayPort !== undefined ||
      !isDeepStrictEqual(current, expectedSnapshot)
    ) {
      return false;
    }
    data.sandboxes[name] = { ...current, gatewayPort };
    save(data);
    return true;
  });
}

/** Remove only an exact pending route that the caller classified as abandoned. */
export function removeSandboxRouteReservationIfCurrent(expected: SandboxEntry): boolean {
  const expectedSnapshot = structuredClone(expected);
  if (
    expectedSnapshot.pendingRouteReservation !== true ||
    expectedSnapshot.pendingCreateIdentity !== undefined
  ) {
    return false;
  }
  return withLock(() => {
    const data = load();
    if (!isDeepStrictEqual(data.sandboxes[expectedSnapshot.name], expectedSnapshot)) return false;
    const result = reversibleRemoval.removeSandboxFromRegistry(data, expectedSnapshot.name);
    if (!result.receipt) return false;
    save(result.registry);
    return true;
  });
}

/** Publish only the owning route transaction and retain its receipt for exact retries. */
export function finalizeSandboxRouteReservation(name: string, sessionId: string): boolean {
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[name];
    if (!current || !sessionId || current.reservationSessionId !== sessionId) return false;
    if (current.pendingRouteReservation !== true) return true;
    if (current.pendingCreateIdentity) return false;
    data.sandboxes[name] = {
      ...current,
      pendingRouteReservation: undefined,
    };
    save(reversibleRemoval.claimInitialDefaultInRegistry(data, name));
    return true;
  });
}

/** Atomically publish a pending registration and preserve its initial-default claim. */
export function finalizePendingSandboxRegistration(name: string): boolean {
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[name];
    if (
      !current ||
      current.pendingRouteReservation !== true ||
      current.reservationSessionId !== undefined ||
      current.pendingCreateIdentity !== undefined
    ) {
      return false;
    }
    data.sandboxes[name] = { ...current, pendingRouteReservation: undefined };
    save(reversibleRemoval.claimInitialDefaultInRegistry(data, name));
    return true;
  });
}

/** Atomically capture and remove one registry row for a reversible lifecycle operation. */
export function removeSandboxWithReceipt(name: string): SandboxRemovalReceipt | null {
  return withLock(() => {
    const result = reversibleRemoval.removeSandboxFromRegistry(load(), name);
    if (!result.receipt) return null;
    save(result.registry);
    return result.receipt;
  });
}

export function removeSandbox(name: string): boolean {
  return removeSandboxWithReceipt(name) !== null;
}

/** Restore a captured row and reclaim its default only while its revision still matches. */
export function restoreSandboxEntry(
  entry: SandboxEntry,
  options: {
    defaultTransition?: {
      readonly from: string | null;
      readonly to: string;
      readonly expectedRevision: number;
    };
  } = {},
): void {
  withLock(() => {
    const data = load();
    const normalizedEntry = normalizeSandboxPolicyAttribution(entry);
    const current = data.sandboxes[normalizedEntry.name];
    if (current?.pendingCreateIdentity && !isDeepStrictEqual(current, normalizedEntry)) {
      throw new Error(
        `Refusing to restore sandbox '${normalizedEntry.name}' while its verified create checkpoint is incomplete.`,
      );
    }
    save(
      reversibleRemoval.restoreSandboxEntryInRegistry(
        data,
        normalizedEntry,
        options.defaultTransition,
      ),
    );
  });
}

/** Restore a removed entry unless a recreate already registered its replacement. */
export function restoreSandboxEntryIfMissing(receipt: SandboxRemovalReceipt): boolean {
  return withLock(() => {
    const data = load();
    const result = reversibleRemoval.restoreSandboxIfMissingInRegistry(data, {
      ...receipt,
      entry: normalizeSandboxPolicyAttribution(receipt.entry),
    });
    if (!result.restored) return false;
    save(result.registry);
    return result.restored;
  });
}

export function listSandboxes(): { sandboxes: SandboxEntry[]; defaultSandbox: string | null } {
  const data = load();
  return {
    sandboxes: Object.values(data.sandboxes),
    defaultSandbox: data.defaultSandbox,
  };
}

export function setDefault(name: string): boolean {
  return withLock(() => {
    const current = load();
    if (current.sandboxes[name]?.pendingRouteReservation === true) return false;
    const registry = reversibleRemoval.setDefaultInRegistry(current, name);
    if (!registry) return false;
    save(registry);
    return true;
  });
}

export function clearAll(): void {
  withLock(() => save(reversibleRemoval.clearRegistry(load())));
}

export function getDisabledChannels(name: string): string[] {
  return getRegistryDisabledChannels(name, { load });
}

export function getConfiguredMessagingChannels(name: string): string[] {
  return getRegistryConfiguredMessagingChannels(name, { load });
}

export function setChannelDisabled(name: string, channel: string, disabled: boolean): boolean {
  return setRegistryChannelDisabled(name, channel, disabled, { load, save, withLock });
}
