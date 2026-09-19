// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import type { MessagingOpenShellRunner } from "../../../messaging/applier/types";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import * as processRecovery from "../process-recovery";

export function createHermesCredentialEnvReconciliationRuntime(
  runOpenshell: MessagingOpenShellRunner,
  revalidateSandboxIdentity: (operation: string) => void,
) {
  const runSandboxLifecycle = (
    sandboxName: string,
    action: "stop" | "start",
    revalidate: (operation: string) => void,
  ) => {
    revalidate(`${action === "stop" ? "stopping" : "starting"} Hermes sandbox '${sandboxName}'`);
    const result = runOpenshell(["sandbox", action, sandboxName], {
      ignoreError: true,
      suppressOutput: true,
      timeout: 210000,
    });
    revalidate(`confirming Hermes sandbox '${sandboxName}' after OpenShell ${action}`);
    return {
      status: typeof result.status === "number" ? result.status : 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  };

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
    restartGateway: async (sandboxName: string, revalidate: (operation: string) => void) => {
      const stopped = runSandboxLifecycle(sandboxName, "stop", revalidate);
      if (stopped.status !== 0) return stopped;
      return runSandboxLifecycle(sandboxName, "start", revalidate);
    },
    waitForGateway: async (sandboxName: string, revalidate: (operation: string) => void) => {
      revalidate(`checking Hermes gateway health for sandbox '${sandboxName}'`);
      const healthy = await processRecovery.waitForRecoveredSandboxGateway(sandboxName, {
        quiet: true,
        initialManagedHealthPassed: false,
        managedProbeImpl: () => null,
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
