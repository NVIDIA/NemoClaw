// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { dockerRun } from "../../../adapters/docker/run";
import { dockerContextIsDefaultFromBuild } from "../../../adapters/docker/client-isolation";
import { normalizeInferenceSelection } from "../../../inference/selection";
import { MANAGED_IMAGE_AGENTS } from "../../../onboard/managed-image/agents";
import { managedStartupStateRootOwnership } from "../../../onboard/managed-startup/state-roots";
import type { registryEntryGatewayPort } from "../../../state/gateway-registry";
import type * as OnboardSession from "../../../state/onboard-session";
import { resolveNemoclawStateGatewayPort } from "../../../state/paths";
import type * as Registry from "../../../state/registry";
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
type RecoveryState = {
  observeSandbox(gatewayName: string): DestroySandboxPresence;
  registryEntryGatewayPort: typeof registryEntryGatewayPort;
  retireRemovedImmutabilityState?: () => void;
  timeoutMs: number;
  session: Pick<
    typeof OnboardSession,
    | "withOwnedOnboardLock"
    | "loadSession"
    | "listRetainedSandboxRecoveryRecords"
    | "retainedSandboxRecoveryMatchesSession"
    | "resolveRetainedSandboxRecovery"
  >;
  registry: Pick<typeof Registry, "getSandbox" | "removeSandboxRouteReservationIfCurrent">;
};

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

function requireGatewayAbsence(record: Recovery, state: RecoveryState): void {
  const { sandboxName, gatewayName } = record;
  const presence = state.observeSandbox(gatewayName);
  if (presence !== "absent") {
    refuse(sandboxName, `the owning OpenShell gateway reports sandbox presence as ${presence}`);
  }
}

function requireAbsence(record: Recovery, state: RecoveryState): void {
  const { sandboxName } = record;
  requireGatewayAbsence(record, state);
  const containers = classifyDestroyContainerIdentity(
    sandboxName,
    observeDestroyContainerIdentity(sandboxName, (args, options) =>
      dockerRun(["--context", "default", ...args], options),
    ),
  );
  if (containers.status !== "clear" || containers.identity !== null) {
    refuse(sandboxName, "the container runtime did not confirm sandbox absence");
  }
  const volumes = dockerRun(["--context", "default", "volume", "ls", "--format", "{{.Name}}"], {
    ignoreError: true,
    suppressOutput: true,
    timeout: state.timeoutMs,
  });
  if (volumes.status !== 0 || String(volumes.stderr ?? "").trim()) {
    refuse(sandboxName, "the container runtime could not inspect retained volumes");
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
    refuse(sandboxName, "retained volume absence is not established");
  }
  requireGatewayAbsence(record, state);
}

function requireReservationOwner(
  record: Recovery,
  entry: Registry.SandboxEntry,
  session: OnboardSession.Session | null,
  state: RecoveryState,
): void {
  const { name, gatewayName, gatewayPort } = entry;
  if (
    session?.status !== "recovery_required" ||
    session.sandboxName !== record.sandboxName ||
    session.cancellationRecovery?.reason !== record.reason ||
    !state.session.retainedSandboxRecoveryMatchesSession(record, session) ||
    state.registryEntryGatewayPort({ name, gatewayName, gatewayPort }) !== record.gatewayPort ||
    entry.hostLocalInferenceReceipt != null ||
    entry.nativeNvidiaProviderAttachment !== undefined ||
    classifySandboxInferenceRouteReservation(
      {
        sandboxName: record.sandboxName,
        gatewayName: record.gatewayName,
        sessionId: session.sessionId,
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
    if (entry) requireReservationOwner(record, entry, sessionState.loadSession(), state);
    const requireOwnedRuntime = () => {
      if (
        resolveGatewayCleanupRuntimeProviderId(record.gatewayName, entry?.openshellDriver, {
          requireOwnedRuntime: true,
          recoveryRecordedAt: record.recordedAt,
        }) !== "docker"
      ) {
        refuse(
          sandboxName,
          "the owning Docker runtime on the original default daemon could not be established",
        );
      }
    };
    requireOwnedRuntime();
    // The runner can normalize the native Linux default context to its explicit Unix endpoint.
    if (
      process.env.DOCKER_HOST?.trim() !== "unix:///var/run/docker.sock" &&
      !dockerContextIsDefaultFromBuild(process.env)
    ) {
      refuse(
        sandboxName,
        "the Docker observation target is not the native gateway's default daemon",
      );
    }
    requireAbsence(record, state);
    requireOwnedRuntime();
    // The onboarding lock prevents a new create while CAS protects the observed reservation.
    const currentRecords = sessionState
      .listRetainedSandboxRecoveryRecords()
      .filter((current) => current.sandboxName === sandboxName);
    if (!isDeepStrictEqual(currentRecords, candidates)) {
      refuse(sandboxName, "the recovery record changed during absence verification");
    }
    if (entry) requireReservationOwner(record, entry, sessionState.loadSession(), state);
    // Legacy state retirement must succeed while the recovery authority is still available for retry.
    state.retireRemovedImmutabilityState?.();
    if (entry && !registry.removeSandboxRouteReservationIfCurrent(entry)) {
      refuse(sandboxName, "the registry changed during absence verification");
    }
    if (registry.getSandbox(sandboxName) !== null) {
      refuse(sandboxName, "a registry entry appeared during reconciliation");
    }
    // Keep the independent record until both earlier local writes succeed so a retry can finish.
    if (!sessionState.resolveRetainedSandboxRecovery(record)) {
      refuse(sandboxName, "the recovery record could not be retired");
    }
    return true;
  });
}
