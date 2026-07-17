// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { dockerRemoveVolumesByPrefix } from "../../adapters/docker/volume";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { DASHBOARD_PORT } from "../../core/ports";
import {
  resolveGatewayPortFromName,
  resolveGatewayStateDirName,
} from "../../onboard/gateway-binding";
import { stopHostGatewayProcesses } from "../../onboard/host-gateway-process";
import { stopStaleDashboardListeners } from "../../onboard/stale-gateway-cleanup";

export type DestroyRunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => { status: number | null; stdout?: string; stderr?: string };

const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);

// Compute the Docker-driver gateway state directory that belongs to
// `gatewayName`. `stopHostGatewayProcesses` defaults to the bare leaf
// `openshell-docker-gateway`, so without this override a destroy of a
// `nemoclaw-<port>` sandbox would read the default instance's pid file and
// stop the wrong host gateway process. Returns null when the gateway name is
// outside the NemoClaw namespace (the caller then keeps the defaults).
function resolvePerGatewayState(gatewayName: string): { port: number; stateDir: string } | null {
  const port = resolveGatewayPortFromName(gatewayName);
  if (port === null) return null;
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  if (configured && configured.trim()) {
    return { port, stateDir: path.resolve(configured.trim()) };
  }
  return {
    port,
    stateDir: path.join(
      os.homedir(),
      ".local",
      "state",
      "nemoclaw",
      resolveGatewayStateDirName(port),
    ),
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
): void {
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
  if (process.platform === "linux" || process.platform === "darwin") {
    // Sandbox destroy is conservative: only stop the host gateway whose PID
    // file we wrote during onboard. Disable the pgrep sweep so a stray
    // openshell-gateway under another user/project on the same host (rare but
    // possible on shared hosts) is not torn down by a NemoClaw `destroy`.
    // The uninstall path keeps the broader sweep on (run-plan.ts). The state
    // dir is per-gateway-name so a destroy of `nemoclaw-<port>` reads the
    // per-port pid file rather than defaulting to the bare instance's. The
    // expected gateway name and port also gate `openshell gateway start`
    // cmdlines so a stale pid file cannot kill another gateway instance.
    const perGatewayState = resolvePerGatewayState(gatewayName);
    const stopOptions: {
      openShellGatewayName?: string;
      openShellGatewayPort?: number;
      preserveRuntimeFilesOnNonMatching: true;
      usePgrepFallback: false;
      stateDir?: string;
      pidFile?: string;
    } = {
      preserveRuntimeFilesOnNonMatching: true,
      usePgrepFallback: false,
    };
    if (perGatewayState) {
      stopOptions.stateDir = perGatewayState.stateDir;
      stopOptions.pidFile = path.join(perGatewayState.stateDir, "openshell-gateway.pid");
      stopOptions.openShellGatewayName = gatewayName;
      stopOptions.openShellGatewayPort = perGatewayState.port;
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
   * 0.0.85) before this function can run.
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
    openshell(["gateway", "destroy", "-g", gatewayName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  dockerRemoveVolumesByPrefix(`openshell-cluster-${gatewayName}`, {
    ignoreError: true,
  });
}
