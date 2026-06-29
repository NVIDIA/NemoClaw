// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { findDashboardForwardOwner } from "./dashboard-port";
import type { PortProbeResult } from "./preflight";
import { assertDashboardPortNotReserved } from "./preflight-ports";

export type AuthoritativeRebuildTarget = {
  sandboxName: string;
  provider: string;
  model: string;
  targetGatewayName: string;
  controlUiPort: number | null;
};

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
    if (!deps.inferenceRouteReady(target.provider, target.model)) {
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
