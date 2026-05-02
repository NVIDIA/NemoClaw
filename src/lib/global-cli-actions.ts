// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- transitional action facade until implementations leave src/nemoclaw.ts. */

import { runDeployAction as executeDeployAction } from "./deploy-action";
import {
  backupAll as executeBackupAllAction,
  garbageCollectImages as executeGarbageCollectImagesAction,
} from "./maintenance-actions";
import {
  runOnboardAction as executeOnboardAction,
  runSetupAction as executeSetupAction,
  runSetupSparkAction as executeSetupSparkAction,
} from "./onboard-action";
import { getNemoClawRuntimeBridge } from "./nemoclaw-runtime-bridge";
import { help, version } from "./root-help-action";

export async function runOnboardAction(args: string[] = []): Promise<void> {
  await executeOnboardAction(args);
}

export async function runSetupAction(args: string[] = []): Promise<void> {
  await executeSetupAction(args);
}

export async function runSetupSparkAction(args: string[] = []): Promise<void> {
  await executeSetupSparkAction(args);
}

export async function runDeployAction(instanceName?: string): Promise<void> {
  await executeDeployAction(instanceName);
}

export function runBackupAllAction(): void {
  executeBackupAllAction();
}

export async function runUpgradeSandboxesAction(args: string[] = []): Promise<void> {
  await getNemoClawRuntimeBridge().upgradeSandboxes(args);
}

export async function runGarbageCollectImagesAction(args: string[] = []): Promise<void> {
  await executeGarbageCollectImagesAction(args);
}

export function showRootHelp(): void {
  help();
}

export function showVersion(): void {
  version();
}

export async function recoverNamedGatewayRuntime(): Promise<{ recovered: boolean }> {
  return getNemoClawRuntimeBridge().recoverNamedGatewayRuntime();
}

export function runOpenshellProviderCommand(
  args: string[],
  opts?: {
    env?: Record<string, string | undefined>;
    ignoreError?: boolean;
    stdio?: import("node:child_process").StdioOptions;
    timeout?: number;
  },
) {
  return getNemoClawRuntimeBridge().runOpenshell(args, opts);
}
