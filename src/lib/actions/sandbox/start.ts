// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cliName } from "../../onboard/branding";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import { SHIELDS_STARTUP_AUTO_RESTORE_REQUIRED } from "../../shields";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  resolveSandboxLifecycleProvider,
  type SandboxLifecycleResult,
} from "./runtime/lifecycle-runtime";

export type SandboxStartGatewayVerificationOptions = {
  expectedContainerId?: string;
  preserveContainer?: boolean;
  requirePinnedManagedGatewayProof?: boolean;
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
  {
    expectedContainerId,
    preserveContainer = false,
    requirePinnedManagedGatewayProof = false,
  }: SandboxStartGatewayVerificationOptions = {},
): Promise<void> {
  const { connectSandbox, pinnedManagedGatewayProbeFailure } =
    sandboxStartDependencies.loadConnect();
  await connectSandbox(sandboxName, {
    expectedContainerId,
    preserveContainer,
    probeOnly: true,
  });
  if (!requirePinnedManagedGatewayProof || !expectedContainerId) return;
  const failure = pinnedManagedGatewayProbeFailure(sandboxName, expectedContainerId);
  if (!failure) return;
  throw new Error(
    `Sandbox '${sandboxName}' startup verification failed during final managed gateway health: ` +
      `${sanitizedRecoveryDetail(`${failure.layer}: ${failure.detail}`)}. ` +
      `The existing sandbox was preserved. Run \`${cliName()} ${sandboxName} recover\` and retry \`${cliName()} ${sandboxName} start\`.`,
  );
}

type SandboxProcessRecoveryResult = import("./connect").SandboxStartupRecoveryResult;
type SandboxStartupRecoveryOptions = import("./connect").SandboxStartupRecoveryOptions;
type ManagedGatewayRecoveryFailure =
  import("./connect").SandboxStartupManagedGatewayRecoveryFailure;

type SandboxProcessRecoveryFailure = {
  layer:
    | "inspection"
    | "managed gateway health"
    | "managed supervisor"
    | "OpenShell readiness"
    | "secret boundary"
    | "MCP reconciliation"
    | "managed gateway recovery"
    | "host-forward recovery";
  detail: string;
};

function sanitizedRecoveryDetail(value: unknown): string {
  const raw = value instanceof Error && value.message ? value.message : String(value ?? "");
  return sandboxStartDependencies.loadConnect().sanitizeSandboxStartupRecoveryDetail(raw);
}

function startupRecoveryFailure(
  result: SandboxProcessRecoveryResult,
  managedRecoveryFailure: ManagedGatewayRecoveryFailure | null = null,
): SandboxProcessRecoveryFailure | null {
  if ("managedSupervisorUnavailable" in result && result.managedSupervisorUnavailable) {
    return {
      layer: "managed supervisor",
      detail: sanitizedRecoveryDetail(
        "managedSupervisorFailureDetail" in result
          ? result.managedSupervisorFailureDetail
          : "the authenticated supervisor did not become available in the existing container",
      ),
    };
  }
  if ("managedGatewayProbeFailed" in result && result.managedGatewayProbeFailed) {
    return {
      layer: "managed gateway health",
      detail: sanitizedRecoveryDetail(
        "managedGatewayProbeFailureDetail" in result
          ? result.managedGatewayProbeFailureDetail
          : "the authenticated managed gateway probe did not pass",
      ),
    };
  }
  if (!result.checked) {
    return {
      layer: "inspection",
      detail: "the managed agent gateway could not be inspected after the container started",
    };
  }
  if ("secretBoundaryRefused" in result && result.secretBoundaryRefused) {
    return {
      layer: "secret boundary",
      detail: "the agent secret boundary refused recovery",
    };
  }
  if ("mcpReconciliationRefused" in result && result.mcpReconciliationRefused) {
    return {
      layer: "MCP reconciliation",
      detail: "the persisted managed MCP configuration does not match",
    };
  }
  if ("openshellReadinessFailed" in result && result.openshellReadinessFailed) {
    return {
      layer: "OpenShell readiness",
      detail: sanitizedRecoveryDetail(
        "openshellReadinessFailureDetail" in result
          ? result.openshellReadinessFailureDetail
          : "the existing sandbox did not become ready in OpenShell",
      ),
    };
  }
  if ("forwardRecoveryFailed" in result && result.forwardRecoveryFailed) {
    return {
      layer: "host-forward recovery",
      detail: "a required host forward could not be restored",
    };
  }
  if (result.wasRunning === false && result.recovered && !result.forwardRecovered) {
    return {
      layer: "host-forward recovery",
      detail: "the primary dashboard/API host forward was not proven after gateway recovery",
    };
  }
  if (result.wasRunning === false && !result.recovered) {
    return {
      layer: "managed gateway recovery",
      detail: sanitizedRecoveryDetail(
        managedRecoveryFailure
          ? `${managedRecoveryFailure.layer}: ${managedRecoveryFailure.detail}`
          : "the managed agent gateway could not be restarted",
      ),
    };
  }
  if (result.wasRunning === null && (!("runtime" in result) || result.runtime !== "terminal")) {
    return {
      layer: "inspection",
      detail: "the managed agent gateway recovery result was inconclusive",
    };
  }
  return null;
}

function assertStartupRecoverySucceeded(
  sandboxName: string,
  result: SandboxProcessRecoveryResult,
  managedRecoveryFailure: ManagedGatewayRecoveryFailure | null = null,
): void {
  const failure = startupRecoveryFailure(result, managedRecoveryFailure);
  if (!failure) return;
  throw new Error(
    `Sandbox '${sandboxName}' started, but startup recovery failed during ${failure.layer}: ${failure.detail}. ` +
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

function requiresManagedStartupRecovery(agent: SandboxEntry["agent"]): boolean {
  return !agent || agent === "openclaw" || agent === "hermes";
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
  const expectedContainerId = result.runtimeHandle;
  const pinnedManagedStartupRecovery =
    requiresManagedStartupRecovery(resolved.sandbox.agent) && Boolean(expectedContainerId);

  await resolved.lifecycle.verifyStarted(input, async (name) => {
    log("  Restoring sandbox startup state…");
    const recoveryFailureState: { current: ManagedGatewayRecoveryFailure | null } = {
      current: null,
    };
    const processRecovery: SandboxStartupRecoveryOptions | undefined = pinnedManagedStartupRecovery
      ? {
          ...deps.startupRecovery,
          expectedContainerId,
          onRecoveryFailure: (failure) => {
            recoveryFailureState.current = failure;
            deps.startupRecovery?.onRecoveryFailure?.(failure);
          },
        }
      : undefined;
    let recovery: SandboxProcessRecoveryResult;
    try {
      recovery = deps.restoreStartupState
        ? processRecovery
          ? deps.restoreStartupState(name, processRecovery)
          : deps.restoreStartupState(name)
        : restoreStoppedSandboxStartupState(name, {
            agent: resolved.sandbox.agent,
            processRecovery,
          });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === SHIELDS_STARTUP_AUTO_RESTORE_REQUIRED
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
    if (pinnedManagedStartupRecovery) {
      assertStartupRecoverySucceeded(name, recovery, recoveryFailureState.current);
    }
    log("  Checking gateway health and host forwards…");
    const gatewayVerification = deps.verifyGateway ?? verifyGateway;
    await (pinnedManagedStartupRecovery
      ? gatewayVerification(name, {
          expectedContainerId,
          preserveContainer: true,
          requirePinnedManagedGatewayProof: true,
        })
      : gatewayVerification(name));
  });
  return { exitCode: 0 };
}
