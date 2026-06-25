// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../core/ports";
import {
  type DashboardRuntimeAgent,
  getAgentDeclaredForwardPorts,
  getAgentPrimaryForwardPort,
  shouldManageDashboardForAgent,
} from "./dashboard-runtime";

export type EnsureDashboardForward = (
  sandboxName: string,
  chatUiUrl?: string,
  options?: {
    preserveSandboxPorts?: Array<number | string>;
    allowPortReallocation?: boolean;
  },
) => number;

export type AgentDashboardForwardConfig = NonNullable<DashboardRuntimeAgent>;

function isValidPort(port: number | null | undefined): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function ensureAgentDashboardForward(options: {
  sandboxName: string;
  agent: AgentDashboardForwardConfig;
  ensureDashboardForward: EnsureDashboardForward;
  controlUiPort?: number;
  preserveForwardPorts?: readonly (number | null | undefined)[];
  warn?: (message: string) => void;
}): number {
  const {
    sandboxName,
    agent,
    ensureDashboardForward,
    controlUiPort = DASHBOARD_PORT,
    preserveForwardPorts = [],
    warn = (message: string) => console.warn(message),
  } = options;
  if (!shouldManageDashboardForAgent(agent)) {
    return 0;
  }

  const declaredPorts = getAgentDeclaredForwardPorts(agent);
  const agentDashboardPort = getAgentPrimaryForwardPort(agent, controlUiPort);
  const preservePorts = [
    ...new Set([agentDashboardPort, ...declaredPorts, ...preserveForwardPorts]),
  ].filter(isValidPort);
  const actualAgentDashboardPort = ensureDashboardForward(
    sandboxName,
    `http://127.0.0.1:${agentDashboardPort}`,
    { preserveSandboxPorts: preservePorts },
  );
  process.env.CHAT_UI_URL = `http://127.0.0.1:${actualAgentDashboardPort}`;

  const portsToPreserve = [...new Set([...preservePorts, actualAgentDashboardPort])];
  for (const port of preservePorts) {
    if (port === agentDashboardPort) continue;
    try {
      ensureDashboardForward(sandboxName, `http://127.0.0.1:${port}`, {
        preserveSandboxPorts: portsToPreserve,
        allowPortReallocation: false,
      });
    } catch (err) {
      warn(
        `  ! Could not start optional agent port forward ${port}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return actualAgentDashboardPort;
}
