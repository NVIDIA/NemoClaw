// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxObserver } from "../../adapters/openshell/sandbox-observer";
import { cliName } from "../../onboard/branding";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  probeSandboxInferenceInvocation,
  READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  type SandboxInferenceInvocationResult,
} from "./inference-invocation-probe";
import { withSandboxLifecycleLock } from "./gateway-state";
import {
  resolveSandboxLifecycleProvider,
  type SandboxLifecycleResult,
} from "./runtime/lifecycle-runtime";

function verifyGateway(sandboxName: string): Promise<void> {
  const { connectSandbox } = require("./connect") as typeof import("./connect");
  return connectSandbox(sandboxName, {
    probeOnly: true,
    requireLaunchReadinessPublication: false,
  });
}

type SandboxStartupRecoveryResult = import("./connect").SandboxStartupRecoveryResult;

function restoreProcessState(sandboxName: string): SandboxStartupRecoveryResult {
  const { restoreSandboxStartupState } = require("./connect") as typeof import("./connect");
  return restoreSandboxStartupState(sandboxName);
}

function restoreLockedStartupAccess(sandboxName: string): void {
  const { restoreLockedStateDirStartupAccess } =
    require("../../shields") as typeof import("../../shields");
  restoreLockedStateDirStartupAccess(sandboxName);
}

/** Wait for a just-started sandbox while tolerating its bounded transient Error phase. */
async function waitForSandboxReady(
  sandboxName: string,
  observer?: OpenShellSandboxObserver,
  allowDockerRuntimeInspection = true,
): Promise<void> {
  const { waitForSandboxReadyOrExit, SANDBOX_REPAIR_READY_TIMEOUT_SEC } =
    require("./connect") as typeof import("./connect");
  await waitForSandboxReadyOrExit(sandboxName, {
    allowInitialErrorAfterStart: true,
    allowDockerRuntimeInspection,
    ...(observer ? { observer } : {}),
    defaultTimeoutSec: SANDBOX_REPAIR_READY_TIMEOUT_SEC,
    retryCommand: "start",
  });
}

export interface SandboxStartupStateDeps {
  agent?: SandboxEntry["agent"];
  restoreLockedStartupAccess?: (sandboxName: string) => void;
  waitForSandboxReady?: (sandboxName: string) => void | Promise<void>;
  restoreProcessState?: (sandboxName: string) => SandboxStartupRecoveryResult;
}

export async function restoreStoppedSandboxStartupState(
  sandboxName: string,
  deps: SandboxStartupStateDeps = {},
): Promise<SandboxStartupRecoveryResult> {
  if ((deps.agent ?? "openclaw") === "openclaw") {
    (deps.restoreLockedStartupAccess ?? restoreLockedStartupAccess)(sandboxName);
  }
  await (deps.waitForSandboxReady ?? waitForSandboxReady)(sandboxName);
  return (deps.restoreProcessState ?? restoreProcessState)(sandboxName);
}

export interface SandboxStartDeps {
  allowDockerRuntimeInspection?: boolean;
  observer?: OpenShellSandboxObserver;
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  restoreLockedStartupAccess?: (sandboxName: string) => void;
  restoreProcessState?: (sandboxName: string) => SandboxStartupRecoveryResult;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  restoreStartupState?: (
    sandboxName: string,
  ) => SandboxStartupRecoveryResult | Promise<SandboxStartupRecoveryResult>;
  waitForManagedGatewaySupervisor?: (sandboxName: string) => boolean;
  verifyGateway?: (sandboxName: string) => Promise<void>;
  probeInferenceInvocation?: typeof probeSandboxInferenceInvocation;
  withLifecycleLock?: typeof withSandboxLifecycleLock;
  log?: (message: string) => void;
}

function isMissingManagedSupervisorStartupFailure(
  check: SandboxStartupRecoveryResult,
  failure: string,
): boolean {
  return (
    failure === "supervisor not running: SUPERVISOR_NOT_RUNNING" &&
    check.recoveryFailureLayer === "supervisor not running" &&
    check.recoveryFailureDetail === "SUPERVISOR_NOT_RUNNING"
  );
}

function startupRecoveryFailure(check: SandboxStartupRecoveryResult): string | null {
  if (!check.checked) return "managed agent gateway inspection did not complete";
  if ("runtime" in check && check.runtime === "terminal") return null;
  if ("secretBoundaryRefused" in check && check.secretBoundaryRefused) {
    return `secret-boundary refusal: ${String(check.secretBoundaryReason)}`;
  }
  if ("mcpReconciliationRefused" in check && check.mcpReconciliationRefused) {
    return `MCP reconciliation refusal: ${String(check.mcpReconciliationReason)}`;
  }
  if ("forwardRecoveryFailed" in check && check.forwardRecoveryFailed) {
    return String(check.forwardRecoveryFailureDetail);
  }
  if (check.wasRunning || check.recovered) return null;
  const layer = check.recoveryFailureLayer ?? "managed agent gateway recovery";
  return check.recoveryFailureDetail
    ? `${layer}: ${check.recoveryFailureDetail}`
    : `${layer}: the agent gateway did not recover`;
}

function startupRecoveryError(sandboxName: string, detail: unknown): Error {
  const { sanitizeSandboxStartupRecoveryDetail } =
    require("./connect") as typeof import("./connect");
  const rawDetail = detail instanceof Error && detail.message ? detail.message : String(detail);
  const safeDetail = sanitizeSandboxStartupRecoveryDetail(rawDetail);
  return new Error(
    `Sandbox '${sandboxName}' started, but startup recovery failed: ${safeDetail}. ` +
      `Inspect the current sandbox state before retrying. Run \`${cliName()} ${sandboxName} recover\`, then retry \`${cliName()} ${sandboxName} start\`.`,
  );
}

/**
 * A started gateway that answers the /v1/models probe can still reject an
 * inference request, so start sends one inference request with the recorded
 * provider and model before it reports success. A registry entry with no
 * provider or no model has nothing to request, so start skips the request
 * instead of failing.
 */
function checkStartedSandboxInference(
  sandboxName: string,
  sandbox: SandboxEntry,
  deps: SandboxStartDeps,
  log: (message: string) => void,
): SandboxInferenceInvocationResult | null {
  const model = (sandbox.model ?? "").trim();
  const provider = (sandbox.provider ?? "").trim();
  if (!model || !provider) return null;
  log("  Checking that the sandbox serves an agent request…");
  return (deps.probeInferenceInvocation ?? probeSandboxInferenceInvocation)(
    {
      sandboxName,
      provider,
      model,
      preferredInferenceApi: sandbox.preferredInferenceApi ?? null,
    },
    {},
    READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  );
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
  return (deps.withLifecycleLock ?? withSandboxLifecycleLock)(sandboxName, () =>
    startSandboxWithinLifecycleFence(sandboxName, deps),
  );
}

async function startSandboxWithinLifecycleFence(
  sandboxName: string,
  deps: SandboxStartDeps,
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
  if ("hermesPortableVerified" in result && result.hermesPortableVerified === true) {
    return { exitCode: 0 };
  }

  const readiness: { inference: SandboxInferenceInvocationResult | null } = { inference: null };
  await resolved.lifecycle.verifyStarted(input, async (name) => {
    log("  Restoring sandbox startup state…");
    const restoreStartupState =
      deps.restoreStartupState ??
      ((sandboxNameToRestore: string) =>
        restoreStoppedSandboxStartupState(sandboxNameToRestore, {
          agent: resolved.sandbox.agent,
          restoreLockedStartupAccess: deps.restoreLockedStartupAccess,
          restoreProcessState: deps.restoreProcessState,
          waitForSandboxReady: (readyName) =>
            waitForSandboxReady(readyName, deps.observer, deps.allowDockerRuntimeInspection),
        }));
    let recovery: SandboxStartupRecoveryResult;
    try {
      recovery = await restoreStartupState(name);
    } catch (error) {
      throw startupRecoveryError(name, error);
    }
    let failure = startupRecoveryFailure(recovery);
    if (failure && isMissingManagedSupervisorStartupFailure(recovery, failure)) {
      let supervisorReady = false;
      try {
        const waitForSupervisor =
          deps.waitForManagedGatewaySupervisor ??
          (require("./connect") as typeof import("./connect")).waitForManagedGatewaySupervisor;
        supervisorReady = waitForSupervisor(name);
      } catch {
        // Preserve the authoritative first recovery failure when the bounded
        // read-only settling probe itself cannot complete.
      }
      if (supervisorReady) {
        try {
          recovery = await restoreStartupState(name);
        } catch (error) {
          throw startupRecoveryError(name, error);
        }
        failure = startupRecoveryFailure(recovery);
      }
    }
    if (failure) throw startupRecoveryError(name, failure);
    log("  Checking gateway health and host forwards…");
    await (deps.verifyGateway ?? verifyGateway)(name);
    readiness.inference = checkStartedSandboxInference(name, resolved.sandbox, deps, log);
  });
  if (readiness.inference && !readiness.inference.ok) {
    log(`  The sandbox started but inference is not usable: ${readiness.inference.detail}.`);
    log(`  Run the sandbox doctor command for '${sandboxName}' to identify the failing hop.`);
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}
