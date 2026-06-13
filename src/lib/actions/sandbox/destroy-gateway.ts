// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

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
function resolvePerGatewayStateDir(gatewayName: string): string | null {
  const port = resolveGatewayPortFromName(gatewayName);
  if (port === null) return null;
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  if (configured && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), ".local", "state", "nemoclaw", resolveGatewayStateDirName(port));
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
  const { dockerRemoveVolumesByPrefix } = require("../../adapters/docker") as {
    dockerRemoveVolumesByPrefix: (prefix: string, opts?: { ignoreError?: boolean }) => void;
  };

  openshell(["forward", "stop", DASHBOARD_FORWARD_PORT], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // After the cooperative forward-stop, sweep the dashboard port range for
  // stale host-side gateway-forward processes. The forward-stop above releases
  // ports the live openshell tracks; this catches orphans whose openshell
  // record was lost across upgrades or failed onboards.
  stopStaleDashboardListeners();
  if (process.platform === "linux") {
    // Sandbox destroy is conservative: only stop the host gateway whose PID
    // file we wrote during onboard. Disable the pgrep sweep so a stray
    // openshell-gateway under another user/project on the same host (rare but
    // possible on shared hosts) is not torn down by a NemoClaw `destroy`.
    // The uninstall path keeps the broader sweep on (run-plan.ts). The state
    // dir is per-gateway-name so a destroy of `nemoclaw-<port>` reads the
    // per-port pid file rather than defaulting to the bare instance's.
    const perGatewayStateDir = resolvePerGatewayStateDir(gatewayName);
    const stopOptions: { usePgrepFallback: false; stateDir?: string; pidFile?: string } = {
      usePgrepFallback: false,
    };
    if (perGatewayStateDir) {
      stopOptions.stateDir = perGatewayStateDir;
      stopOptions.pidFile = path.join(perGatewayStateDir, "openshell-gateway.pid");
    }
    stopHostGatewayProcesses({}, stopOptions);
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
  } else {
    openshell(["gateway", "destroy", "-g", gatewayName], {
      ignoreError: true,
    });
  }
  dockerRemoveVolumesByPrefix(`openshell-cluster-${gatewayName}`, {
    ignoreError: true,
  });
}
