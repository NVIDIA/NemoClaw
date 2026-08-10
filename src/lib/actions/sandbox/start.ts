// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cliName } from "../../onboard/branding";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  resolveSandboxLifecycleProvider,
  type SandboxLifecycleResult,
} from "./runtime/lifecycle-runtime";

export type SandboxStartGatewayVerificationOptions = {
  expectedContainerId?: string;
};

export const sandboxStartDependencies = {
  loadConnect(): typeof import("./connect") {
    return require("./connect") as typeof import("./connect");
  },
  loadShields(): typeof import("../../shields") {
    return require("../../shields") as typeof import("../../shields");
  },
};

async function verifyGateway(
  sandboxName: string,
  { expectedContainerId }: SandboxStartGatewayVerificationOptions = {},
): Promise<void> {
  await sandboxStartDependencies.loadConnect().connectSandbox(sandboxName, {
    expectedContainerId,
    probeOnly: true,
  });
}

type SandboxProcessRecoveryResult = import("./connect").SandboxStartupRecoveryResult;
type SandboxStartupRecoveryOptions = import("./connect").SandboxStartupRecoveryOptions;

function sanitizedRecoveryDetail(value: unknown): string {
  const raw = value instanceof Error && value.message ? value.message : String(value ?? "");
  return sandboxStartDependencies.loadConnect().sanitizeSandboxStartupRecoveryDetail(raw);
}

function assertStartupRecoverySucceeded(
  sandboxName: string,
  result: SandboxProcessRecoveryResult,
): void {
  const failure = result.startupFailure;
  if (!failure) return;
  throw new Error(
    `Sandbox '${sandboxName}' started, but startup recovery failed during ${failure.layer}: ${sanitizedRecoveryDetail(failure.detail)}. ` +
      `The existing sandbox was preserved. Run \`${cliName()} ${sandboxName} recover\` and retry \`${cliName()} ${sandboxName} start\`.`,
  );
}

function restoreProcessState(
  sandboxName: string,
  options: SandboxStartupRecoveryOptions = {},
): SandboxProcessRecoveryResult {
  return sandboxStartDependencies.loadConnect().restoreSandboxStartupState(sandboxName, options);
}

function restoreLockedStartupAccess(sandboxName: string, expectedContainerId?: string): void {
  sandboxStartDependencies
    .loadShields()
    .restoreLockedStateDirStartupAccess(sandboxName, expectedContainerId);
}

export interface SandboxStartupStateDeps {
  agent?: SandboxEntry["agent"];
  processRecovery?: SandboxStartupRecoveryOptions;
  restoreLockedStartupAccess?: (sandboxName: string, expectedContainerId?: string) => void;
  restoreProcessState?: (
    sandboxName: string,
    options?: SandboxStartupRecoveryOptions,
  ) => SandboxProcessRecoveryResult;
}

export function restoreStoppedSandboxStartupState(
  sandboxName: string,
  deps: SandboxStartupStateDeps = {},
): SandboxProcessRecoveryResult {
  const expectedContainerId = deps.processRecovery?.expectedContainerId;
  if ((deps.agent ?? "openclaw") === "openclaw") {
    (deps.restoreLockedStartupAccess ?? restoreLockedStartupAccess)(
      sandboxName,
      expectedContainerId,
    );
  }
  const restore = deps.restoreProcessState ?? restoreProcessState;
  return deps.processRecovery === undefined
    ? restore(sandboxName)
    : restore(sandboxName, deps.processRecovery);
}

export interface SandboxStartDeps {
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  startupRecovery?: SandboxStartupRecoveryOptions;
  restoreStartupState?: (
    sandboxName: string,
    options?: SandboxStartupRecoveryOptions,
  ) => SandboxProcessRecoveryResult;
  verifyGateway?: (
    sandboxName: string,
    options?: SandboxStartGatewayVerificationOptions,
  ) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Restart a stopped sandbox through the lifecycle facet bound to its durable
 * provider identity, then restore startup state before verifying readiness and
 * host forwards.
 */
export async function startSandbox(
  sandboxName: string,
  deps: SandboxStartDeps = {},
): Promise<SandboxLifecycleResult> {
  const log = deps.log ?? console.log;
  const sandbox = (deps.getSandbox ?? registry.getSandbox)(sandboxName);
  const resolved = resolveSandboxLifecycleProvider(
    sandboxName,
    sandbox,
    "start",
    deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  if (!resolved.ok) return resolved.result;

  const input = {
    environment: deps.environment ?? process.env,
    log,
    sandbox: resolved.sandbox,
    sandboxName,
  };
  const preflight = resolved.bundle.preflightDoctor.preflightLifecycle("start", input);
  if (preflight) return preflight;
  const result = resolved.lifecycle.start(input);
  if (result.exitCode !== 0) return result;
  const expectedContainerId = result.containerId;
  if (resolved.bundle.identity.id === "docker" && !expectedContainerId) {
    return {
      exitCode: 1,
      message:
        `  Sandbox '${sandboxName}' is running, but the Docker lifecycle provider did not ` +
        "return its immutable container identity. Refusing unpinned startup recovery; " +
        "the existing container was preserved. " +
        `run '${cliName()} ${sandboxName} recover' before retrying start.`,
    };
  }

  await resolved.lifecycle.verifyStarted(input, async (name) => {
    log("  Restoring sandbox startup state…");
    const processRecovery =
      expectedContainerId === undefined
        ? deps.startupRecovery
        : { ...deps.startupRecovery, expectedContainerId };
    let recovery: SandboxProcessRecoveryResult;
    try {
      recovery = deps.restoreStartupState
        ? processRecovery === undefined
          ? deps.restoreStartupState(name)
          : deps.restoreStartupState(name, processRecovery)
        : restoreStoppedSandboxStartupState(name, {
            agent: resolved.sandbox.agent,
            processRecovery,
          });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === sandboxStartDependencies.loadShields().SHIELDS_STARTUP_AUTO_RESTORE_REQUIRED
      ) {
        throw new Error(
          `Sandbox '${name}' started, but its expired Shields auto-restore must finish before startup recovery. ` +
            `The existing sandbox was preserved. Run \`${cliName()} ${name} shields up\`, then retry \`${cliName()} ${name} start\`.`,
        );
      }
      throw new Error(
        `Sandbox '${name}' started, but startup state restoration failed: ${sanitizedRecoveryDetail(error)}. ` +
          `The existing sandbox was preserved. Run \`${cliName()} ${name} recover\` and retry \`${cliName()} ${name} start\`.`,
      );
    }
    assertStartupRecoverySucceeded(name, recovery);
    log("  Checking gateway health and host forwards…");
    const verify = deps.verifyGateway ?? verifyGateway;
    await (expectedContainerId === undefined
      ? verify(name)
      : verify(name, { expectedContainerId }));
  });
  return { exitCode: 0 };
}
