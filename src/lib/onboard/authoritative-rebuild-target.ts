// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ResourceProfile } from "../resources-cmd";
import { findDashboardForwardOwner } from "./dashboard-port";
import { resolveGatewayName } from "./gateway-binding";
import type { PortProbeResult } from "./preflight";
import { assertDashboardPortNotReserved } from "./preflight-ports";
import type { SandboxGpuFlag } from "./sandbox-gpu-mode";

export type AuthoritativeOnboardGatewayBinding = { name: string; port: number };

/** Internal-only options passed from the destructive rebuild lifecycle. */
export type AuthoritativeGatewayOptions = {
  authoritativeResumeConfig?: boolean;
  targetGatewayName?: string | null;
  targetGatewayPort?: number | null;
  onboardLockAlreadyHeld?: boolean;
};

/** Complete authoritative configuration required before the old sandbox is removed. */
export type AuthoritativeRebuildPreflightOptions = AuthoritativeGatewayOptions & {
  authoritativeResumeConfig: true;
  model: string;
  provider: string;
  sandboxName: string;
  targetGatewayName: string;
  targetGatewayPort: number;
  sandboxGpu?: SandboxGpuFlag;
  sandboxGpuDevice?: string | null;
  gpu?: boolean;
  noGpu?: boolean;
  optedOutGpuPassthrough?: boolean;
  controlUiPort?: number | null;
  authoritativeHermesDashboardConfig?: { port: number } | null;
  authoritativeResourceProfile: ResourceProfile | null;
};

/**
 * Accept a rebuild gateway only as a complete, canonical name/port pair.
 * Partial or public onboarding options must never redirect gateway-scoped work.
 */
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
  sandboxName: string;
  provider: string;
  model: string;
  targetGatewayName: string;
  controlUiPort: number | null;
  authoritativeHermesDashboardConfig?: { port: number } | null;
  authoritativeResourceProfile: ResourceProfile | null;
};

export type AuthoritativeRebuildTargetDeps = {
  runFatalRuntimePreflight(): unknown;
  ensureOpenshell(): unknown | Promise<unknown>;
  preflightResourceProfile(profile: ResourceProfile | null): void;
  prepareGatewayTransport(): unknown | Promise<unknown>;
  inferenceRouteReady(provider: string, model: string): boolean;
  captureForwardList(): string | null;
  checkPort(port: number): Promise<PortProbeResult>;
  env?: NodeJS.ProcessEnv;
};

/** Run non-mutating target checks under the exact rebuild gateway scope. */
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
    await deps.ensureOpenshell();
    deps.preflightResourceProfile(target.authoritativeResourceProfile);
    await deps.prepareGatewayTransport();
    if (!deps.inferenceRouteReady(target.provider, target.model)) {
      fail(
        `OpenShell inference route does not match provider '${target.provider}' and model '${target.model}'.`,
      );
    }

    const checkForwardPort = async (port: number, label: string): Promise<void> => {
      assertDashboardPortNotReserved(port, fail);
      const owner = findDashboardForwardOwner(deps.captureForwardList(), String(port));
      if (owner && owner !== target.sandboxName) {
        fail(`${label} port ${port} belongs to sandbox '${owner}'.`);
      }
      if (owner) return;

      const portCheck = await deps.checkPort(port);
      if (!portCheck.ok) {
        const blocker = portCheck.process
          ? `${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`
          : portCheck.reason || "an unknown listener";
        fail(`${label} port ${port} is occupied by ${blocker}.`);
      }
    };

    // dcode has no host dashboard. In particular, its gateway listener on
    // 8080 is expected and must never be mistaken for a dashboard conflict.
    if (target.controlUiPort !== null) {
      await checkForwardPort(target.controlUiPort, "Dashboard");
    }
    if (target.authoritativeHermesDashboardConfig) {
      await checkForwardPort(target.authoritativeHermesDashboardConfig.port, "Hermes dashboard");
    }
  } finally {
    if (previousGateway === undefined) delete env.OPENSHELL_GATEWAY;
    else env.OPENSHELL_GATEWAY = previousGateway;
  }
}
