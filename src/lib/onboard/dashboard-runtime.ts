// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTerminalAgent } from "../agent/runtime-manifest";

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
