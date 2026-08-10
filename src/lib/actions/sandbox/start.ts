// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import type { SandboxStartupRecoveryResult } from "./connect";
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

function restoreProcessState(
  sandboxName: string,
  requireManagedRecovery: boolean,
): SandboxStartupRecoveryResult {
  const { restoreSandboxStartupState } = require("./connect") as typeof import("./connect");
  return restoreSandboxStartupState(sandboxName, { requireManagedRecovery });
}

function restoreLockedStartupAccess(sandboxName: string): void {
  const { restoreLockedStateDirStartupAccess } =
    require("../../shields") as typeof import("../../shields");
  restoreLockedStateDirStartupAccess(sandboxName);
}

export interface SandboxStartupStateDeps {
  agent?: SandboxEntry["agent"];
  restoreLockedStartupAccess?: (sandboxName: string) => void;
  restoreProcessState?: typeof restoreProcessState;
}

export function restoreStoppedSandboxStartupState(
  sandboxName: string,
  deps: SandboxStartupStateDeps = {},
): SandboxStartupRecoveryResult {
  const agent = deps.agent ?? "openclaw";
  if (agent === "openclaw") {
    (deps.restoreLockedStartupAccess ?? restoreLockedStartupAccess)(sandboxName);
  }
  return (deps.restoreProcessState ?? restoreProcessState)(
    sandboxName,
    agent === "openclaw" || agent === "hermes",
  );
}

function startupRecoveryFailure(
  sandboxName: string,
  detail: string,
  nextStep = `Run '${CLI_NAME} ${sandboxName} recover' for classified repair guidance.`,
): Error {
  return new Error(`Could not restore sandbox '${sandboxName}' after start: ${detail} ${nextStep}`);
}

export function assertSandboxStartupRecovery(
  sandboxName: string,
  recovery: SandboxStartupRecoveryResult,
): void {
  if ("runtime" in recovery && recovery.runtime === "terminal") return;
  if (!recovery.checked) {
    throw startupRecoveryFailure(
      sandboxName,
      "the managed gateway could not be inspected through the trusted container boundary.",
    );
  }
  if ("secretBoundaryRefused" in recovery && recovery.secretBoundaryRefused) {
    throw startupRecoveryFailure(
      sandboxName,
      "the Hermes secret-boundary check refused the gateway state; Shields were left unchanged.",
    );
  }
  if ("mcpReconciliationRefused" in recovery && recovery.mcpReconciliationRefused) {
    throw startupRecoveryFailure(
      sandboxName,
      "the Hermes MCP configuration does not match its persisted managed intent; Shields were left unchanged.",
    );
  }
  if ("forwardRecoveryFailed" in recovery && recovery.forwardRecoveryFailed) {
    throw startupRecoveryFailure(
      sandboxName,
      "one or more required host forwards could not be restored.",
    );
  }
  if (!recovery.wasRunning && !recovery.recovered) {
    throw startupRecoveryFailure(
      sandboxName,
      "authenticated managed gateway recovery did not complete.",
      `Inspect '${CLI_NAME} ${sandboxName} logs', then run '${CLI_NAME} ${sandboxName} recover'.`,
    );
  }
}

export interface SandboxStartDeps {
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  restoreStartupState?: (sandboxName: string) => SandboxStartupRecoveryResult;
  verifyGateway?: (sandboxName: string) => Promise<void>;
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

  await resolved.lifecycle.verifyStarted(input, async (name) => {
    log("  Restoring sandbox startup state…");
    const restoreStartupState =
      deps.restoreStartupState ??
      ((sandboxNameToRestore: string) =>
        restoreStoppedSandboxStartupState(sandboxNameToRestore, {
          agent: resolved.sandbox.agent,
        }));
    const recovery = restoreStartupState(name);
    assertSandboxStartupRecovery(name, recovery);
    log("  Checking gateway health and host forwards…");
    await (deps.verifyGateway ?? verifyGateway)(name);
  });
  return { exitCode: 0 };
}
