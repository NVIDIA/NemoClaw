// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { findDashboardForwardOwner } from "./dashboard-port";
import { resolveGatewayName } from "./gateway-binding";
import type { PortProbeResult } from "./preflight";
import { assertDashboardPortNotReserved } from "./preflight-ports";
import { validateRebuildProviderReconfigureHandoff } from "./rebuild-route-handoff";
import type { OnboardOptions } from "./types";

export type AuthoritativeOnboardGatewayBinding = { name: string; port: number };

export type AuthoritativeGatewayOptions = Pick<
  OnboardOptions,
  "authoritativeResumeConfig" | "targetGatewayName" | "targetGatewayPort" | "onboardLockAlreadyHeld"
>;

export type AuthoritativeRebuildPreflightOptions = Pick<
  OnboardOptions,
  "sandboxGpu" | "sandboxGpuDevice" | "noGpu" | "controlUiPort"
> & {
  authoritativeResumeConfig: true;
  /** Internal prepared-backup recovery defers route repair to authoritative onboard. */
  deferInferenceRouteUntilOnboard?: true;
  model: string;
  provider: string;
  sandboxName: string;
  targetGatewayName: string;
  targetGatewayPort: number;
};

export function resolveAuthoritativeOnboardGatewayBinding(
  opts: AuthoritativeGatewayOptions,
): AuthoritativeOnboardGatewayBinding | null {
  const hasName =
    typeof opts.targetGatewayName === "string" && opts.targetGatewayName.trim() !== "";
  const hasPort = opts.targetGatewayPort !== undefined && opts.targetGatewayPort !== null;
  if (
    opts.onboardLockAlreadyHeld === true &&
    (!opts.authoritativeResumeConfig || !hasName || !hasPort)
  ) {
    throw new Error(
      "The internal onboard lock handoff requires an authoritative rebuild resume with a target gateway.",
    );
  }
  if (!hasName && !hasPort) return null;
  if (!opts.authoritativeResumeConfig || !hasName || !hasPort) {
    throw new Error(
      "An internal target gateway name and port may be supplied only together for an authoritative rebuild resume.",
    );
  }
  const name = opts.targetGatewayName?.trim() ?? "";
  const port = Number(opts.targetGatewayPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid authoritative rebuild gateway port '${String(opts.targetGatewayPort)}'.`,
    );
  }
  if (resolveGatewayName(port) !== name) {
    throw new Error(`Authoritative rebuild gateway '${name}' does not match port ${port}.`);
  }
  return { name, port };
}

export type AuthoritativeRebuildTarget = {
  deferInferenceRouteUntilOnboard?: true;
  sandboxName: string;
  provider: string;
  model: string;
  targetGatewayName: string;
  controlUiPort: number | null;
};

/** Validate the one-shot authority to reconstruct a provider during a locked rebuild resume. */
function validateRebuildHandoff(
  opts: OnboardOptions,
  target: {
    sandboxName: string | null;
    provider: string | null;
    model: string | null;
    credentialEnv: string | null;
    endpointUrl: string | null;
  },
): boolean {
  const handoff = opts.rebuildProviderReconfigure;
  if (!handoff) return false;
  if (
    opts.authoritativeResumeConfig !== true ||
    opts.resume !== true ||
    opts.recreateSandbox !== true ||
    opts.onboardLockAlreadyHeld !== true ||
    !target.sandboxName ||
    !target.provider ||
    !target.model ||
    !target.credentialEnv
  ) {
    throw new Error(
      "Prepared provider reconfiguration requires an authoritative locked rebuild resume.",
    );
  }
  return validateRebuildProviderReconfigureHandoff(handoff, {
    sandboxName: target.sandboxName,
    provider: target.provider,
    model: target.model,
    credentialEnv: target.credentialEnv,
    endpointUrl: target.endpointUrl,
  });
}

/** Derive the provider-phase authority from one validated rebuild handoff. */
export function rebuildProviderFlowOptions(
  opts: OnboardOptions,
  target: Parameters<typeof validateRebuildHandoff>[1],
): { authoritativeResumeConfig: boolean; forceInferenceSetup: boolean } {
  return {
    authoritativeResumeConfig: opts.authoritativeResumeConfig === true,
    forceInferenceSetup: validateRebuildHandoff(opts, target),
  };
}

export type AuthoritativeRebuildTargetDeps = {
  runFatalRuntimePreflight(): unknown;
  ensureOpenshell(): unknown;
  inferenceRouteReady(provider: string, model: string): boolean;
  captureForwardList(): string | null;
  checkPort(port: number): Promise<PortProbeResult>;
  env?: NodeJS.ProcessEnv;
};

/** Run non-mutating target checks under an exact process-local gateway scope. */
export async function preflightAuthoritativeRebuildTarget(
  target: AuthoritativeRebuildTarget,
  deps: AuthoritativeRebuildTargetDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  const previousGateway = env.OPENSHELL_GATEWAY;
  const fail = (message: string): never => {
    throw new Error(message);
  };
  env.OPENSHELL_GATEWAY = target.targetGatewayName;
  try {
    deps.runFatalRuntimePreflight();
    deps.ensureOpenshell();
    // Prepared-backup recovery can run after the installer has replaced a
    // legacy gateway. That fresh gateway has no inference route to validate
    // yet; authoritative onboarding configures and verifies the pinned route
    // before recreating the sandbox. Normal rebuilds must still match here.
    if (
      target.deferInferenceRouteUntilOnboard !== true &&
      !deps.inferenceRouteReady(target.provider, target.model)
    ) {
      fail(
        `OpenShell inference route does not match provider '${target.provider}' and model '${target.model}'.`,
      );
    }
    if (target.controlUiPort === null) return;
    assertDashboardPortNotReserved(target.controlUiPort, fail);
    const owner = findDashboardForwardOwner(
      deps.captureForwardList(),
      String(target.controlUiPort),
    );
    if (owner && owner !== target.sandboxName) {
      fail(`Dashboard port ${target.controlUiPort} belongs to sandbox '${owner}'.`);
    }
    if (owner) return;
    const portCheck = await deps.checkPort(target.controlUiPort);
    if (!portCheck.ok) {
      const blocker = portCheck.process
        ? `${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`
        : portCheck.reason;
      fail(`Dashboard port ${target.controlUiPort} is occupied by ${blocker}.`);
    }
  } finally {
    if (previousGateway === undefined) delete env.OPENSHELL_GATEWAY;
    else env.OPENSHELL_GATEWAY = previousGateway;
  }
}
