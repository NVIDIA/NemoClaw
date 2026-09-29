// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type GarbageCollectImagesOptions,
  type UpgradeSandboxesOptions,
} from "../domain/lifecycle/options";
import {
  type NamedGatewayLifecycleState,
  recoverNamedGatewayRuntime as recoverNamedGatewayRuntimeAction,
} from "../gateway-runtime-action";
import type { OnboardFlags } from "../onboard/command-support";
import { completeAutomaticGatewayPortAfterOnboard } from "../onboard/gateway/automatic-port-completion";
import {
  backupAll as executeBackupAllAction,
  garbageCollectImages as executeGarbageCollectImagesAction,
} from "./maintenance";
import { runOnboardAction as executeOnboardAction, type OnboardActionRuntimeDeps } from "./onboard";
import { help, version } from "./root-help";

export type GatewayRecovery = {
  recovered: boolean;
  attempted?: boolean;
  before?: NamedGatewayLifecycleState;
  after?: NamedGatewayLifecycleState;
};

type GlobalCliActionRuntimeHooks = {
  recoverNamedGatewayRuntime?: () => Promise<GatewayRecovery>;
  upgradeSandboxes?: (options?: string[] | UpgradeSandboxesOptions) => Promise<void>;
  recordExtraProvider?: (name: string) => boolean;
  forgetExtraProvider?: (name: string) => boolean;
};

let runtimeHooks: GlobalCliActionRuntimeHooks = {};

export function setGlobalCliActionRuntimeHooksForTest(hooks: GlobalCliActionRuntimeHooks): void {
  runtimeHooks = hooks;
}

export async function runOnboardAction(
  flags: OnboardFlags,
  runtimeDeps: OnboardActionRuntimeDeps = {},
): Promise<void> {
  await executeOnboardAction(flags, runtimeDeps);
  completeAutomaticGatewayPortAfterOnboard();
}

export async function runBackupAllAction(
  options: { retireLegacyForwards?: boolean } = {},
): Promise<void> {
  await executeBackupAllAction();
  if (options.retireLegacyForwards) {
    const { retireRegisteredLegacyDashboardForwards } = await import("./sandbox/forward-recovery");
    const result = await retireRegisteredLegacyDashboardForwards();
    console.log(
      `Legacy dashboard forwards: ${result.retired} retired, ${result.unchanged} unchanged, ${result.skipped} skipped.`,
    );
  }
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

export function recordExtraProvider(name: string): boolean {
  if (typeof runtimeHooks.recordExtraProvider === "function") {
    return runtimeHooks.recordExtraProvider(name);
  }
  const { addExtraProvider } = require("../state/registry/extra-providers") as {
    addExtraProvider: (name: string) => boolean;
  };
  return addExtraProvider(name);
}

export function forgetExtraProvider(name: string): boolean {
  if (typeof runtimeHooks.forgetExtraProvider === "function") {
    return runtimeHooks.forgetExtraProvider(name);
  }
  const { removeExtraProvider } = require("../state/registry/extra-providers") as {
    removeExtraProvider: (name: string) => boolean;
  };
  return removeExtraProvider(name);
}
