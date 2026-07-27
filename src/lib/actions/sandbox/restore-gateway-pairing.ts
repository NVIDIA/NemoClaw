// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type RestoreGatewayPairingVerificationResult,
  verifyRestoredSandboxGatewayPairing,
} from "../../adapters/openshell/restore-gateway-pairing";
import type { GatewayRestartResult } from "./gateway-restart";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

export type RestoreGatewayPairingDeps = {
  restartRestoredSandboxGateway: (sandboxName: string) => void;
  warmupScopeUpgrade: (sandboxName: string) => void;
  autoPairScopeApproval: (sandboxName: string) => void;
  verifyGatewayPairing: (sandboxName: string) => RestoreGatewayPairingVerificationResult;
};

// A restored clone starts without runtime device credentials. Restart once so
// its gateway serves the restored state. Each warm-up can provoke one
// allowlisted transition, but approved state is not visible until the gateway
// restarts. Strict verification can then provoke the remaining operator.write
// upgrade, so permit one bounded recovery cycle.
const RESTORE_GATEWAY_PAIRING_CYCLES = 2;

type RestoredSandboxGatewayRestartDeps = {
  restartSandboxGateway: (
    sandboxName: string,
    options?: { quiet?: boolean },
  ) => GatewayRestartResult;
};

function defaultRestoredSandboxGatewayRestartDeps(): RestoredSandboxGatewayRestartDeps {
  const { restartSandboxGateway }: typeof import("./process-recovery") =
    require("./process-recovery");
  return { restartSandboxGateway };
}

export function restartRestoredSandboxGateway(
  sandboxName: string,
  deps: RestoredSandboxGatewayRestartDeps = defaultRestoredSandboxGatewayRestartDeps(),
): void {
  const result = deps.restartSandboxGateway(sandboxName, { quiet: true });
  if (!result.ok) {
    throw new Error(`${result.failureLayer}: ${result.detail}`);
  }
}

function defaultRestoreGatewayPairingDeps(): RestoreGatewayPairingDeps {
  const warmup: typeof import("./auto-pair-warmup") = require("./auto-pair-warmup");
  const connect: typeof import("./connect") = require("./connect");
  return {
    restartRestoredSandboxGateway,
    warmupScopeUpgrade: warmup.runSandboxScopeWarmupRun,
    autoPairScopeApproval: connect.runConnectAutoPairApprovalPass,
    verifyGatewayPairing: (sandboxName) =>
      verifyRestoredSandboxGatewayPairing(sandboxName, WARMUP_SESSION_ID_PREFIX),
  };
}

export async function establishRestoredSandboxGatewayPairing(
  targetSandbox: string,
  deps: RestoreGatewayPairingDeps = defaultRestoreGatewayPairingDeps(),
): Promise<void> {
  try {
    let lastFailure: Extract<RestoreGatewayPairingVerificationResult, { ok: false }> | null = null;
    deps.restartRestoredSandboxGateway(targetSandbox);
    for (let cycle = 0; cycle < RESTORE_GATEWAY_PAIRING_CYCLES; cycle += 1) {
      deps.warmupScopeUpgrade(targetSandbox);
      deps.autoPairScopeApproval(targetSandbox);
      // Publish the approved transition to the running gateway before strict
      // verification. This also recovers the host forward through the existing
      // supervisor-mediated restart path.
      deps.restartRestoredSandboxGateway(targetSandbox);
      const verification = deps.verifyGatewayPairing(targetSandbox);
      if (verification.ok) {
        return;
      }
      lastFailure = verification;
    }
    throw new Error(
      `the authenticated gateway verification run failed (${lastFailure?.failureLayer ?? "unknown"})`,
    );
  } catch (err) {
    throw new Error(
      `could not establish gateway pairing for '${targetSandbox}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
