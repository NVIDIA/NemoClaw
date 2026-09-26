// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../../agent/runtime";
import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import type { MessagingOpenShellRunner } from "../../../messaging/applier/types";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
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
    restartGateway: async (sandboxName: string, revalidate: (operation: string) => void) => {
      revalidate(`restarting Hermes gateway for sandbox '${sandboxName}'`);
      const result = await processRecovery.restartSandboxGateway(sandboxName, { quiet: true });
      revalidate(`confirming Hermes gateway restart for sandbox '${sandboxName}'`);
      return result.ok
        ? { status: 0, stdout: "Hermes gateway restarted and forwards recovered.", stderr: "" }
        : {
            status: 1,
            stdout: "",
            stderr: `${result.failureLayer}: ${result.detail}`,
          };
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

export async function waitForGatedHermesGatewayRecovery(sandboxName: string): Promise<boolean> {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const timeoutSeconds = agent?.name === "hermes" ? agent.healthProbe?.timeout_seconds : undefined;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 0
  ) {
    return false;
  }
  return processRecovery.waitForRecoveredSandboxGateway(sandboxName, {
    quiet: true,
    timeoutSeconds,
    // Hermes and OpenShell own the native gateway lifecycle. Observe the
    // relaunched gateway through its sandbox health endpoint instead of the
    // retired NemoClaw managed-gateway controller.
    managedProbeImpl: () => null,
  });
}

export type { SandboxCommandResult } from "../../../adapters/sandbox/command-transport";
