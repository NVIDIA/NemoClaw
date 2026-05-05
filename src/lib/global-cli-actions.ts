// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runDeployAction as executeDeployAction } from "./deploy-action";
import {
  type GarbageCollectImagesOptions,
  type UpgradeSandboxesOptions,
} from "./lifecycle-options";
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
import { runOpenshell } from "./openshell-runtime";
import { help, version } from "./root-help-action";

type GatewayRecovery = { recovered: boolean };

type GlobalCliActionRuntimeHooks = {
  recoverNamedGatewayRuntime?: () => Promise<GatewayRecovery>;
  runOpenshell?: typeof runOpenshell;
  upgradeSandboxes?: (options?: string[] | UpgradeSandboxesOptions) => Promise<void>;
};

let runtimeHooks: GlobalCliActionRuntimeHooks = {};

export function setGlobalCliActionRuntimeHooksForTest(
  hooks: GlobalCliActionRuntimeHooks,
): void {
  runtimeHooks = hooks;
}

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

export async function runUpgradeSandboxesAction(
  options: string[] | UpgradeSandboxesOptions = {},
): Promise<void> {
  if (typeof runtimeHooks.upgradeSandboxes === "function") {
    await runtimeHooks.upgradeSandboxes(options);
    return;
  }
  const { upgradeSandboxes } = require("./upgrade-sandboxes-action") as {
    upgradeSandboxes: (options?: string[] | UpgradeSandboxesOptions) => Promise<void>;
  };
  await upgradeSandboxes(options);
}

export async function runGarbageCollectImagesAction(
  options: string[] | GarbageCollectImagesOptions = {},
): Promise<void> {
  await executeGarbageCollectImagesAction(options);
}

export function showRootHelp(): void {
  help();
}

export function showVersion(): void {
  version();
}

export async function recoverNamedGatewayRuntime(): Promise<GatewayRecovery> {
  if (typeof runtimeHooks.recoverNamedGatewayRuntime === "function") {
    return runtimeHooks.recoverNamedGatewayRuntime();
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
  if (typeof runtimeHooks.runOpenshell === "function") {
    return runtimeHooks.runOpenshell(args, opts);
  }
  return runOpenshell(args, opts);
}
