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
  restartRestoredSandboxGateway: (sandboxName: string) => void;
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
  ) => GatewayRestartResult;
  checkAndRecoverSandboxProcesses: (
    sandboxName: string,
    options?: {
      quiet?: boolean;
      isSandboxGatewayRunningImpl?: (sandboxName: string) => boolean | null;
    },
  ) => {
    checked: boolean;
    recovered: boolean;
    forwardRecovered: boolean;
    forwardRecoveryFailed?: boolean;
  };
  waitForManagedGatewaySupervisor?: (sandboxName: string) => boolean;
};

function defaultRestoredSandboxGatewayRestartDeps(): RestoredSandboxGatewayRestartDeps {
  const recovery: typeof import("./process-recovery") = require("./process-recovery");
  return {
    restartSandboxGateway: recovery.restartSandboxGateway,
    checkAndRecoverSandboxProcesses: recovery.checkAndRecoverSandboxProcesses,
    waitForManagedGatewaySupervisor: recovery.waitForManagedGatewaySupervisor,
  };
}

export function waitForRestoredSandboxGatewaySupervisor(
  sandboxName: string,
  deps: RestoredSandboxGatewayRestartDeps = defaultRestoredSandboxGatewayRestartDeps(),
): boolean {
  return deps.waitForManagedGatewaySupervisor?.(sandboxName) === true;
}

export function restartRestoredSandboxGateway(
  sandboxName: string,
  deps: RestoredSandboxGatewayRestartDeps = defaultRestoredSandboxGatewayRestartDeps(),
): void {
  let result = deps.restartSandboxGateway(sandboxName, { quiet: true });
  if (!result.ok && result.failureLayer === "supervisor not running") {
    // OpenShell can publish a newly created clone as Ready before its persisted
    // startup command has brought up the managed supervisor. Give only that
    // exact state a bounded settling window before entering legacy-container
    // relaunch recovery.
    if (deps.waitForManagedGatewaySupervisor?.(sandboxName)) {
      result = deps.restartSandboxGateway(sandboxName, { quiet: true });
      if (result.ok) return;
    }
  }
  if (!result.ok && result.failureLayer === "supervisor not running") {
    // A restored OpenShell container can become ready before its managed
    // supervisor session exists. Reuse the existing transactional relaunch
    // path only for that exact classified failure. Recovery must prove both
    // the gateway and its primary forward before pairing work can continue.
    const recovery = deps.checkAndRecoverSandboxProcesses(sandboxName, {
      quiet: true,
      // The failed supervisor restart already proves the gateway cannot be
      // managed through the current container. Skip the redundant sandbox-exec
      // probe, which is itself unavailable when that supervisor is missing.
      // The transactional relaunch still re-confirms the exact missing
      // supervisor against the pinned container before replacing it.
      isSandboxGatewayRunningImpl: () => false,
    });
    if (
      recovery.checked &&
      recovery.recovered &&
      !recovery.forwardRecoveryFailed &&
      recovery.forwardRecovered
    ) {
      return;
    }
  }
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
  // Deliberately do not retry this authorization sequence internally. A fixed
  // failure lets the caller retry the restore command as a new bounded attempt.
  try {
    deps.restartRestoredSandboxGateway(targetSandbox);
    deps.warmupScopeUpgrade(targetSandbox);
    const approvalReceipt = deps.approveRestoredClonePairing(targetSandbox) ?? "exec-failed";
    // Publish the clone's approved pairing transition before the one ordinary
    // authenticated verifier. The verifier alone decides success.
    deps.restartRestoredSandboxGateway(targetSandbox);
    const verification = deps.verifyGatewayPairing(targetSandbox);
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
