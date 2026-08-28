// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import type { MessagingOpenShellRunner } from "../../../messaging/applier/types";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import * as gatewayRestart from "../gateway-restart";
import * as processRecovery from "../process-recovery";

export function createHermesCredentialEnvReconciliationRuntime(
  runOpenshell: MessagingOpenShellRunner,
  revalidatePolicyAuthority: (operation: string) => void,
) {
  return {
    reconcileCredentialEnv: (plan: SandboxMessagingPlan) =>
      MessagingSetupApplier.reconcileCredentialEnvAtOpenShell(plan, {
        runOpenshell,
      }),
    restartGateway: (sandboxName: string) =>
      processRecovery.executeGatewaySupervisorAction(sandboxName, "restart", 210000),
    parseRestartCompletion: gatewayRestart.parseManagedGatewayControlCompletion,
    waitForGateway: (sandboxName: string) =>
      processRecovery.waitForRecoveredSandboxGateway(sandboxName, {
        quiet: true,
        initialManagedHealthPassed: true,
        requireManagedProbe: true,
      }),
    revalidatePolicyAuthority,
  };
}

// Keep process-recovery's importer count flat: post-restore and post-create
// reconciliation share this focused lifecycle adapter.
export function restartSandboxGateway(
  ...args: Parameters<typeof processRecovery.restartSandboxGateway>
) {
  return processRecovery.restartSandboxGateway(...args);
}

export function checkAndRecoverSandboxProcesses(
  ...args: Parameters<typeof processRecovery.checkAndRecoverSandboxProcesses>
) {
  return processRecovery.checkAndRecoverSandboxProcesses(...args);
}

export function executePrivilegedSandboxCommand(
  ...args: Parameters<typeof processRecovery.executePrivilegedSandboxCommand>
) {
  return processRecovery.executePrivilegedSandboxCommand(...args);
}

export type SandboxCommandResult = processRecovery.SandboxCommandResult;
