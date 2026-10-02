// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type RestoreGatewayPairingVerificationResult,
  verifyRestoredSandboxGatewayPairing,
} from "../../adapters/openshell/restore-gateway-pairing";
import { type AutoPairApprovalReceipt, runSandboxAutoPairApprovalPass } from "./auto-pair-approval";
import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  CONNECT_AUTO_PAIR_MAX_APPROVALS,
  CONNECT_AUTO_PAIR_TIMEOUT_MS,
} from "./connect-autopair-budget";
import type { GatewayRestartResult } from "./gateway-restart";
import { WARMUP_SESSION_ID_PREFIX } from "./warmup-session";

export type RestoreGatewayPairingDeps = {
  restartRestoredSandboxGateway: (sandboxName: string) => Promise<void>;
  warmupScopeUpgrade: (sandboxName: string) => void;
  approveRestoredClonePairing: (sandboxName: string) => AutoPairApprovalReceipt | void;
  verifyGatewayPairing: (sandboxName: string) => RestoreGatewayPairingVerificationResult;
};

const RESTORED_CLONE_PAIRING_BUDGET = {
  maxApprovals: CONNECT_AUTO_PAIR_MAX_APPROVALS,
  listTimeoutS: CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
  approveTimeoutS: CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  timeoutMs: CONNECT_AUTO_PAIR_TIMEOUT_MS,
} as const;

class RestoreGatewayPairingClassifiedError extends Error {}

type RestoredSandboxGatewayRestartDeps = {
  restartSandboxGateway: (
    sandboxName: string,
    options?: { quiet?: boolean },
  ) => Promise<GatewayRestartResult>;
};

function defaultRestoredSandboxGatewayRestartDeps(): RestoredSandboxGatewayRestartDeps {
  const recovery: typeof import("./process-recovery") = require("./process-recovery");
  return {
    restartSandboxGateway: recovery.restartSandboxGateway,
  };
}

export async function restartRestoredSandboxGateway(
  sandboxName: string,
  deps: RestoredSandboxGatewayRestartDeps = defaultRestoredSandboxGatewayRestartDeps(),
): Promise<void> {
  const result = await deps.restartSandboxGateway(sandboxName, { quiet: true });
  if (!result.ok) {
    throw new RestoreGatewayPairingClassifiedError(result.failureLayer);
  }
}

export function approveRestoredClonePairing(sandboxName: string): AutoPairApprovalReceipt {
  const result = runSandboxAutoPairApprovalPass(sandboxName, {
    budget: RESTORED_CLONE_PAIRING_BUDGET,
    localDeviceOnly: true,
    receipt: true,
  });
  return result.receipt ?? "exec-failed";
}

function defaultRestoreGatewayPairingDeps(): RestoreGatewayPairingDeps {
  const warmup: typeof import("./auto-pair-warmup") = require("./auto-pair-warmup");
  return {
    restartRestoredSandboxGateway,
    warmupScopeUpgrade: warmup.runRestoredSandboxScopeWarmupRun,
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
    await deps.restartRestoredSandboxGateway(targetSandbox);
    deps.warmupScopeUpgrade(targetSandbox);
    let approvalReceipt = deps.approveRestoredClonePairing(targetSandbox) ?? "exec-failed";
    // Publish the clone's approved pairing transition before an ordinary
    // authenticated verifier. The verifier alone decides success.
    await deps.restartRestoredSandboxGateway(targetSandbox);
    let verification = deps.verifyGatewayPairing(targetSandbox);
    if (
      !verification.ok &&
      approvalReceipt === "list-pending-unavailable" &&
      verification.failureLayer === "scope-upgrade-pending"
    ) {
      // The first approval pass could not call the canonical approve command
      // because no clone-local pending file existed. The ordinary verifier then
      // published the exact scope-upgrade request. Approve that request once,
      // restart once, and keep the next ordinary verifier as the success gate.
      approvalReceipt = deps.approveRestoredClonePairing(targetSandbox) ?? "exec-failed";
      await deps.restartRestoredSandboxGateway(targetSandbox);
      verification = deps.verifyGatewayPairing(targetSandbox);
    }
    if (!verification.ok) {
      throw new RestoreGatewayPairingClassifiedError(
        `the authenticated gateway verification run failed (${verification.failureLayer}; approval=${approvalReceipt})`,
      );
    }
  } catch (err) {
    const classification =
      err instanceof RestoreGatewayPairingClassifiedError ? err.message : "unexpected-failure";
    throw new Error(
      `could not establish gateway pairing for '${targetSandbox}': ${classification}`,
    );
  }
}
