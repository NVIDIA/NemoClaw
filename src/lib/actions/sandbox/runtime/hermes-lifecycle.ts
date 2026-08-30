// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import type { MessagingOpenShellRunner } from "../../../messaging/applier/types";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import * as gatewayRestart from "../gateway-restart";
import * as processRecovery from "../process-recovery";

export function createHermesCredentialEnvReconciliationRuntime(
  runOpenshell: MessagingOpenShellRunner,
  revalidateSandboxIdentity: (operation: string) => void,
) {
  return {
    reconcileCredentialEnv: (plan: SandboxMessagingPlan, revalidate: (operation: string) => void) =>
      MessagingSetupApplier.reconcileCredentialEnvAtOpenShell(plan, {
        runOpenshell: (args, options) => {
          revalidate(`mutating Hermes credential environment for sandbox '${plan.sandboxName}'`);
          const result = runOpenshell(args, options);
          revalidate(`confirming Hermes credential environment for sandbox '${plan.sandboxName}'`);
          return result;
        },
      }),
    restartGateway: (sandboxName: string, revalidate: (operation: string) => void) => {
      revalidate(`restarting Hermes gateway for sandbox '${sandboxName}'`);
      const result = processRecovery.executeGatewaySupervisorAction(sandboxName, "restart", 210000);
      revalidate(`confirming Hermes gateway restart for sandbox '${sandboxName}'`);
      return result;
    },
    parseRestartCompletion: gatewayRestart.parseManagedGatewayControlCompletion,
    waitForGateway: (sandboxName: string, revalidate: (operation: string) => void) => {
      revalidate(`checking Hermes gateway health for sandbox '${sandboxName}'`);
      const healthy = processRecovery.waitForRecoveredSandboxGateway(sandboxName, {
        quiet: true,
        initialManagedHealthPassed: true,
        requireManagedProbe: true,
      });
      revalidate(`confirming Hermes gateway health for sandbox '${sandboxName}'`);
      return healthy;
    },
    revalidateSandboxIdentity,
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
