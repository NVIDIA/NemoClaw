// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "../state/gateway";
import type { GatewayContainerState } from "./gateway-container-running";
import { applyPreflightGatewayCleanup } from "./preflight-gateway-cleanup-decision";
import { reconcilePreflightGatewayReuseState } from "./preflight-gateway-reuse";
import { cleanupOrphanedGatewayContainer } from "./preflight-orphan-gateway-cleanup";

export interface PreflightGatewaySequenceDeps {
  gatewayReuseState: GatewayReuseState;
  /** Resolved once by the caller before this sequence runs (#6576). */
  externallySupervised: boolean;
  supportsLifecycleCommands: boolean;
  isDockerDriverGatewayEnabled: boolean;
  gatewayName: string;
  cliDisplayName: string;
  dashboardPort: number;
  verifyGatewayContainerRunning(name: string): GatewayContainerState;
  recoverGatewayRuntime(): Promise<boolean>;
  waitForGatewayHttpReady(): Promise<boolean>;
  getGatewayLocalEndpoint(): string;
  stopDashboardForward(): void;
  stopAllDashboardForwards(): void;
  getGatewayClusterImageDrift(): { currentVersion: string; expectedVersion: string } | null;
  exitProcess(code: number): never;
  destroyGateway(): boolean;
  destroyGatewayForReuse(
    destroyGateway: () => boolean,
    successMessage: string,
    failureMessage: string,
  ): GatewayReuseState;
  runOpenshell(args: string[], options: { ignoreError: true }): unknown;
  dockerInspect(
    args: string[],
    opts: { ignoreError: true; suppressOutput: true },
  ): { status: number | null };
  dockerStop(name: string, opts: { ignoreError: true; suppressOutput: true }): unknown;
  dockerRm(name: string, opts: { ignoreError: true; suppressOutput: true }): unknown;
  dockerRemoveVolumesByPrefix(
    prefix: string,
    opts: { ignoreError: true; suppressOutput: true },
  ): unknown;
  clearRegistry(): void;
  log(message: string): void;
  warn(message: string): void;
}

/**
 * The full preflight gateway-mutating sequence, composed exactly as onboard
 * runs it: reuse reconciliation, then stale/unnamed cleanup, then orphaned
 * container cleanup — each stage consuming the reuse state the previous stage
 * produced.
 *
 * The one lifecycle authority is resolved by the caller before this sequence
 * and threaded to every stage, so an externally supervised gateway crosses the
 * whole path with zero destructive effects. Keeping the composition in one
 * unit makes that guarantee testable end-to-end: the original #6576 regression
 * was two guarded stages followed by an unguarded one, which per-stage tests
 * cannot catch.
 */
export async function runPreflightGatewaySequence(
  deps: PreflightGatewaySequenceDeps,
): Promise<GatewayReuseState> {
  let gatewayReuseState = await reconcilePreflightGatewayReuseState({
    gatewayReuseState: deps.gatewayReuseState,
    supportsLifecycleCommands: deps.supportsLifecycleCommands,
    externallySupervised: deps.externallySupervised,
    gatewayName: deps.gatewayName,
    verifyGatewayContainerRunning: deps.verifyGatewayContainerRunning,
    recoverGatewayRuntime: deps.recoverGatewayRuntime,
    waitForGatewayHttpReady: deps.waitForGatewayHttpReady,
    getGatewayLocalEndpoint: deps.getGatewayLocalEndpoint,
    stopDashboardForward: deps.stopDashboardForward,
    stopAllDashboardForwards: deps.stopAllDashboardForwards,
    destroyGateway: deps.destroyGateway,
    destroyGatewayForReuse: deps.destroyGatewayForReuse,
    getGatewayClusterImageDrift: deps.getGatewayClusterImageDrift,
    exitProcess: deps.exitProcess,
  });

  gatewayReuseState = applyPreflightGatewayCleanup({
    gatewayReuseState,
    isDockerDriverGatewayEnabled: deps.isDockerDriverGatewayEnabled,
    externallySupervised: deps.externallySupervised,
    cliDisplayName: deps.cliDisplayName,
    dashboardPort: deps.dashboardPort,
    log: deps.log,
    warn: deps.warn,
    runOpenshell: deps.runOpenshell,
    destroyGateway: deps.destroyGateway,
    destroyGatewayForReuse: deps.destroyGatewayForReuse,
  });

  cleanupOrphanedGatewayContainer({
    gatewayReuseState,
    isDockerDriverGatewayEnabled: deps.isDockerDriverGatewayEnabled,
    externallySupervised: deps.externallySupervised,
    gatewayName: deps.gatewayName,
    dockerInspect: deps.dockerInspect,
    dockerStop: deps.dockerStop,
    dockerRm: deps.dockerRm,
    dockerRemoveVolumesByPrefix: deps.dockerRemoveVolumesByPrefix,
    clearRegistry: deps.clearRegistry,
    log: deps.log,
    warn: deps.warn,
  });

  return gatewayReuseState;
}
