// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTerminalAgent } from "../agent/runtime-manifest";
import {
  createForwardServiceTarget,
  isForwardServiceListenerOwner,
} from "../adapters/openshell/forward-service";
import { teardownSandboxDashboardForward } from "../actions/sandbox/forward-recovery";
import { isLocalForwardReachable } from "../actions/sandbox/forward-health";

export function ownsForwardPort(
  executable: string,
  sandboxName: string,
  gatewayName: string,
  port: number,
): boolean {
  return (["127.0.0.1", "0.0.0.0"] as const).some((localHost) =>
    isForwardServiceListenerOwner(
      createForwardServiceTarget(
        { executable, sandboxName, gatewayName, workspace: "default", localHost },
        port,
      ),
    ),
  );
}

export function assertSandboxForwardsReleased(
  sandboxName: string,
  reservedPorts: readonly (number | undefined)[],
): void {
  if (
    !teardownSandboxDashboardForward(sandboxName, {
      isLocalForwardReachable: (port) =>
        !reservedPorts.includes(port) && isLocalForwardReachable(port),
    })
  ) {
    throw new Error(`Cannot recreate sandbox '${sandboxName}': its host forwards did not exit.`);
  }
}

export type DashboardRuntimeAgent = {
  forwardPort?: number | null;
  forward_ports?: number[] | null;
  runtime?: { kind?: unknown } | null;
} | null;

export function isValidForwardPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function getAgentDeclaredForwardPorts(agent: DashboardRuntimeAgent): number[] {
  if (!agent) return [];
  return [
    agent.forwardPort,
    ...(Array.isArray(agent.forward_ports) ? agent.forward_ports : []),
  ].filter((port, index, ports): port is number => {
    return isValidForwardPort(port) && ports.indexOf(port) === index;
  });
}

export function getAgentPrimaryForwardPort(agent: DashboardRuntimeAgent, fallback: number): number {
  return isValidForwardPort(agent?.forwardPort) ? agent.forwardPort : fallback;
}

export function shouldManageDashboardForAgent(agent: DashboardRuntimeAgent): boolean {
  if (!agent || !isTerminalAgent(agent)) return true;
  return getAgentDeclaredForwardPorts(agent).length > 0;
}

export function canReuseDashboardForwardForAgent(
  agent: { name: string } | null | undefined,
): boolean {
  return agent == null || agent.name === "openclaw" || agent.name === "hermes";
}
