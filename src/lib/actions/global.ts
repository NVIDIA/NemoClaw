// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type GarbageCollectImagesOptions,
  type UpgradeSandboxesOptions,
} from "../domain/lifecycle/options";
import { recoverNamedGatewayRuntime as recoverNamedGatewayRuntimeAction } from "../gateway-runtime-action";
import type { OnboardFlags } from "../onboard/command-support";
import {
  backupAll as executeBackupAllAction,
  garbageCollectImages as executeGarbageCollectImagesAction,
} from "./maintenance";
import { runOnboardAction as executeOnboardAction, type OnboardActionRuntimeDeps } from "./onboard";
import { help, version } from "./root-help";

type GatewayRecovery = { recovered: boolean };

export type ManagedMcpCredentialReservation = {
  sandboxName: string;
  server: string;
  credentialKeys: readonly string[];
};

type GlobalCliActionRuntimeHooks = {
  recoverNamedGatewayRuntime?: () => Promise<GatewayRecovery>;
  upgradeSandboxes?: (options?: string[] | UpgradeSandboxesOptions) => Promise<void>;
  recordExtraProvider?: (name: string) => boolean;
  forgetExtraProvider?: (name: string) => boolean;
  listManagedMcpCredentialReservations?: () => readonly ManagedMcpCredentialReservation[];
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

export function listManagedMcpCredentialReservations(): readonly ManagedMcpCredentialReservation[] {
  if (typeof runtimeHooks.listManagedMcpCredentialReservations === "function") {
    return runtimeHooks.listManagedMcpCredentialReservations();
  }
  const { listManagedMcpCredentialReservations: queryReservations } =
    require("../state/registry/mcp-credential-reservations") as {
      listManagedMcpCredentialReservations: () => readonly ManagedMcpCredentialReservation[];
    };
  return queryReservations();
}
