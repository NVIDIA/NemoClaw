// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReadinessProjection } from "../../readiness/gateway";
import type { GatewayReuseState } from "../../state/gateway";
import type { Session } from "../../state/onboard-session";
import { getGatewayPortCheckOptions } from "../docker-driver-gateway-env";
import * as fatalRuntimePreflight from "../fatal-runtime-preflight";
import type { GatewayOwner } from "../gateway-ownership";
import {
  failFastOnForeignGatewayPortConflict,
  type GatewayPortConflictDeps,
} from "../gateway-port-conflict";
import type { GatewayReuseSnapshot } from "../gateway-reuse";

export interface OnboardGatewayReadinessCollectorDeps {
  gatewayName(): string;
  gatewayPort(): number;
  resolveOwner(): GatewayOwner;
  probeAttachment: Parameters<
    typeof fatalRuntimePreflight.collectOnboardGatewayReadiness
  >[0]["probeAttachment"];
}

export interface PreparePreflightGatewayAuthorityDeps {
  collectGatewayReadiness(): Promise<GatewayReadinessProjection>;
  ensureOpenshell(persistTrustedGatewayOwner: (owner: GatewayOwner) => void): void;
  persistTrustedGatewayOwner(owner: GatewayOwner): void;
  gatewayPort: number;
  portConflict: Omit<GatewayPortConflictDeps, "gatewayPort" | "externallySupervised">;
  getGatewayReuseSnapshot(): GatewayReuseSnapshot;
  selectNamedGatewayForReuseIfNeeded(snapshot: GatewayReuseSnapshot): GatewayReuseSnapshot;
  refreshDockerDriverGatewayReuseState(state: GatewayReuseState): Promise<GatewayReuseState>;
}

export interface PreflightGatewayAuthority {
  externallySupervised: boolean;
  gatewayReuseState: GatewayReuseState;
}

export interface OnboardPreflightGatewayAuthorityDeps
  extends Pick<OnboardGatewayReadinessCollectorDeps, "gatewayName" | "gatewayPort"> {
  collectGatewayReadiness(
    deps: OnboardGatewayReadinessCollectorDeps,
  ): Promise<fatalRuntimePreflight.CollectedGatewayReadiness>;
  getGatewayOwnerDeps(): {
    resolveGatewayOwner(): GatewayOwner;
    probeGatewayAttachment: OnboardGatewayReadinessCollectorDeps["probeAttachment"];
  };
  isNonInteractive(): boolean;
  ensureOpenshellForOnboard(
    exitProcess: (code: number) => never,
    persistTrustedGatewayOwner: (owner: GatewayOwner) => void,
  ): void;
  updateSession(mutator: (session: Session) => Session | void): Session;
  adoptPackagedGatewayAuthorityAfterTrustedInstall(
    session: Session,
    owner: GatewayOwner,
  ): GatewayOwner;
  checkPortAvailable: GatewayPortConflictDeps["checkPortAvailable"];
  isDockerDriverGatewayPortListener: GatewayPortConflictDeps["isDockerDriverGatewayPortListener"];
  getGatewayReuseSnapshot(): GatewayReuseSnapshot;
  selectNamedGatewayForReuseIfNeeded(snapshot: GatewayReuseSnapshot): GatewayReuseSnapshot;
  refreshDockerDriverGatewayReuseState(state: GatewayReuseState): Promise<GatewayReuseState>;
}

export function createOnboardPreflightGatewayAuthority(deps: OnboardPreflightGatewayAuthorityDeps) {
  const collectGateway = () => {
    const ownerDeps = deps.getGatewayOwnerDeps();
    return deps.collectGatewayReadiness({
      gatewayName: deps.gatewayName,
      gatewayPort: deps.gatewayPort,
      resolveOwner: ownerDeps.resolveGatewayOwner,
      probeAttachment: ownerDeps.probeGatewayAttachment,
    });
  };
  const collectGatewayReadiness = async () => (await collectGateway()).projection;
  return {
    collectGatewayReadiness,
    runRuntimePreflight: (
      options: Parameters<typeof fatalRuntimePreflight.runReadinessGatedRuntimePreflight>[0],
      exitProcess?: NonNullable<
        Parameters<typeof fatalRuntimePreflight.runReadinessGatedRuntimePreflight>[1]["exitProcess"]
      >,
    ) =>
      fatalRuntimePreflight.runReadinessGatedRuntimePreflight(options, {
        nonInteractive: deps.isNonInteractive(),
        collectGatewayReadiness: collectGateway,
        ...(exitProcess ? { exitProcess } : {}),
      }),
    prepareGatewayAuthority: () =>
      preparePreflightGatewayAuthority({
        collectGatewayReadiness,
        ensureOpenshell: (persistTrustedGatewayOwner) =>
          deps.ensureOpenshellForOnboard((code) => process.exit(code), persistTrustedGatewayOwner),
        persistTrustedGatewayOwner: (owner) => {
          deps.updateSession((session) => {
            deps.adoptPackagedGatewayAuthorityAfterTrustedInstall(session, owner);
          });
        },
        gatewayPort: deps.gatewayPort(),
        portConflict: {
          checkPortAvailable: deps.checkPortAvailable,
          getGatewayPortCheckOptions,
          isDockerDriverGatewayPortListener: deps.isDockerDriverGatewayPortListener,
          exitProcess: (code) => process.exit(code),
        },
        getGatewayReuseSnapshot: deps.getGatewayReuseSnapshot,
        selectNamedGatewayForReuseIfNeeded: deps.selectNamedGatewayForReuseIfNeeded,
        refreshDockerDriverGatewayReuseState: deps.refreshDockerDriverGatewayReuseState,
      }),
  };
}

export function collectOnboardGatewayReadiness(
  deps: OnboardGatewayReadinessCollectorDeps,
): Promise<fatalRuntimePreflight.CollectedGatewayReadiness> {
  return fatalRuntimePreflight.collectOnboardGatewayReadiness(deps);
}

function isManagedGateway(readiness: GatewayReadinessProjection): boolean {
  return readiness.observations.some(
    ({ id, state, value }) =>
      id === "gateway.management.mode" && state === "present" && value === "nemoclaw-managed",
  );
}

export async function preparePreflightGatewayAuthority(
  deps: PreparePreflightGatewayAuthorityDeps,
): Promise<PreflightGatewayAuthority> {
  deps.ensureOpenshell(deps.persistTrustedGatewayOwner);

  // Installation and portable preparation can replace binaries, services, or
  // runtime endpoints. Refresh authority before any lifecycle effect consumes it.
  const gatewayReadiness = await deps.collectGatewayReadiness();
  fatalRuntimePreflight.assertOnboardGatewayReadiness(gatewayReadiness);
  const externallySupervised = !isManagedGateway(gatewayReadiness);
  await failFastOnForeignGatewayPortConflict({
    gatewayPort: deps.gatewayPort,
    externallySupervised,
    ...deps.portConflict,
  });

  const observedSnapshot = deps.getGatewayReuseSnapshot();
  const gatewayReuseState = externallySupervised
    ? observedSnapshot.gatewayReuseState
    : await deps.refreshDockerDriverGatewayReuseState(
        deps.selectNamedGatewayForReuseIfNeeded(observedSnapshot).gatewayReuseState,
      );
  return { externallySupervised, gatewayReuseState };
}
