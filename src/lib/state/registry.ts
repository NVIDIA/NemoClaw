// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { PolicyAuthorityRefusalError } from "../adapters/openshell/policy-authority";
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
  cloneSandboxPolicyCreationReceipt,
  normalizeBaselineExclusions,
  normalizeBaselineExclusionTransition,
  normalizeCustomPolicyEntries,
  normalizePendingSandboxPolicyVerification,
  normalizeSandboxPolicyAttribution,
  normalizeSandboxPolicyAuthority,
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
import type {
  BaselineExclusionEntry,
  BaselineExclusionTransition,
  CustomPolicyEntry,
  PendingSandboxPolicyVerification,
  SandboxEntry,
} from "./registry/types";
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
  BaselineExclusionEntry,
  BaselineExclusionTransition,
  BaselineExclusionTransitionOperation,
  CustomPolicyEntry,
  SandboxEntry,
  SandboxGpuProofResult,
  SandboxGpuProofStatus,
  SandboxHostMount,
  PendingSandboxPolicyVerification,
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
export {
  cloneSandboxPolicyCreationReceipt,
  hasUnsafeHostMountTerminalText,
  normalizeCustomPolicyEntries,
  normalizeSandboxPolicyAttribution,
};

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
  checkpoint: PendingSandboxPolicyVerification,
): SandboxEntry {
  return normalizeSandboxPolicyAttribution({
    ...reservation.entry,
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    policyAuthority: undefined,
    policyCreationReceipt: undefined,
    pendingPolicyVerification: checkpoint,
  });
}

function assertPendingPolicyVerificationMatchesRegistration(
  recordedEntry: SandboxEntry | undefined,
  requestedEntry: SandboxEntry,
  authority:
    | {
        readonly reservation: QualifiedPendingSandboxCreateReservation;
        readonly checkpoint: PendingSandboxPolicyVerification;
      }
    | undefined,
): void {
  const checkpoint = normalizePendingSandboxPolicyVerification(
    recordedEntry?.pendingPolicyVerification,
  );
  const expectedCheckpoint = normalizePendingSandboxPolicyVerification(authority?.checkpoint);
  if (!authority) {
    if (checkpoint) {
      throw new PolicyAuthorityRefusalError(
        "Cannot publish a verified create checkpoint without exact transaction authority",
      );
    }
    return;
  }
  if (!checkpoint || !expectedCheckpoint || !isDeepStrictEqual(checkpoint, expectedCheckpoint)) {
    throw new PolicyAuthorityRefusalError(
      "Cannot publish a sandbox registration after its verified create checkpoint changed",
    );
  }
  const reservation = authority.reservation;
  if (
    !isCurrentPendingSandboxCreateReservation(reservation, reservation.entry) ||
    !recordedEntry ||
    !isDeepStrictEqual(recordedEntry, pendingVerifiedCreateEntry(reservation, expectedCheckpoint))
  ) {
    throw new PolicyAuthorityRefusalError(
      "Cannot publish a sandbox registration after its verified create transaction changed",
    );
  }
  const commonChecks = [
    ["pending route reservation", recordedEntry?.pendingRouteReservation === true],
    [
      "reservation session",
      recordedEntry?.reservationSessionId === reservation.authority.sessionId,
    ],
    ["recorded policy authority", recordedEntry?.policyAuthority === undefined],
    ["recorded policy receipt", recordedEntry?.policyCreationReceipt === undefined],
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
    ["policy authority", checkpoint.policyAuthority === requestedEntry.policyAuthority],
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
  const authorityMatches =
    checkpoint.policyAuthority === "nemoclaw-managed"
      ? isDeepStrictEqual(checkpoint.policyCreationReceipt, requestedEntry.policyCreationReceipt)
      : requestedEntry.policyCreationReceipt === undefined;
  const mismatches: string[] = commonChecks.filter(([, matches]) => !matches).map(([name]) => name);
  if (!authorityMatches) mismatches.push("policy receipt");
  if (mismatches.length > 0) {
    throw new PolicyAuthorityRefusalError(
      `Cannot publish a sandbox registration that differs from its verified create checkpoint (${mismatches.join(", ")})`,
    );
  }
}

/** Persist the exact verified create boundary before any unrelated post-create effect. */
export function recordPendingSandboxPolicyVerification(
  reservation: QualifiedPendingSandboxCreateReservation,
  value: PendingSandboxPolicyVerification,
  options: { readonly expected?: PendingSandboxPolicyVerification } = {},
): SandboxEntry {
  const checkpoint = normalizePendingSandboxPolicyVerification(value);
  const expected = normalizePendingSandboxPolicyVerification(options.expected);
  const { authority } = reservation;
  const name = authority.sandboxName;
  if (
    !checkpoint ||
    !authority.sessionId ||
    checkpoint.sandboxName !== name ||
    checkpoint.gatewayName !== authority.gatewayName ||
    !isCurrentPendingSandboxCreateReservation(reservation, reservation.entry)
  ) {
    throw new PolicyAuthorityRefusalError(
      "Cannot record an incomplete verified sandbox create checkpoint",
    );
  }
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[name];
    const recordedCheckpoint = normalizePendingSandboxPolicyVerification(
      current?.pendingPolicyVerification,
    );
    if (!current) {
      throw new PolicyAuthorityRefusalError(
        `Cannot record sandbox '${name}' policy verification after its route reservation changed`,
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
        throw new PolicyAuthorityRefusalError(
          `Cannot record sandbox '${name}' policy verification after its route reservation changed`,
        );
      }
    } else {
      const expectedEntry = pendingVerifiedCreateEntry(reservation, expected);
      if (
        !recordedCheckpoint ||
        !isDeepStrictEqual(current, expectedEntry) ||
        checkpoint.lifecycleGeneration !== expected.lifecycleGeneration ||
        checkpoint.policyAuthority !== expected.policyAuthority ||
        checkpoint.gatewayName !== expected.gatewayName ||
        checkpoint.gatewayPort !== expected.gatewayPort ||
        checkpoint.sandboxName !== expected.sandboxName
      ) {
        throw new PolicyAuthorityRefusalError(
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
export function requireCurrentPendingSandboxPolicyVerification(
  reservation: QualifiedPendingSandboxCreateReservation,
  expected: PendingSandboxPolicyVerification,
): SandboxEntry {
  const checkpoint = normalizePendingSandboxPolicyVerification(expected);
  const { authority } = reservation;
  const name = authority.sandboxName;
  const current = load().sandboxes[name];
  if (
    !checkpoint ||
    !isCurrentPendingSandboxCreateReservation(reservation, reservation.entry) ||
    !current ||
    !isDeepStrictEqual(current, pendingVerifiedCreateEntry(reservation, checkpoint))
  ) {
    throw new PolicyAuthorityRefusalError(
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
      readonly checkpoint: PendingSandboxPolicyVerification;
    };
  } = {},
): SandboxEntry {
  return withLock(() => {
    const data = load();
    const recordedEntry = data.sandboxes[entry.name];
    if (entry.pendingPolicyVerification !== undefined) {
      throw new PolicyAuthorityRefusalError(
        "Cannot publish a caller-supplied pending policy verification",
      );
    }
    if (routeReservation && options.pending !== true && !options.verifiedCreate) {
      throw new PolicyAuthorityRefusalError(
        "Cannot consume a create route reservation without its verified policy checkpoint",
      );
    }
    if (
      routeReservation &&
      options.verifiedCreate &&
      !isDeepStrictEqual(routeReservation, options.verifiedCreate.reservation)
    ) {
      throw new PolicyAuthorityRefusalError(
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
      throw new PolicyAuthorityRefusalError(
        "Cannot publish a pending sandbox create without its verified policy checkpoint",
      );
    }
    const servingProfileProvenance = parseServingProfileProvenance(entry.servingProfileProvenance);
    if (entry.servingProfileProvenance !== undefined && !servingProfileProvenance) {
      throw new Error("Cannot register a sandbox with invalid serving profile provenance");
    }
    if (
      options.pending === true &&
      (entry.policyAuthority === "nemoclaw-managed" || entry.policyCreationReceipt !== undefined)
    ) {
      throw new PolicyAuthorityRefusalError(
        "Cannot attach NemoClaw policy ownership to a pending sandbox registration",
      );
    }
    if (entry.policyAuthority === "nemoclaw-managed" && entry.policyCreationReceipt === undefined) {
      throw new PolicyAuthorityRefusalError(
        "Cannot register NemoClaw policy ownership without a complete policy creation receipt",
      );
    }
    if (entry.policyCreationReceipt !== undefined && entry.policyAuthority !== "nemoclaw-managed") {
      throw new PolicyAuthorityRefusalError(
        "Cannot register a policy creation receipt without NemoClaw policy ownership",
      );
    }
    const normalizedPolicyEntry = normalizeSandboxPolicyAttribution(entry);
    const requestedPolicyAuthority = normalizeSandboxPolicyAuthority(
      normalizedPolicyEntry.policyAuthority,
    );
    const requestedPolicyCreationReceipt = normalizedPolicyEntry.policyCreationReceipt;
    if (requestedPolicyAuthority === "nemoclaw-managed") {
      assertPolicyCreationReceiptMatchesSandboxEntry(
        normalizedPolicyEntry,
        requestedPolicyCreationReceipt,
      );
    }
    assertPendingPolicyVerificationMatchesRegistration(
      recordedEntry,
      normalizedPolicyEntry,
      options.verifiedCreate,
    );
    const recordedPolicyAuthority = normalizeSandboxPolicyAuthority(recordedEntry?.policyAuthority);
    const recordedPolicyCreationReceipt = recordedEntry?.policyCreationReceipt;
    const reservedGenerationChanged =
      recordedEntry?.pendingRouteReservation === true &&
      recordedEntry.lifecycleGeneration !== normalizedPolicyEntry.lifecycleGeneration;
    const reservedFingerprintChanged =
      recordedEntry?.pendingRouteReservation === true &&
      recordedEntry.lifecycleLiveIdentityFingerprint !==
        normalizedPolicyEntry.lifecycleLiveIdentityFingerprint;
    if (reservedGenerationChanged !== reservedFingerprintChanged) {
      throw new PolicyAuthorityRefusalError(
        "Cannot register a sandbox after only part of its reserved lifecycle identity changed",
      );
    }
    const replacesReservedSandboxLifecycle =
      recordedEntry?.pendingRouteReservation === true &&
      requestedPolicyCreationReceipt !== undefined &&
      reservedGenerationChanged &&
      reservedFingerprintChanged;
    if (
      recordedPolicyAuthority !== undefined &&
      requestedPolicyAuthority !== undefined &&
      recordedPolicyAuthority !== requestedPolicyAuthority
    ) {
      throw new PolicyAuthorityRefusalError(
        "Cannot register a sandbox after its policy authority changed",
      );
    }
    if (
      recordedPolicyAuthority === "nemoclaw-managed" &&
      !isDeepStrictEqual(recordedPolicyCreationReceipt, requestedPolicyCreationReceipt) &&
      !replacesReservedSandboxLifecycle
    ) {
      throw new PolicyAuthorityRefusalError(
        "Cannot register a sandbox after its policy creation receipt changed",
      );
    }
    const policyAuthority = requestedPolicyAuthority ?? recordedPolicyAuthority;
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
      ...(policyAuthority !== undefined ? { policyAuthority } : {}),
      ...(policyAuthority === "nemoclaw-managed" && requestedPolicyCreationReceipt
        ? { policyCreationReceipt: requestedPolicyCreationReceipt }
        : {}),
      ...(policyAuthority === "externally-managed"
        ? { policies: [] }
        : {
            policies: entry.policies || [],
            baselineExclusions: normalizeBaselineExclusions(entry.baselineExclusions),
            baselineExclusionTransition: normalizeBaselineExclusionTransition(
              entry.baselineExclusionTransition,
            ),
            policyTier: entry.policyTier || null,
          }),
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
      // policyPresetsFinalized is intentionally not set here: registration means
      // the policy step has not completed for this entry. It is stamped only by
      // the post-policy registry write (see policy-preset-persistence), so a
      // snapshot clone (which spreads the source entry but resets `policies`)
      // cannot inherit a stale finalized marker. See #4621.
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
        if (existing.pendingPolicyVerification) {
          throw new PolicyAuthorityRefusalError(
            `Cannot replace sandbox '${name}' while its verified create checkpoint is incomplete`,
          );
        }
        const detail =
          existing.reservationSessionId !== route.reservationSessionId
            ? "belongs to another onboarding session"
            : "cannot change before the owning create transaction completes";
        throw new PolicyAuthorityRefusalError(
          `Cannot replace sandbox '${name}': its inference route reservation ${detail}`,
        );
      }
      return true;
    }
    const existingForReservation: SandboxEntry = existing
      ? { ...existing }
      : { name, pendingRouteReservation: true };
    if (
      existingForReservation.policyCreationReceipt !== undefined &&
      (route.gatewayName !== existingForReservation.gatewayName ||
        (route.gatewayPort !== undefined &&
          route.gatewayPort !== existingForReservation.gatewayPort))
    ) {
      throw new PolicyAuthorityRefusalError(
        "Cannot move a receipt-bound sandbox reservation to another gateway",
      );
    }
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
        existingForReservation.policyCreationReceipt === undefined
          ? (route.gatewayPort ??
            (existing?.gatewayName === route.gatewayName ? existing.gatewayPort : undefined))
          : existingForReservation.gatewayPort,
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

function assertRecordedPolicyAuthorityUnchanged(
  current: SandboxEntry,
  updates: Partial<SandboxEntry>,
): void {
  if (!Object.prototype.hasOwnProperty.call(updates, "policyAuthority")) return;
  const requested = normalizeSandboxPolicyAuthority(updates.policyAuthority);
  if (current.policyAuthority === undefined || requested === current.policyAuthority) return;
  throw new PolicyAuthorityRefusalError(
    `Refusing to update sandbox '${current.name}' because its policy authority changed ` +
      `from ${current.policyAuthority} to ${requested ?? "unrecorded"}.`,
  );
}

function assertPolicyCreationReceiptMatchesSandboxEntry(
  entry: SandboxEntry,
  receipt: SandboxEntry["policyCreationReceipt"],
): asserts receipt is NonNullable<SandboxEntry["policyCreationReceipt"]> {
  if (
    !receipt ||
    receipt.sandboxName !== entry.name ||
    receipt.gatewayName !== entry.gatewayName ||
    receipt.gatewayPort !== entry.gatewayPort ||
    receipt.lifecycleGeneration !== entry.lifecycleGeneration ||
    receipt.sandboxIdentityFingerprint !== entry.lifecycleLiveIdentityFingerprint
  ) {
    throw new PolicyAuthorityRefusalError(
      `Cannot record NemoClaw policy ownership for sandbox '${entry.name}' without an exact gateway and sandbox identity receipt`,
    );
  }
}

function assertPolicyCreationReceiptUnchanged(
  current: SandboxEntry,
  updates: Partial<SandboxEntry>,
): void {
  if (!Object.prototype.hasOwnProperty.call(updates, "policyCreationReceipt")) return;
  const requested = cloneSandboxPolicyCreationReceipt(updates.policyCreationReceipt);
  if (isDeepStrictEqual(requested, current.policyCreationReceipt)) return;
  throw new PolicyAuthorityRefusalError(
    `Refusing to update sandbox '${current.name}' because its policy creation receipt changed outside the receipt rotation transaction.`,
  );
}

export function updateSandbox(name: string, updates: Partial<SandboxEntry>): boolean {
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[name];
    if (!current) return false;
    if (Object.prototype.hasOwnProperty.call(updates, "pendingPolicyVerification")) {
      throw new PolicyAuthorityRefusalError(
        `Refusing to change sandbox '${name}' verified create checkpoint outside its transaction.`,
      );
    }
    if (current.pendingPolicyVerification) {
      throw new PolicyAuthorityRefusalError(
        `Refusing to update sandbox '${name}' while its verified create checkpoint is incomplete.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(updates, "name") && updates.name !== name) {
      return false;
    }
    if (changesHostLocalInferenceLifecycleAuthority(current, updates)) return false;
    if (
      updates.policyAuthority === "nemoclaw-managed" &&
      current.policyAuthority !== "nemoclaw-managed"
    ) {
      throw new PolicyAuthorityRefusalError(
        `Refusing to assign NemoClaw policy ownership to sandbox '${current.name}' outside completed sandbox registration.`,
      );
    }
    assertRecordedPolicyAuthorityUnchanged(current, updates);
    assertPolicyCreationReceiptUnchanged(current, updates);
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
    expectedSnapshot.pendingPolicyVerification !== undefined
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
    if (current.pendingPolicyVerification) return false;
    data.sandboxes[name] = {
      ...current,
      pendingRouteReservation: undefined,
    };
    save(reversibleRemoval.claimInitialDefaultInRegistry(data, name));
    return true;
  });
}

/** Replace only the policy identity in an exact, completed NemoClaw ownership receipt. */
export function compareAndSetSandboxPolicyCreationReceipt(
  name: string,
  expected: NonNullable<SandboxEntry["policyCreationReceipt"]>,
  replacement: NonNullable<SandboxEntry["policyCreationReceipt"]>,
): boolean {
  const expectedReceipt = cloneSandboxPolicyCreationReceipt(expected);
  const replacementReceipt = cloneSandboxPolicyCreationReceipt(replacement);
  if (!expectedReceipt || !replacementReceipt) {
    throw new PolicyAuthorityRefusalError(
      "Cannot rotate an incomplete NemoClaw policy creation receipt",
    );
  }
  if (
    expectedReceipt.gatewayName !== replacementReceipt.gatewayName ||
    expectedReceipt.gatewayPort !== replacementReceipt.gatewayPort ||
    expectedReceipt.sandboxName !== replacementReceipt.sandboxName ||
    expectedReceipt.lifecycleGeneration !== replacementReceipt.lifecycleGeneration ||
    expectedReceipt.sandboxIdentityFingerprint !== replacementReceipt.sandboxIdentityFingerprint
  ) {
    throw new PolicyAuthorityRefusalError(
      "Cannot rotate a policy creation receipt across a gateway or sandbox identity",
    );
  }

  return withLock(() => {
    const data = load();
    const current = data.sandboxes[name];
    if (
      !current ||
      current.pendingRouteReservation === true ||
      current.policyAuthority !== "nemoclaw-managed" ||
      !isDeepStrictEqual(current.policyCreationReceipt, expectedReceipt)
    ) {
      return false;
    }
    assertPolicyCreationReceiptMatchesSandboxEntry(current, replacementReceipt);
    data.sandboxes[name] = {
      ...current,
      policyCreationReceipt: replacementReceipt,
    };
    save(data);
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
      current.pendingPolicyVerification !== undefined
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
    if (current?.pendingPolicyVerification && !isDeepStrictEqual(current, normalizedEntry)) {
      throw new PolicyAuthorityRefusalError(
        `Refusing to restore sandbox '${normalizedEntry.name}' while its verified create checkpoint is incomplete.`,
      );
    }
    if (
      current &&
      (normalizeSandboxPolicyAuthority(current.policyAuthority) !==
        normalizeSandboxPolicyAuthority(normalizedEntry.policyAuthority) ||
        !isDeepStrictEqual(current.policyCreationReceipt, normalizedEntry.policyCreationReceipt))
    ) {
      throw new PolicyAuthorityRefusalError(
        `Refusing to restore sandbox '${normalizedEntry.name}' because its policy authority changed during recovery.`,
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

/** Return the list of custom policy entries recorded for a sandbox (never null). */
export function getCustomPolicies(name: string): CustomPolicyEntry[] {
  const data = load();
  return data.sandboxes[name]?.customPolicies ?? [];
}

/** Upsert a custom policy by name. Replaces any existing entry with the same name. */
export function addCustomPolicy(name: string, entry: CustomPolicyEntry): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox) return false;
    const list = (sandbox.customPolicies ?? []).filter((p) => p.name !== entry.name);
    list.push({ ...entry, appliedAt: entry.appliedAt ?? new Date().toISOString() });
    sandbox.customPolicies = list;
    save(data);
    return true;
  });
}

/** Remove a custom policy by name. Returns true if an entry was removed. */
export function removeCustomPolicyByName(name: string, presetName: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox) return false;
    const list = sandbox.customPolicies ?? [];
    const next = list.filter((p) => p.name !== presetName);
    if (next.length === list.length) return false;
    sandbox.customPolicies = next.length > 0 ? next : undefined;
    save(data);
    return true;
  });
}

/** Return the baseline exclusions recorded for a sandbox (never null). */
export function getBaselineExclusions(name: string): BaselineExclusionEntry[] {
  const data = load();
  return data.sandboxes[name]?.baselineExclusions ?? [];
}

/** Upsert a baseline exclusion by key. Replaces any existing entry for the key. */
export function addBaselineExclusion(name: string, entry: BaselineExclusionEntry): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox || sandbox.baselineExclusionTransition) return false;
    const list = (sandbox.baselineExclusions ?? []).filter((e) => e.key !== entry.key);
    list.push({ ...entry, acknowledgedAt: entry.acknowledgedAt ?? new Date().toISOString() });
    sandbox.baselineExclusions = list;
    save(data);
    return true;
  });
}

/** Remove a baseline exclusion by key. Returns true if an entry was removed. */
export function removeBaselineExclusion(name: string, key: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox || sandbox.baselineExclusionTransition) return false;
    const list = sandbox.baselineExclusions ?? [];
    const next = list.filter((e) => e.key !== key);
    if (next.length === list.length) return false;
    sandbox.baselineExclusions = next.length > 0 ? next : undefined;
    save(data);
    return true;
  });
}

/** Return the one in-flight baseline policy transaction for a sandbox. */
export function getBaselineExclusionTransition(name: string): BaselineExclusionTransition | null {
  const data = load();
  return data.sandboxes[name]?.baselineExclusionTransition ?? null;
}

/**
 * Persist a new cross-system transaction before changing the live policy.
 * Refuses to overwrite another pending transaction, even for the same key.
 */
export function beginBaselineExclusionTransition(
  name: string,
  transition: BaselineExclusionTransition,
): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox || sandbox.baselineExclusionTransition) return false;
    sandbox.baselineExclusionTransition = normalizeBaselineExclusionTransition(transition);
    save(data);
    return true;
  });
}

/**
 * Publish the durable intent represented by a completed live mutation and
 * clear its journal in the same registry-file replacement.
 */
export function commitBaselineExclusionTransition(name: string, id: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    const transition = sandbox?.baselineExclusionTransition;
    if (!sandbox || !transition || transition.id !== id) return false;
    if (transition.operation === "exclude") {
      const list = (sandbox.baselineExclusions ?? []).filter(
        (entry) => entry.key !== transition.exclusion.key,
      );
      list.push({
        ...transition.exclusion,
        acknowledgedAt: transition.exclusion.acknowledgedAt ?? new Date().toISOString(),
      });
      sandbox.baselineExclusions = list;
    } else {
      const list = sandbox.baselineExclusions ?? [];
      const committed = list.find((entry) => entry.key === transition.exclusion.key);
      // A restore may finalize only the exact durable exclusion it staged
      // against. Preserve the journal if another writer changed the record.
      if (!committed || !isDeepStrictEqual(committed, transition.exclusion)) return false;
      const next = list.filter((entry) => entry.key !== transition.exclusion.key);
      sandbox.baselineExclusions = next.length > 0 ? next : undefined;
    }
    sandbox.baselineExclusionTransition = undefined;
    save(data);
    return true;
  });
}

/** Roll back only the exact pending transaction, preserving committed intent. */
export function clearBaselineExclusionTransition(name: string, id: string): boolean {
  return withLock(() => {
    const data = load();
    const sandbox = data.sandboxes[name];
    if (!sandbox || sandbox.baselineExclusionTransition?.id !== id) return false;
    sandbox.baselineExclusionTransition = undefined;
    save(data);
    return true;
  });
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
