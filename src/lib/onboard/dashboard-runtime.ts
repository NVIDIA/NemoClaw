// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTerminalAgent } from "../agent/runtime-manifest";
import { resolveRecordedDashboardUrlForPort } from "../dashboard/url";
import { isRemoteDashboardBindRequested } from "./dockerfile-remote-dashboard-bind-contract";

export type DashboardForwardBind = "127.0.0.1" | "0.0.0.0";

/**
 * Choose the dashboard URL that a rebuild gives an agent's replacement.
 * OpenClaw replays the recorded external origin (#13177); every other agent
 * keeps its loopback dashboard URL. `fallbackUrl` applies only when the
 * registry never recorded an origin.
 */
export function rebuildDashboardChatUiUrl(input: {
  readonly agentName: string | null | undefined;
  readonly recordedExternalUrl: string | null | undefined;
  readonly fallbackUrl?: string | null;
  readonly port: number;
}): string {
  if ((input.agentName ?? "openclaw") !== "openclaw") {
    return `http://127.0.0.1:${String(input.port)}`;
  }
  return resolveRecordedDashboardUrlForPort({
    recordedExternalUrl: input.recordedExternalUrl,
    fallbackUrl: input.fallbackUrl,
    port: input.port,
  });
}

/** Preserve the persisted dashboard bind while honoring a current remote or WSL request. */
export function resolveDashboardForwardBind(
  sandbox: { dashboardRemoteBindPrepared?: boolean } | null | undefined,
  options: { requestedBind?: string; wsl?: boolean } = {},
): DashboardForwardBind {
  return sandbox?.dashboardRemoteBindPrepared === true ||
    isRemoteDashboardBindRequested(options.requestedBind) ||
    options.wsl === true
    ? "0.0.0.0"
    : "127.0.0.1";
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
