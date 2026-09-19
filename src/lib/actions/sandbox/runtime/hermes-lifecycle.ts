// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import type { MessagingOpenShellRunner } from "../../../messaging/applier/types";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import * as processRecovery from "../process-recovery";
import { withSandboxLifecycleLock } from "../lifecycle/lock";
import {
  createHermesSandboxIdentityRevalidator,
  restartHermesSandboxThroughOpenShell,
} from "./hermes-sandbox-lifecycle";

export function createRegisteredHermesSandboxIdentityRevalidator(input: {
  readonly sandboxName: string;
  readonly getSandbox: Parameters<typeof createHermesSandboxIdentityRevalidator>[0]["getSandbox"];
  readonly observeSandbox: (
    sandboxName: string,
    gatewayName: string,
  ) => { readonly liveIdentityFingerprint: string | null };
}): (operation: string) => void {
  return createHermesSandboxIdentityRevalidator({
    sandboxName: input.sandboxName,
    getSandbox: input.getSandbox,
    inspectLiveIdentity: (sandboxName, gatewayName) => {
      const fingerprint = input.observeSandbox(sandboxName, gatewayName).liveIdentityFingerprint;
      if (typeof fingerprint !== "string") {
        throw new Error(`Sandbox '${sandboxName}' has no verifiable live identity.`);
      }
      return fingerprint;
    },
  });
}

export async function withHermesCredentialEnvReconciliationLock<T>(
  sandboxName: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return await withSandboxLifecycleLock(sandboxName, operation);
}

export function createHermesCredentialEnvReconciliationRuntime(
  gatewayName: string,
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
      return restartHermesSandboxThroughOpenShell(
        sandboxName,
        gatewayName,
        runOpenshell,
        revalidate,
      );
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
