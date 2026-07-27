// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type RestoreGatewayPairingVerificationResult,
  verifyRestoredSandboxGatewayPairing,
} from "../../adapters/openshell/restore-gateway-pairing";
import { runSandboxAutoPairApprovalPass } from "./auto-pair-approval";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "./connect-autopair-budget";
import type { GatewayRestartResult } from "./gateway-restart";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

export type RestoreGatewayPairingDeps = {
  restartRestoredSandboxGateway: (sandboxName: string) => void;
  warmupScopeUpgrade: (sandboxName: string) => void;
  approveRestoredClonePairing: (sandboxName: string) => void;
  verifyGatewayPairing: (sandboxName: string) => RestoreGatewayPairingVerificationResult;
};

const RESTORED_CLONE_PAIRING_BUDGET = {
  maxApprovals: CONNECT_AUTO_PAIR_MAX_APPROVALS,
  listTimeoutS: CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  approveTimeoutS: CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  timeoutMs: CONNECT_AUTO_PAIR_TIMEOUT_MS,
} as const;

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

export function approveRestoredClonePairing(sandboxName: string): void {
  runSandboxAutoPairApprovalPass(sandboxName, {
    budget: RESTORED_CLONE_PAIRING_BUDGET,
    localDeviceOnly: true,
  });
}

function defaultRestoreGatewayPairingDeps(): RestoreGatewayPairingDeps {
  const warmup: typeof import("./auto-pair-warmup") = require("./auto-pair-warmup");
  return {
    restartRestoredSandboxGateway,
    warmupScopeUpgrade: warmup.runSandboxScopeWarmupRun,
    approveRestoredClonePairing,
    verifyGatewayPairing: (sandboxName) =>
      verifyRestoredSandboxGatewayPairing(sandboxName, WARMUP_SESSION_ID_PREFIX),
  };
}

export async function establishRestoredSandboxGatewayPairing(
  targetSandbox: string,
  deps: RestoreGatewayPairingDeps = defaultRestoreGatewayPairingDeps(),
): Promise<void> {
  try {
    deps.restartRestoredSandboxGateway(targetSandbox);
    deps.warmupScopeUpgrade(targetSandbox);
    deps.approveRestoredClonePairing(targetSandbox);
    // Publish the clone's approved pairing transition before the one ordinary
    // authenticated verifier. The verifier alone decides success.
    deps.restartRestoredSandboxGateway(targetSandbox);
    const verification = deps.verifyGatewayPairing(targetSandbox);
    if (!verification.ok) {
      throw new Error(
        `the authenticated gateway verification run failed (${verification.failureLayer})`,
      );
    }
  } catch (err) {
    throw new Error(
      `could not establish gateway pairing for '${targetSandbox}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
