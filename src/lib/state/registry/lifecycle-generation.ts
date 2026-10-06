// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { resolveRegisteredRuntimeProvider } from "../../onboard/runtime-provider/selection";
import { registryEntryGatewayPort } from "../gateway-registry";
import type { OnboardCheckpoint } from "../onboard-checkpoint-types";
import {
  compareAndSetSandboxLifecycleGeneration,
  compareAndSetSandboxLifecycleIdentity,
} from "./lifecycle-generation-cas";
import type { SandboxEntry } from "./types";

export function usesLegacyRuntimeLifecycleCompatibility(entry: SandboxEntry): boolean {
  const driverName = entry.openshellDriver?.trim().toLowerCase();
  if (!driverName) return false;
  const provider = resolveRegisteredRuntimeProvider(driverName);
  if (!provider || provider.identity.id !== driverName || provider.lifecycle.supported !== true) {
    return false;
  }
  try {
    return (
      provider.gateway.observeHostRuntime({
        environment: process.env,
        platform: process.platform,
      }).socketPath === null
    );
  } catch {
    return false;
  }
}

/** Claim a lifecycle generation for one unchanged legacy Docker registry row. */
export function compareAndSetLegacySandboxLifecycleGeneration(
  expected: SandboxEntry,
  lifecycleGeneration: string,
): boolean {
  if (
    !usesLegacyRuntimeLifecycleCompatibility(expected) ||
    expected.lifecycleGeneration !== undefined
  ) {
    return false;
  }
  return compareAndSetSandboxLifecycleGeneration(expected, lifecycleGeneration);
}

interface LifecycleRecoverySessionStore {
  isOnboardLockHeldByCurrentProcess(): boolean;
  acquireOnboardLock(command: string): { acquired: boolean };
  assertOnboardLockOwned(): void;
  releaseOnboardLock(): void;
  loadSession(): {
    sessionId: string;
    status: string;
    machine: { state: string };
    failure: unknown;
    cancellationRecovery: unknown;
    sandboxName: string | null;
    metadata: { gatewayName: string };
    checkpoint: OnboardCheckpoint | null;
  } | null;
}

export function recoverSandboxLifecycleIdentity(
  expected: SandboxEntry,
  gatewayName: string,
  inspectLiveIdentity: (sandboxName: string, gatewayName: string) => string,
  sessionStore: LifecycleRecoverySessionStore,
): SandboxEntry | null {
  const snapshot = structuredClone(expected);
  if (snapshot.pendingRouteReservation || snapshot.pendingCreateIdentity) return null;
  const gatewayPort = registryEntryGatewayPort({
    name: snapshot.name,
    gatewayName: snapshot.gatewayName,
    gatewayPort: snapshot.gatewayPort,
  });
  if (registryEntryGatewayPort({ name: snapshot.name, gatewayName }) !== gatewayPort) return null;
  const managesLock = !sessionStore.isOnboardLockHeldByCurrentProcess();
  if (
    managesLock &&
    !sessionStore.acquireOnboardLock("nemoclaw recover messaging lifecycle identity").acquired
  ) {
    throw new Error(
      "Cannot recover messaging lifecycle identity while another onboarding writer is active.",
    );
  }
  try {
    sessionStore.assertOnboardLockOwned();
    const session = sessionStore.loadSession();
    const checkpoint = session?.checkpoint;
    const receipt = checkpoint?.sandboxRecreate;
    if (
      session?.status !== "complete" ||
      session.machine.state !== "complete" ||
      session.failure ||
      session.cancellationRecovery ||
      session.sandboxName !== snapshot.name ||
      session.metadata.gatewayName !== gatewayName ||
      checkpoint?.sessionId !== session.sessionId ||
      checkpoint.machineState !== "complete" ||
      checkpoint.sandboxIdentity.kind !== "selected" ||
      checkpoint.sandboxIdentity.value.name !== snapshot.name ||
      checkpoint.sandboxIdentity.value.agent !== (snapshot.agent ?? "openclaw") ||
      receipt?.phase !== "completed" ||
      receipt.sandboxName !== snapshot.name ||
      receipt.gatewayName !== gatewayName ||
      receipt.gatewayPort !== gatewayPort ||
      !receipt.targetLiveIdentityFingerprint
    )
      return null;
    const registration = {
      lifecycleGeneration: receipt.targetGeneration,
      lifecycleLiveIdentityFingerprint: receipt.targetLiveIdentityFingerprint,
    };
    const revalidate = () => {
      sessionStore.assertOnboardLockOwned();
      if (
        inspectLiveIdentity(snapshot.name, gatewayName) !==
          registration.lifecycleLiveIdentityFingerprint ||
        !isDeepStrictEqual(sessionStore.loadSession(), session)
      )
        throw new Error("Completed sandbox lifecycle identity changed during messaging recovery.");
      sessionStore.assertOnboardLockOwned();
    };
    revalidate();
    return compareAndSetSandboxLifecycleIdentity(snapshot, registration, revalidate)
      ? { ...snapshot, ...registration }
      : null;
  } finally {
    if (managesLock) sessionStore.releaseOnboardLock();
  }
}
