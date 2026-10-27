// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { captureNativeDockerRecoveryAuthority } from "../../../onboard/gateway/state-ownership";

import { dockerRun } from "../../../adapters/docker/run";
import { dockerContextIsDefaultFromBuild } from "../../../adapters/docker/client-isolation";
import { normalizeInferenceSelection } from "../../../inference/selection";
import {
  assertSandboxRecreateSourceProof,
  sandboxRecreateSourceProof,
} from "../../../onboard/sandbox-recreate-transaction";
import { MANAGED_IMAGE_AGENTS } from "../../../onboard/managed-image/agents";
import { managedStartupStateRootOwnership } from "../../../onboard/managed-startup/state-roots";
import type { registryEntryGatewayPort } from "../../../state/gateway-registry";
import type * as OnboardSession from "../../../state/onboard-session";
import { resolveNemoclawStateGatewayPort } from "../../../state/paths";
import type * as Registry from "../../../state/registry";
import { listNativeLocalProviderAuthorities } from "../../../state/registry/native-local-provider-authority";
import {
  classifySandboxInferenceRouteReservation,
  isRouteOnlySandboxReservation,
} from "../../../state/registry/route-reservation";
import { resolveGatewayCleanupRuntimeProviderId } from "../destroy-gateway";
import {
  classifyDestroyContainerIdentity,
  observeDestroyContainerIdentity,
  type DestroySandboxPresence,
} from "../destroy-presence";

type Recovery = OnboardSession.RetainedSandboxRecoveryRecord;
type RefuseRecovery = (name: string, reason: string) => never;
type RecoveryState = {
  observeSandbox(gatewayName: string): DestroySandboxPresence;
  registryEntryGatewayPort: typeof registryEntryGatewayPort;
  retireRemovedImmutabilityState?: () => void;
  timeoutMs: number;
  forceLocal?: boolean;
  session: Pick<
    typeof OnboardSession,
    | "withOwnedOnboardLock"
    | "loadSession"
    | "loadRebuildSession"
    | "selectRebuildSession"
    | "updateSession"
    | "listRetainedSandboxRecoveryRecords"
    | "retainedSandboxRecoveryMatchesSession"
    | "resolveRetainedSandboxRecovery"
    | "archiveRetainedSandboxRecoveryForLocalDiscard"
  >;
  registry: Pick<typeof Registry, "getSandbox" | "removeSandboxRouteReservationIfCurrent">;
};

function requireOwnedRuntime(
  record: Recovery,
  entry: Registry.SandboxEntry | null,
  state: RecoveryState,
  refuseRecovery: RefuseRecovery = refuse,
): void {
  if (
    resolveGatewayCleanupRuntimeProviderId(record.gatewayName, entry?.openshellDriver, {
      requireOwnedRuntime: true,
      ...(state.forceLocal || record.createAuthority
        ? { requireDefaultDockerDaemon: true }
        : { recoveryRecordedAt: record.recordedAt }),
    }) !== "docker"
  ) {
    refuseRecovery(
      record.sandboxName,
      "the owning Docker runtime on the original default daemon could not be established",
    );
  }
  if (
    !state.forceLocal &&
    record.createAuthority &&
    !isDeepStrictEqual(
      record.createAuthority,
      captureNativeDockerRecoveryAuthority(
        record.gatewayName,
        record.gatewayPort,
        record.createAuthority.reservationSessionId,
      ),
    )
  ) {
    refuseRecovery(
      record.sandboxName,
      "the Docker daemon or gateway binding changed since the create attempt",
    );
  }
}

function requireDefaultDockerObservation(
  record: Recovery,
  refuseRecovery: RefuseRecovery = refuse,
): void {
  if (
    process.env.DOCKER_HOST?.trim() !== "unix:///var/run/docker.sock" &&
    !dockerContextIsDefaultFromBuild(process.env)
  ) {
    refuseRecovery(
      record.sandboxName,
      "the Docker observation target is not the native gateway's default daemon",
    );
  }
}

function unpublished(entry: Registry.SandboxEntry | null): boolean {
  return (
    entry === null ||
    (isRouteOnlySandboxReservation(entry) &&
      entry.pendingCreateIdentity === undefined &&
      entry.lifecycleGeneration === undefined &&
      entry.lifecycleLiveIdentityFingerprint === undefined)
  );
}

function refuse(name: string, reason: string): never {
  throw new Error(
    `Cannot reconcile retained sandbox '${name}': ${reason}. No sandbox resources were removed. ` +
      "Recovery remains unresolved; correct the reported condition, then rerun destroy.",
  );
}

function refuseRebuild(name: string, reason: string): never {
  throw new Error(
    `Cannot resume rebuild for retained sandbox '${name}': ${reason}. No sandbox resources were removed. ` +
      "Recovery remains unresolved; correct the reported condition, then rerun rebuild.",
  );
}

function requireGatewayAbsence(
  record: Recovery,
  state: RecoveryState,
  refuseRecovery: RefuseRecovery = refuse,
): void {
  const { sandboxName, gatewayName } = record;
  const presence = state.observeSandbox(gatewayName);
  if (presence !== "absent") {
    refuseRecovery(
      sandboxName,
      `the owning OpenShell gateway reports sandbox presence as ${presence}`,
    );
  }
}

function requireAbsence(
  record: Recovery,
  state: RecoveryState,
  refuseRecovery: RefuseRecovery = refuse,
): void {
  const { sandboxName } = record;
  requireGatewayAbsence(record, state, refuseRecovery);
  const containers = classifyDestroyContainerIdentity(
    sandboxName,
    observeDestroyContainerIdentity(sandboxName, (args, options) =>
      dockerRun(["--context", "default", ...args], options),
    ),
  );
  if (containers.status !== "clear" || containers.identity !== null) {
    refuseRecovery(sandboxName, "the container runtime did not confirm sandbox absence");
  }
  const volumes = dockerRun(["--context", "default", "volume", "ls", "--format", "{{.Name}}"], {
    ignoreError: true,
    suppressOutput: true,
    timeout: state.timeoutMs,
  });
  if (volumes.status !== 0 || String(volumes.stderr ?? "").trim()) {
    refuseRecovery(sandboxName, "the container runtime could not inspect retained volumes");
  }
  const names = String(volumes.stdout ?? "")
    .split(/\r?\n/u)
    .filter(Boolean);
  const reservedNames = MANAGED_IMAGE_AGENTS.flatMap((agent) =>
    managedStartupStateRootOwnership({ agent, sandboxName }).map((root) => root.resourceIdentity),
  );
  if (
    names.some(
      (name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name) || reservedNames.includes(name),
    )
  ) {
    refuseRecovery(sandboxName, "retained volume absence is not established");
  }
  requireGatewayAbsence(record, state, refuseRecovery);
}

function requireReservationOwner(
  record: Recovery,
  entry: Registry.SandboxEntry | null,
  session: OnboardSession.Session | null,
  state: RecoveryState,
): void {
  if (
    entry?.nativeLocalProviderAttachment !== undefined ||
    listNativeLocalProviderAuthorities(record.sandboxName, record.gatewayName).length > 0
  ) {
    refuse(record.sandboxName, "native local provider cleanup authority remains");
  }
  if (!entry) {
    if (
      (state.forceLocal || record.createAuthority) &&
      session?.sandboxName === record.sandboxName &&
      (session.status !== "recovery_required" ||
        !state.session.retainedSandboxRecoveryMatchesSession(record, session))
    ) {
      refuse(record.sandboxName, "another onboarding session still claims this name");
    }
    return;
  }
  const { name, gatewayName, gatewayPort } = entry;
  const sessionMustMatch =
    (!state.forceLocal && !record.createAuthority) || session?.sandboxName === record.sandboxName;
  if (
    (sessionMustMatch &&
      (session?.status !== "recovery_required" ||
        session.sandboxName !== record.sandboxName ||
        session.cancellationRecovery?.reason !== record.reason ||
        !state.session.retainedSandboxRecoveryMatchesSession(record, session))) ||
    state.registryEntryGatewayPort({ name, gatewayName, gatewayPort }) !== record.gatewayPort ||
    entry.hostLocalInferenceReceipt != null ||
    entry.nativeNvidiaProviderAttachment !== undefined ||
    classifySandboxInferenceRouteReservation(
      {
        sandboxName: record.sandboxName,
        gatewayName: record.gatewayName,
        // Force is an explicit local-record discard, not proof of the original session owner.
        sessionId:
          (!state.forceLocal && record.createAuthority
            ? record.createAuthority.reservationSessionId
            : sessionMustMatch
              ? session?.sessionId
              : entry.reservationSessionId) ?? "",
        selection: normalizeInferenceSelection(entry),
      },
      entry,
    ).kind !== "owned"
  ) {
    refuse(
      record.sandboxName,
      "the unpublished reservation has conflicting ownership or retained resources",
    );
  }
}

/** Retire only local recovery metadata; a missing identity never authorizes resource deletion. */
export function reconcileIdentityFreeRecovery(
  sandboxName: string,
  observedRecords: readonly Recovery[],
  owningGatewayPort: number,
  state: RecoveryState,
): boolean {
  const { session: sessionState, registry } = state;
  if (process.platform !== "linux") return false;
  const candidates = observedRecords.filter((record) => record.sandboxName === sandboxName);
  if (!candidates.some((record) => record.sandboxIdentityFingerprint === null)) return false;
  const observedEntry = registry.getSandbox(sandboxName);
  if (!unpublished(observedEntry)) return false;

  return sessionState.withOwnedOnboardLock("nemoclaw retained recovery reconciliation", () => {
    const record = candidates[0];
    if (!record || candidates.length !== 1 || record.sandboxIdentityFingerprint !== null) {
      refuse(sandboxName, "exactly one identity-free recovery record is required");
    }
    if (
      record.gatewayPort !== owningGatewayPort ||
      record.gatewayPort !== resolveNemoclawStateGatewayPort() ||
      state.registryEntryGatewayPort({ name: sandboxName, gatewayName: record.gatewayName }) !==
        record.gatewayPort ||
      record.resources.sandboxScopedProviders.length > 0
    ) {
      refuse(
        sandboxName,
        "the recovery gateway or sandbox-scoped resources could not be qualified",
      );
    }
    const entry = registry.getSandbox(sandboxName);
    if (!isDeepStrictEqual(entry, observedEntry) || !unpublished(entry)) {
      refuse(sandboxName, "the registry changed before reconciliation");
    }
    requireReservationOwner(record, entry, sessionState.loadSession(), state);
    requireOwnedRuntime(record, entry, state);
    // The runner can normalize the native Linux default context to its explicit Unix endpoint.
    requireDefaultDockerObservation(record);
    requireAbsence(record, state);
    requireOwnedRuntime(record, entry, state);
    // The onboarding lock prevents a new create while CAS protects the observed reservation.
    const currentRecords = sessionState
      .listRetainedSandboxRecoveryRecords()
      .filter((current) => current.sandboxName === sandboxName);
    if (!isDeepStrictEqual(currentRecords, candidates)) {
      refuse(sandboxName, "the recovery record changed during absence verification");
    }
    const currentSession = sessionState.loadSession();
    requireReservationOwner(record, entry, currentSession, state);
    if (state.forceLocal) {
      const archivePath = sessionState.archiveRetainedSandboxRecoveryForLocalDiscard(record, entry);
      console.warn(
        `  --force discards local recovery tracking only; original runtime cleanup is not asserted. Archive: ${archivePath}`,
      );
    }
    // Legacy state retirement must succeed while the recovery authority is still available for retry.
    state.retireRemovedImmutabilityState?.();
    if (entry && !registry.removeSandboxRouteReservationIfCurrent(entry)) {
      refuse(sandboxName, "the registry changed during absence verification");
    }
    if (registry.getSandbox(sandboxName) !== null) {
      refuse(sandboxName, "a registry entry appeared during reconciliation");
    }
    // Keep the independent record until both earlier local writes succeed so a retry can finish.
    if (
      !sessionState.resolveRetainedSandboxRecovery(record, {
        preserveSession: currentSession?.sandboxName !== sandboxName,
      })
    ) {
      refuse(sandboxName, "the recovery record could not be retired");
    }
    return true;
  });
}

/** Resume the journaled rebuild only after its unidentified replacement is proved absent. */
export function reconcileJournaledRebuildRecovery(
  sandboxName: string,
  observedRecords: readonly Recovery[],
  owningGatewayPort: number,
  state: RecoveryState,
): boolean {
  if (process.platform !== "linux") return false;
  const candidates = observedRecords.filter((record) => record.sandboxName === sandboxName);
  if (!candidates.some((record) => record.sandboxIdentityFingerprint === null)) return false;
  const observedEntry = state.registry.getSandbox(sandboxName);
  if (!observedEntry || unpublished(observedEntry)) return false;

  return state.session.withOwnedOnboardLock("nemoclaw journaled rebuild recovery", () => {
    const record = candidates[0];
    if (!record || candidates.length !== 1 || record.sandboxIdentityFingerprint !== null) {
      refuseRebuild(sandboxName, "exactly one identity-free recovery record is required");
    }
    const entry = state.registry.getSandbox(sandboxName);
    const session = state.session.loadRebuildSession(sandboxName);
    const transaction = session?.checkpoint?.sandboxRecreate;
    if (
      !entry ||
      !isDeepStrictEqual(entry, observedEntry) ||
      !session ||
      session.sandboxName !== sandboxName ||
      session.status !== "recovery_required" ||
      !state.session.retainedSandboxRecoveryMatchesSession(record, session) ||
      record.reason !== "retained_after_sandbox_creation_failure" ||
      record.identityWasUnavailable !== true ||
      record.reason !== session.cancellationRecovery?.reason ||
      !transaction ||
      (transaction.phase !== "deleted" && transaction.phase !== "creating") ||
      transaction.targetLiveIdentityFingerprint !== null ||
      transaction.targetGeneration !== record.lifecycleGeneration ||
      record.gatewayName !== transaction.gatewayName ||
      record.gatewayPort !== transaction.gatewayPort ||
      record.gatewayPort !== owningGatewayPort ||
      record.gatewayPort !== resolveNemoclawStateGatewayPort() ||
      state.registryEntryGatewayPort(entry) !== record.gatewayPort ||
      record.resources.sandboxScopedProviders.length > 0
    ) {
      refuseRebuild(
        sandboxName,
        "the recovery record, source registry row, or recreate journal disagrees",
      );
    }
    try {
      assertSandboxRecreateSourceProof(sandboxRecreateSourceProof(transaction, session.sessionId), {
        sandboxName,
        gatewayName: record.gatewayName,
        gatewayPort: record.gatewayPort,
        registryEntry: entry,
        observation: { state: "missing", liveIdentityFingerprint: null },
      });
    } catch (error) {
      refuseRebuild(sandboxName, error instanceof Error ? error.message : String(error));
    }
    requireOwnedRuntime(record, entry, state, refuseRebuild);
    requireDefaultDockerObservation(record, refuseRebuild);
    requireAbsence(record, state, refuseRebuild);
    requireOwnedRuntime(record, entry, state, refuseRebuild);
    state.session.selectRebuildSession(sandboxName);
    if (
      !isDeepStrictEqual(state.registry.getSandbox(sandboxName), entry) ||
      !isDeepStrictEqual(state.session.loadSession(), session) ||
      !isDeepStrictEqual(
        state.session
          .listRetainedSandboxRecoveryRecords()
          .filter((current) => current.sandboxName === sandboxName),
        candidates,
      )
    ) {
      refuseRebuild(
        sandboxName,
        "the registry, journal, or recovery record changed during verification",
      );
    }
    // Preserve the source row and journal so the ordinary rebuild resume can use its backup.
    // If the session write fails, its cancellation receipt reconstructs the retained record.
    if (!state.session.resolveRetainedSandboxRecovery(record, { preserveSession: true })) {
      refuseRebuild(sandboxName, "the recovery record could not be retired");
    }
    state.session.updateSession((current) => {
      if (!isDeepStrictEqual(current, session)) {
        refuseRebuild(sandboxName, "the rebuild session changed before recovery was cleared");
      }
      current.status = "failed";
      current.cancellationRecovery = null;
      return current;
    });
    return true;
  });
}
