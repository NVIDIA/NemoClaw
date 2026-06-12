// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { DASHBOARD_PORT } from "../../core/ports";
import { stopHostGatewayProcesses } from "../../onboard/host-gateway-process";
import { stopStaleDashboardListeners } from "../../onboard/stale-gateway-cleanup";

export type DestroyRunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => { status: number | null; stdout?: string; stderr?: string };

const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);

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
  // stale host-side gateway-forward processes (#3397, #3398). The forward-stop
  // above releases ports the live openshell tracks; this catches orphans whose
  // openshell record was lost across upgrades or failed onboards.
  stopStaleDashboardListeners();
  if (process.platform === "linux") {
    // Sandbox destroy is conservative: only stop the host gateway whose PID
    // file we wrote during onboard. Disable the pgrep sweep so a stray
    // openshell-gateway under another user/project on the same host (rare but
    // possible on shared hosts) is not torn down by a NemoClaw `destroy`.
    // The uninstall path keeps the broader sweep on (run-plan.ts).
    stopHostGatewayProcesses({}, { usePgrepFallback: false });
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
