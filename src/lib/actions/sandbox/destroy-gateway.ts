// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { dockerRemoveVolumesByPrefix } from "../../adapters/docker/volume";
import {
  OPENSHELL_HEAVY_TIMEOUT_MS,
  OPENSHELL_OPERATION_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import { DASHBOARD_PORT } from "../../core/ports";
import { stopOpenShellGatewayUserService } from "../../onboard/docker-driver-gateway-service";
import {
  resolveGatewayPortFromName,
  resolveGatewayStateDirForPort,
} from "../../onboard/gateway-binding";
import { type GatewayOwner, isExternallySupervised } from "../../onboard/gateway-ownership";
import {
  GatewayAuthorityError,
  type GatewayTeardownAuthorityResolver,
  gatewayAuthorityFailureLines,
  resolveGatewayTeardownAuthority,
} from "../../onboard/gateway-teardown-authority";
import {
  clearHostGatewayRuntimeFiles,
  isHostPortFree,
  stopHostGatewayProcesses,
} from "../../onboard/host-gateway-process";
import { stopStaleDashboardListeners } from "../../onboard/stale-gateway-cleanup";

export type DestroyRunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => { error?: Error; status: number | null; stdout?: string; stderr?: string };

export const SANDBOX_DESTROY_TIMEOUT_MS = OPENSHELL_HEAVY_TIMEOUT_MS;

const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);

export interface CleanupGatewayDeps {
  clearGatewayRuntimeFiles?: typeof clearHostGatewayRuntimeFiles;
  isGatewayPortFree?: typeof isHostPortFree;
  resolveGatewayTeardownAuthority?: GatewayTeardownAuthorityResolver;
  stopOpenShellGatewayUserService?: typeof stopOpenShellGatewayUserService;
}

// Compute the Docker-driver gateway state directory that belongs to
// `gatewayName`. `stopHostGatewayProcesses` defaults to the bare leaf
// `openshell-docker-gateway`, so without this override a destroy of a
// `nemoclaw-<port>` sandbox would read the default instance's pid file and
// stop the wrong host gateway process. Returns null when the gateway name is
// outside the NemoClaw namespace (the caller then keeps the defaults).
function resolvePerGatewayState(gatewayName: string): { port: number; stateDir: string } | null {
  const port = resolveGatewayPortFromName(gatewayName);
  if (port === null) return null;
  return {
    port,
    stateDir: resolveGatewayStateDirForPort({
      configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
      home: os.homedir(),
      port,
    }),
  };
}

export function selectGatewayForSandboxDestroy(
  sandboxName: string,
  gatewayName: string,
  runOpenshell: DestroyRunOpenshell,
): void {
  const result = runOpenshell(["gateway", "select", gatewayName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (result.status === 0) return;

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (output) {
    console.error(`  ${output}`);
  }
  console.error(
    `  Failed to select gateway '${gatewayName}' before destroying sandbox '${sandboxName}'.`,
  );
  process.exit(result.status || 1);
}

export function cleanupGatewayAfterLastSandbox(
  gatewayName: string,
  runOpenshell?: DestroyRunOpenshell,
  deps: CleanupGatewayDeps = {},
): void {
  const perGatewayState = resolvePerGatewayState(gatewayName);
  if (!perGatewayState) {
    throw new Error(`Refusing cleanup for noncanonical NemoClaw gateway '${gatewayName}'.`);
  }
  // The sandbox and its registry entry are already gone when this runs; shared
  // gateway cleanup is the last, optional step. Rethrowing an authority refusal
  // here crashed `destroy` outright, and because rebuild and
  // `onboard --recreate-sandbox` refuse for the same reason the operator was
  // left with no way to remove the sandbox at all (#8103). Report and keep the
  // gateway instead, matching the declined-cleanup path.
  let owner: GatewayOwner;
  try {
    owner = (deps.resolveGatewayTeardownAuthority ?? resolveGatewayTeardownAuthority)(
      { gatewayName, gatewayPort: perGatewayState.port },
      { env: process.env },
    );
  } catch (error) {
    if (!(error instanceof GatewayAuthorityError)) throw error;
    for (const line of gatewayAuthorityFailureLines(error, "shared gateway cleanup")) {
      console.error(line);
    }
    console.log("  The shared NemoClaw gateway was left running.");
    return;
  }
  const externallySupervised = isExternallySupervised(owner);
  const openshell =
    runOpenshell ??
    (require("../../adapters/openshell/runtime") as { runOpenshell: DestroyRunOpenshell })
      .runOpenshell;

  openshell(["forward", "stop", DASHBOARD_FORWARD_PORT], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // After the cooperative forward-stop, sweep the dashboard port range for
  // stale host-side gateway-forward processes. The forward-stop above releases
  // ports the live openshell tracks; this catches orphans whose openshell
  // record was lost across upgrades or failed onboards.
  stopStaleDashboardListeners();
  let packagedServiceFallbackReason: string | null = null;
  if (!externallySupervised && owner.source === "packaged-service") {
    const stopService = deps.stopOpenShellGatewayUserService ?? stopOpenShellGatewayUserService;
    const serviceStop = stopService();
    if (serviceStop.attempted && !serviceStop.stopped) {
      if (serviceStop.standaloneFallbackAllowed) {
        packagedServiceFallbackReason = serviceStop.reason ?? "user service manager unavailable";
      } else {
        throw new Error(
          `Failed to stop the packaged OpenShell gateway service '${serviceStop.serviceName}' that owns gateway '${gatewayName}': ${serviceStop.reason}. ` +
            `Check: ${serviceStop.statusCommand}. Stop the service, then rerun destroy.`,
        );
      }
    }
  }
  if (!externallySupervised && (process.platform === "linux" || process.platform === "darwin")) {
    // Sandbox destroy is conservative: only stop the host gateway whose PID
    // file we wrote during onboard. Disable the pgrep sweep so a stray
    // openshell-gateway under another user/project on the same host (rare but
    // possible on shared hosts) is not torn down by a NemoClaw `destroy`.
    // The uninstall path keeps the broader sweep on (run-plan.ts). The state
    // dir is per-gateway-name so a destroy of `nemoclaw-<port>` reads the
    // per-port pid file rather than defaulting to the bare instance's. The
    // expected gateway name and port also gate `openshell gateway start`
    // cmdlines so a stale pid file cannot kill another gateway instance.
    const stopOptions: {
      openShellGatewayName?: string;
      openShellGatewayPort?: number;
      preserveRuntimeFilesOnNonMatching: true;
      usePgrepFallback: false;
      clearRuntimeFiles?: boolean;
      stateDir?: string;
      pidFile?: string;
    } = {
      preserveRuntimeFilesOnNonMatching: true,
      usePgrepFallback: false,
    };
    stopOptions.stateDir = perGatewayState.stateDir;
    stopOptions.pidFile = path.join(perGatewayState.stateDir, "openshell-gateway.pid");
    stopOptions.openShellGatewayName = gatewayName;
    stopOptions.openShellGatewayPort = perGatewayState.port;
    if (packagedServiceFallbackReason !== null) {
      // A package can be installed even when its user manager is unavailable.
      // Destroy cannot repair the missing systemd user session. Remove this
      // branch when supported onboarding no longer starts a standalone gateway
      // after this service-manager failure.
      // In that exact start fallback, the standalone launcher wrote this
      // per-gateway PID evidence. Preserve it until every later cleanup step
      // succeeds so a retry can prove the same ownership again.
      stopOptions.clearRuntimeFiles = false;
    }
    const stopResult = stopHostGatewayProcesses({}, stopOptions);
    const unverifiablePids = [...new Set(stopResult.skippedNonMatchingPids)];
    if (unverifiablePids.length > 0) {
      throw new Error(
        `Refusing cleanup because PID-file process(es) ${unverifiablePids.join(", ")} do not prove ownership of gateway '${gatewayName}'. Inspect the process and per-gateway PID file, stop only the matching gateway listener, then rerun destroy.`,
      );
    }
    const failedPids = [...new Set([...stopResult.failed, ...stopResult.sudoRemediationPids])];
    if (failedPids.length > 0) {
      const remediation =
        stopResult.sudoRemediationPids.length > 0
          ? ` Retry with sufficient permissions for PID(s) ${stopResult.sudoRemediationPids.join(", ")}, then rerun destroy.`
          : " Retry destroy after stopping the listed process(es).";
      throw new Error(
        `Failed to stop the owned host gateway process(es) for '${gatewayName}': ${failedPids.join(", ")}.${remediation}`,
      );
    }
    if (packagedServiceFallbackReason !== null) {
      const ownedStandalonePidProven =
        stopResult.stopped.length > 0 || stopResult.skippedDeadPids.length > 0;
      if (!ownedStandalonePidProven) {
        throw new Error(
          `Failed to stop the packaged OpenShell gateway service for '${gatewayName}' because ${packagedServiceFallbackReason}, and no recorded standalone gateway process proved ownership. ` +
            "Restore the user service manager or stop the verified gateway listener, then rerun destroy.",
        );
      }
      const portFree = deps.isGatewayPortFree ?? isHostPortFree;
      if (!portFree(perGatewayState.port)) {
        throw new Error(
          `Refusing cleanup because gateway port ${String(perGatewayState.port)} remains occupied after the recorded standalone gateway process for '${gatewayName}' exited or was stopped. ` +
            "Inspect the remaining listener, stop only the matching gateway process, then rerun destroy.",
        );
      }
    }
  }
  /**
   * SOURCE_OF_TRUTH
   * Invalid state: a pre-0.0.44 OpenShell CLI does not expose `gateway remove`.
   * Source boundary: the installed CLI may predate the blueprint floor while
   * an existing installation is being recovered or removed.
   * Source-fix constraint: NemoClaw cannot add the modern verb to historical
   * OpenShell builds, so cleanup tries their legacy verb best-effort.
   * Regression proof: test/cli/destroy-gateway-cleanup.test.ts covers successful
   * remove and remove-nonzero fallback while preserving Docker-volume cleanup.
   * Removal condition: remove the fallback when every supported recovery and
   * teardown entry point upgrades OpenShell to the blueprint minimum (currently
   * 0.0.99) before this function can run.
   *
   * macOS previously ran only `gateway destroy`, which current OpenShell
   * rejects as an unrecognized subcommand (#6569). The host-process stop above
   * now uses the same PID-file-scoped reaper as Linux so final unattended
   * macOS destroys release the Docker-driver gateway listener (#4662).
   * Removal tracker: #6639. Remove the macOS reliance on this host-process
   * fallback after OpenShell releases the Docker-driver listener fix, NemoClaw
   * raises its supported OpenShell floor to that fixed build, and a real macOS
   * Docker-driver sandbox-operations run proves final unattended destroy
   * releases the gateway port without this fallback.
   */
  const removeResult = openshell(["gateway", "remove", gatewayName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (removeResult.status !== 0) {
    if (externallySupervised) {
      console.warn(
        `Could not remove local registration for externally supervised gateway '${gatewayName}'. ` +
          "NemoClaw will not use the legacy gateway destroy command for an externally supervised gateway.",
      );
    } else {
      openshell(["gateway", "destroy", "-g", gatewayName], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  }
  if (externallySupervised) {
    return;
  }
  dockerRemoveVolumesByPrefix(`openshell-cluster-${gatewayName}`, {
    ignoreError: true,
  });
  if (packagedServiceFallbackReason !== null) {
    const clearRuntimeFiles = deps.clearGatewayRuntimeFiles ?? clearHostGatewayRuntimeFiles;
    clearRuntimeFiles(
      perGatewayState.stateDir,
      path.join(perGatewayState.stateDir, "openshell-gateway.pid"),
    );
  }
}
