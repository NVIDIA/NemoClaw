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

function verifyGateway(sandboxName: string): Promise<void> {
  const { connectSandbox } = require("./connect") as {
    connectSandbox: (name: string, options?: { probeOnly?: boolean }) => Promise<void>;
  };
  return connectSandbox(sandboxName, { probeOnly: true });
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

export interface SandboxStartupStateDeps {
  agent?: SandboxEntry["agent"];
  restoreLockedStartupAccess?: (sandboxName: string) => void;
  restoreProcessState?: (sandboxName: string) => SandboxStartupRecoveryResult;
}

export function restoreStoppedSandboxStartupState(
  sandboxName: string,
  deps: SandboxStartupStateDeps = {},
): SandboxStartupRecoveryResult {
  if ((deps.agent ?? "openclaw") === "openclaw") {
    (deps.restoreLockedStartupAccess ?? restoreLockedStartupAccess)(sandboxName);
  }
  return (deps.restoreProcessState ?? restoreProcessState)(sandboxName);
}

export interface SandboxStartDeps {
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  restoreStartupState?: (sandboxName: string) => SandboxStartupRecoveryResult;
  waitForManagedGatewaySupervisor?: (sandboxName: string) => boolean;
  verifyGateway?: (sandboxName: string) => Promise<void>;
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

function preservedSandboxRecoveryError(sandboxName: string, detail: unknown): Error {
  const { sanitizeSandboxStartupRecoveryDetail } =
    require("./connect") as typeof import("./connect");
  const rawDetail = detail instanceof Error && detail.message ? detail.message : String(detail);
  const safeDetail = sanitizeSandboxStartupRecoveryDetail(rawDetail);
  return new Error(
    `Sandbox '${sandboxName}' started, but startup recovery failed: ${safeDetail}. ` +
      `The existing sandbox was preserved. Run \`${cliName()} ${sandboxName} recover\`, then retry \`${cliName()} ${sandboxName} start\`.`,
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

  await resolved.lifecycle.verifyStarted(input, async (name) => {
    log("  Restoring sandbox startup state…");
    const restoreStartupState =
      deps.restoreStartupState ??
      ((sandboxNameToRestore: string) =>
        restoreStoppedSandboxStartupState(sandboxNameToRestore, {
          agent: resolved.sandbox.agent,
        }));
    let recovery: SandboxStartupRecoveryResult;
    try {
      recovery = restoreStartupState(name);
    } catch (error) {
      throw preservedSandboxRecoveryError(name, error);
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
          recovery = restoreStartupState(name);
        } catch (error) {
          throw preservedSandboxRecoveryError(name, error);
        }
        failure = startupRecoveryFailure(recovery);
      }
    }
    if (failure) throw preservedSandboxRecoveryError(name, failure);
    log("  Checking gateway health and host forwards…");
    await (deps.verifyGateway ?? verifyGateway)(name);
  });
  return { exitCode: 0 };
}
