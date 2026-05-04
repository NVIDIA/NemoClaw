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
import { recoverNamedGatewayRuntime as recoverNamedGatewayRuntimeAction } from "./gateway-runtime-action";
import { getNemoClawRuntimeBridge } from "./nemoclaw-runtime-bridge";
import { runOpenshell } from "./openshell-runtime";
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
  const { upgradeSandboxes } = require("./upgrade-sandboxes-action") as {
    upgradeSandboxes: (args?: string[]) => Promise<void>;
  };
  await upgradeSandboxes(args);
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
  const runtime = getNemoClawRuntimeBridge() as {
    recoverNamedGatewayRuntime?: () => Promise<{ recovered: boolean }>;
  };
  if (typeof runtime.recoverNamedGatewayRuntime === "function") {
    return runtime.recoverNamedGatewayRuntime();
  }
  return recoverNamedGatewayRuntimeAction();
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
  const runtime = getNemoClawRuntimeBridge() as {
    runOpenshell?: typeof runOpenshell;
  };
  if (typeof runtime.runOpenshell === "function") {
    return runtime.runOpenshell(args, opts);
  }
  return runOpenshell(args, opts);
}
