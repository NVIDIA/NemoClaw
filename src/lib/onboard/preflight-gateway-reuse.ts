// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayContainerState } from "./gateway-container-running";
import type { GatewayReuseState } from "../state/gateway";

export interface PreflightGatewayReuseDeps {
  gatewayReuseState: GatewayReuseState;
  supportsLifecycleCommands: boolean;
  gatewayName: string;
  verifyGatewayContainerRunning(name: string): GatewayContainerState;
  recoverGatewayRuntime(): Promise<boolean>;
  waitForGatewayHttpReady(): Promise<boolean>;
  getGatewayLocalEndpoint(): string;
  stopDashboardForward(): void;
  stopAllDashboardForwards(): void;
  destroyGateway(): boolean;
  destroyGatewayForReuse(
    destroyGateway: () => boolean,
    successMessage: string,
    failureMessage: string,
  ): GatewayReuseState;
  getGatewayClusterImageDrift(): { currentVersion: string; expectedVersion: string } | null;
  exitProcess(code: number): never;
}

/**
 * Preflight reconciliation for the legacy lifecycle-CLI gateway. Verifies the
 * `openshell-cluster-${gatewayName}` Docker container against cached gateway
 * metadata and decides whether to reuse, recover, or recreate. See #2020 for
 * the original stale-metadata handling and #4187 for the stop/start recovery
 * branch that preserves the k3s local-path PVC volumes.
 *
 * Returns the (possibly downgraded) `GatewayReuseState`. Caller drives the
 * destructive cleanup and final start using the same hooks the original
 * inline block did.
 */
export async function reconcilePreflightGatewayReuseState(
  deps: PreflightGatewayReuseDeps,
): Promise<GatewayReuseState> {
  let gatewayReuseState = deps.gatewayReuseState;
  if (gatewayReuseState !== "healthy" || !deps.supportsLifecycleCommands) {
    return gatewayReuseState;
  }

  const containerState = deps.verifyGatewayContainerRunning(deps.gatewayName);
  let checkImageDrift = false;
  if (containerState === "missing") {
    console.log("  Gateway metadata is stale (container not running). Cleaning up...");
    deps.stopDashboardForward();
    gatewayReuseState = deps.destroyGatewayForReuse(
      deps.destroyGateway,
      "  ✓ Stale gateway metadata cleaned up",
      "  ! Stale gateway metadata cleanup failed; leaving registry state intact.",
    );
  } else if (containerState === "stopped") {
    // #4187: a stopped legacy `openshell-cluster-*` container after a host VM
    // stop/start still holds the k3s local-path PVC volume. Attempt
    // non-destructive recovery (openshell gateway start) before any
    // destructive cleanup path so we never delete the PVC backing data and
    // silently provision a fresh, empty workspace.
    console.log(
      "  Gateway container is stopped (likely host or Docker restart). Attempting non-destructive recovery...",
    );
    const recovered = await deps.recoverGatewayRuntime();
    if (recovered) {
      console.log(
        "  ✓ Gateway recovered without removing volumes; existing sandbox PVC preserved.",
      );
      checkImageDrift = true;
    } else {
      console.error(
        `  Could not start the stopped NemoClaw gateway and ${deps.getGatewayLocalEndpoint()}/ is not responding.`,
      );
      console.error(
        "  Refusing to delete openshell-cluster-* volumes — they may hold the existing PVC/workspace data.",
      );
      console.error(
        "  Restart Docker, free the gateway port if held by another process, and re-run `nemoclaw onboard`. See #4187.",
      );
      deps.exitProcess(1);
    }
  } else if (containerState === "unknown") {
    // Docker probe failed but cached metadata says healthy. Try the host-level
    // HTTP probe — it doesn't depend on Docker, so it can confirm the gateway
    // is genuinely serving even when the daemon is flaky.
    //
    // Per #2020 the "unknown" state must stay non-destructive end-to-end: do
    // not downgrade to "missing" in preflight even when HTTP probe fails.
    // Doing so would feed the orphan-cleanup block below, and a transient
    // `docker inspect` failure plus an HTTP warm-up miss would delete a live
    // gateway. The main onboard "unknown" branch makes the abort/reuse
    // decision once preflight has surfaced the warning to the user.
    if (await deps.waitForGatewayHttpReady()) {
      console.log(
        "  Warning: could not verify gateway container state (Docker may be unavailable), but the gateway is responding on HTTP. Proceeding with reuse.",
      );
    } else {
      console.log(
        "  Warning: could not verify gateway container state and the gateway is not responding on HTTP. Onboard will abort before reuse if this persists; restart Docker and re-run.",
      );
    }
  } else if (!(await deps.waitForGatewayHttpReady())) {
    // Container is running but the gateway HTTP endpoint is not responding.
    // Common immediately after a Docker daemon restart — the container comes
    // back before the OpenShell gateway upstream finishes warming up. Safe to
    // recreate because Docker is functional. See #3258.
    console.log(
      `  Gateway container is running but ${deps.getGatewayLocalEndpoint()}/ is not responding. Recreating...`,
    );
    deps.stopDashboardForward();
    gatewayReuseState = deps.destroyGatewayForReuse(
      deps.destroyGateway,
      "  ✓ Stale gateway cleaned up",
      "  ! Stale gateway cleanup failed; leaving registry state intact.",
    );
  } else {
    checkImageDrift = true;
  }

  if (checkImageDrift) {
    const imageDrift = deps.getGatewayClusterImageDrift();
    if (imageDrift) {
      console.log(
        `  Gateway image ${imageDrift.currentVersion} does not match openshell ${imageDrift.expectedVersion}. Recreating...`,
      );
      deps.stopAllDashboardForwards();
      gatewayReuseState = deps.destroyGatewayForReuse(
        deps.destroyGateway,
        "  ✓ Previous gateway cleaned up",
        "  ! Previous gateway cleanup failed; leaving registry state intact.",
      );
    }
  }

  return gatewayReuseState;
}
