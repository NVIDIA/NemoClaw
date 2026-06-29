// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as agentRuntime from "../../agent/runtime";
import * as registry from "../../state/registry";
import type { SandboxCommandResult, SandboxForwardHealth } from "./process-recovery";

type RecoveryConfigReader = (
  sandboxName: string,
) => agentRuntime.HermesDashboardRecoveryConfig | null;

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function getHermesDashboardRecoveryConfig(
  sandboxName: string,
  getSandbox: typeof registry.getSandbox = registry.getSandbox,
): agentRuntime.HermesDashboardRecoveryConfig | null {
  const sandbox = getSandbox(sandboxName);
  if (sandbox?.agent !== "hermes" || sandbox.hermesDashboardEnabled !== true) return null;
  if (!isValidPort(sandbox.hermesDashboardPort)) return null;
  if (!isValidPort(sandbox.hermesDashboardInternalPort)) return null;
  return {
    publicPort: sandbox.hermesDashboardPort,
    internalPort: sandbox.hermesDashboardInternalPort,
    tuiEnabled: sandbox.hermesDashboardTui === true,
  };
}

export function ensureHermesDashboardPortForwardIfEnabled(
  sandboxName: string,
  deps: {
    getRecoveryConfig?: RecoveryConfigReader;
    isPortForwardHealthy(sandboxName: string, port: number): SandboxForwardHealth;
    ensurePortForward(sandboxName: string, port: number): boolean;
  },
): boolean | null {
  const dashboard = (deps.getRecoveryConfig ?? getHermesDashboardRecoveryConfig)(sandboxName);
  if (dashboard === null) return null;
  const forwardHealth = deps.isPortForwardHealthy(sandboxName, dashboard.publicPort);
  if (forwardHealth === true || forwardHealth === "occupied") return false;
  return deps.ensurePortForward(sandboxName, dashboard.publicPort);
}

export function recoverHermesDashboardProcessIfEnabled(
  sandboxName: string,
  deps: {
    getRecoveryConfig?: RecoveryConfigReader;
    executeCommand(sandboxName: string, command: string): SandboxCommandResult | null;
    buildRecoveryScript?: typeof agentRuntime.buildHermesDashboardProcessRecoveryScript;
  },
): boolean | null {
  const dashboard = (deps.getRecoveryConfig ?? getHermesDashboardRecoveryConfig)(sandboxName);
  if (dashboard === null) return null;
  const buildRecoveryScript =
    deps.buildRecoveryScript ?? agentRuntime.buildHermesDashboardProcessRecoveryScript;
  const result = deps.executeCommand(sandboxName, buildRecoveryScript(dashboard));
  return !!(
    result &&
    result.status === 0 &&
    (result.stdout.includes("DASHBOARD_PID=") ||
      result.stdout.includes("DASHBOARD_ALREADY_RUNNING"))
  );
}
