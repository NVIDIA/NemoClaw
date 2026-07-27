// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { verifyRestoredSandboxGatewayPairing } from "../../adapters/openshell/restore-gateway-pairing";
import type { GatewayRestartResult } from "./gateway-restart";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

export type RestoreGatewayPairingDeps = {
  restartRestoredSandboxGateway: (sandboxName: string) => void;
  warmupScopeUpgrade: (sandboxName: string) => void;
  autoPairScopeApproval: (sandboxName: string) => void;
  verifyGatewayPairing: (sandboxName: string) => boolean;
};

// A restored clone starts without runtime device credentials. Its first pass
// can approve initial pairing, while strict verification can provoke the
// remaining operator.write upgrade. Permit one bounded recovery pass.
const RESTORE_GATEWAY_PAIRING_ATTEMPTS = 2;

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
    for (let attempt = 0; attempt < RESTORE_GATEWAY_PAIRING_ATTEMPTS; attempt += 1) {
      // Registration approved by the first pass is not visible until the
      // gateway restarts. Repeat supervisor-mediated restart and host-forward
      // recovery before every bounded attempt.
      deps.restartRestoredSandboxGateway(targetSandbox);
      deps.warmupScopeUpgrade(targetSandbox);
      deps.autoPairScopeApproval(targetSandbox);
      if (deps.verifyGatewayPairing(targetSandbox)) {
        return;
      }
    }
    throw new Error("the authenticated gateway verification run did not succeed");
  } catch (err) {
    throw new Error(
      `could not establish gateway pairing for '${targetSandbox}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
