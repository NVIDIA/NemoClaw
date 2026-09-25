// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { registryEntryGatewayPort } from "../state/gateway-registry";
import type { SelectionDrift } from "./selection-drift";

export function removeSandboxUnlessSessionReservation(
  entry: SandboxEntry | null,
  sandboxName: string,
): void {
  const session = onboardSession.loadSession();
  const recreate = session?.checkpoint?.sandboxRecreate;
  if (registry.isPendingReservationForSession(entry, session?.sessionId)) return;
  if (entry?.pendingRouteReservation === true) {
    if (!session || !onboardSession.isOnboardLockHeldByCurrentProcess()) return;
    if (!registry.removeSandboxRouteReservationIfCurrent(entry)) {
      throw new Error(
        `Cannot recreate sandbox '${sandboxName}' because its pending create recovery state is protected or changed. Run the same onboarding command with \`--resume\` to continue the saved onboarding session. NemoClaw removes the reservation only when that session retains authority.`,
      );
    }
    return;
  }
  if (recreate?.sandboxName === sandboxName && recreate.phase !== "completed") {
    return;
  }
  registry.removeSandbox(sandboxName);
}

/**
 * Release an abandoned inference reservation while retaining published sandbox data.
 *
 * `reserveSandboxInferenceRoute` refuses a pending reservation whose
 * `reservationSessionId` differs from the caller's and reports it as belonging
 * to "another onboarding session". A reservation left behind by a run that
 * never reached sandbox creation carries a session id just like a live one, so
 * that field alone cannot tell the two apart, and `onboard --fresh` failed at
 * the inference step naming a session that no longer exists (#11051). Nothing
 * released it earlier: `removeSandboxUnlessSessionReservation` runs at sandbox
 * creation, one step after the reservation is written.
 *
 * The onboard lock is the mutual exclusion between onboarding runs. While this
 * process holds it no other session can be reserving against this gateway, so
 * a foreign-session route-only row is abandoned rather than contended.
 *
 * A failed re-onboard can also reserve an already registered sandbox. Transfer
 * that pending row to the current session without publishing its unverified
 * route or losing its existing data.
 * Both operations compare the complete observed row and reject verified create
 * checkpoints, so a reservation that gains create authority survives.
 */
export function releaseAbandonedRouteReservation(
  sandboxName: string,
  desiredRoute: Parameters<typeof registry.reserveSandboxInferenceRoute>[1],
): boolean {
  const entry = registry.getSandbox(sandboxName);
  if (!entry || entry.pendingRouteReservation !== true) return false;
  const session = onboardSession.loadSession();
  if (!session || !onboardSession.isOnboardLockHeldByCurrentProcess()) return false;
  if (registry.isPendingReservationForSession(entry, session.sessionId)) return false;
  if (!registry.isRouteOnlySandboxReservation(entry)) {
    const authority = session.checkpoint?.gatewayAuthority;
    if (
      typeof entry.createdAt !== "string" ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      !entry.gatewayName ||
      authority?.kind !== "selected" ||
      entry.gatewayName !== authority.value.gatewayName ||
      desiredRoute.gatewayName !== authority.value.gatewayName ||
      (desiredRoute.gatewayPort !== undefined &&
        desiredRoute.gatewayPort !== authority.value.gatewayPort) ||
      desiredRoute.reservationSessionId !== session.sessionId
    ) {
      return false;
    }
    try {
      if (
        registryEntryGatewayPort({
          name: entry.name,
          gatewayName: entry.gatewayName,
          gatewayPort: entry.gatewayPort,
        }) !== authority.value.gatewayPort
      )
        return false;
    } catch {
      return false;
    }
    return registry.reserveSandboxInferenceRoute(sandboxName, desiredRoute, {
      reclaimAbandoned: entry,
    });
  }
  return registry.removeSandboxRouteReservationIfCurrent(entry);
}

/** Keep skipped-inference and sandbox-reuse callers on the same locked transfer path. */
export function reserveRecoveredSandboxInferenceRoute<
  Route extends Parameters<typeof registry.reserveSandboxInferenceRoute>[1],
>(reserve: (name: string, route: Route) => boolean, sandboxName: string, route: Route): boolean {
  releaseAbandonedRouteReservation(sandboxName, route);
  return reserve(sandboxName, route);
}

export interface SandboxLifecycleDeps {
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
  getGatewayName(): string;
  fetchGatewayAuthTokenFromSandbox(sandboxName: string): Promise<string | null>;
  agentProductName(): string;
  prompt(question: string): Promise<string>;
  isAffirmativeAnswer(value: string | null | undefined): boolean;
}

export interface SandboxLifecycleHelpers {
  inspectSandboxForCreate(sandboxName: string): {
    existingEntry: SandboxEntry | null;
    liveExists: boolean;
  };
  shouldRestoreLatestBackupOnRecreate(): boolean;
  confirmRecreateForSelectionDrift(
    sandboxName: string,
    drift: SelectionDrift,
    requestedProvider: string | null,
    requestedModel: string | null,
  ): Promise<boolean>;
  isOpenclawReady(sandboxName: string): Promise<boolean>;
}

export function createSandboxLifecycleHelpers(deps: SandboxLifecycleDeps): SandboxLifecycleHelpers {
  function sandboxExistsInGateway(sandboxName: string): boolean {
    const output = deps.runCaptureOpenshell(
      ["sandbox", "get", "--gateway", deps.getGatewayName(), sandboxName],
      { ignoreError: true },
    );
    return Boolean(output);
  }

  function inspectSandboxForCreate(sandboxName: string) {
    const existingEntry = registry.getSandbox(sandboxName);
    const liveExists = sandboxExistsInGateway(sandboxName);
    return { existingEntry, liveExists };
  }

  function shouldRestoreLatestBackupOnRecreate(): boolean {
    return process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE === "1";
  }

  async function confirmRecreateForSelectionDrift(
    sandboxName: string,
    drift: SelectionDrift,
    requestedProvider: string | null,
    requestedModel: string | null,
  ): Promise<boolean> {
    const currentProvider = drift.existingProvider || "unknown";
    const currentModel = drift.existingModel || "unknown";
    const nextProvider = requestedProvider || "unknown";
    const nextModel = requestedModel || "unknown";

    console.log(`  Sandbox '${sandboxName}' exists but requested inference selection changed.`);
    console.log(`  Current:   provider=${currentProvider}  model=${currentModel}`);
    console.log(`  Requested: provider=${nextProvider}  model=${nextModel}`);
    console.log(
      `  Recreating the sandbox is required to apply this change to the running ${deps.agentProductName()} UI.`,
    );

    const answer = await deps.prompt(`  Recreate sandbox '${sandboxName}' now? [y/N]: `);
    return deps.isAffirmativeAnswer(answer);
  }

  async function isOpenclawReady(sandboxName: string): Promise<boolean> {
    return Boolean(await deps.fetchGatewayAuthTokenFromSandbox(sandboxName));
  }

  return {
    inspectSandboxForCreate,
    shouldRestoreLatestBackupOnRecreate,
    confirmRecreateForSelectionDrift,
    isOpenclawReady,
  };
}
