// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../adapters/openshell/runtime";
import {
  type GarbageCollectImagesOptions,
  type UpgradeSandboxesOptions,
} from "../domain/lifecycle/options";
import { recoverNamedGatewayRuntime as recoverNamedGatewayRuntimeAction } from "../gateway-runtime-action";
import type { OnboardFlags } from "../onboard/command-support";
import { buildSubprocessEnv } from "../subprocess-env";
import { runDeployAction as executeDeployAction } from "./deploy";
import {
  backupAll as executeBackupAllAction,
  garbageCollectImages as executeGarbageCollectImagesAction,
} from "./maintenance";
import { runOnboardAction as executeOnboardAction } from "./onboard";
import { help, version } from "./root-help";

type GatewayRecovery = { recovered: boolean };

type GlobalCliActionRuntimeHooks = {
  recoverNamedGatewayRuntime?: () => Promise<GatewayRecovery>;
  runOpenshell?: typeof runOpenshell;
  upgradeSandboxes?: (options?: string[] | UpgradeSandboxesOptions) => Promise<void>;
};

let runtimeHooks: GlobalCliActionRuntimeHooks = {};

export function setGlobalCliActionRuntimeHooksForTest(hooks: GlobalCliActionRuntimeHooks): void {
  runtimeHooks = hooks;
}

export async function runOnboardAction(flags: OnboardFlags): Promise<void> {
  await executeOnboardAction(flags);
}

export async function runDeployAction(instanceName?: string): Promise<void> {
  await executeDeployAction(instanceName);
}

export async function runBackupAllAction(): Promise<void> {
  await executeBackupAllAction();
}

export async function runUpgradeSandboxesAction(
  options: string[] | UpgradeSandboxesOptions = {},
): Promise<void> {
  if (typeof runtimeHooks.upgradeSandboxes === "function") {
    await runtimeHooks.upgradeSandboxes(options);
    return;
  }
  const { upgradeSandboxes } = require("./upgrade-sandboxes") as {
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
  const explicitEnv = Object.fromEntries(
    Object.entries(opts?.env ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const providerOpts = {
    ...opts,
    env: buildSubprocessEnv(explicitEnv),
    replaceEnv: true,
  };
  if (typeof runtimeHooks.runOpenshell === "function") {
    return runtimeHooks.runOpenshell(args, providerOpts);
  }
  return runOpenshell(args, providerOpts);
}
