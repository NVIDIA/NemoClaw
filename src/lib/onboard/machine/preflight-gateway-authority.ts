// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReadinessProjection } from "../../readiness/gateway";
import type { GatewayReuseState } from "../../state/gateway";
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

export function collectOnboardGatewayReadiness(
  deps: OnboardGatewayReadinessCollectorDeps,
): Promise<GatewayReadinessProjection> {
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
