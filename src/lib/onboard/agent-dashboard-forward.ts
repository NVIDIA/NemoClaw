// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../core/ports";
import {
  type DashboardRuntimeAgent,
  getAgentDeclaredForwardPorts,
  getAgentPrimaryForwardPort,
  isValidForwardPort,
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

export type AgentDashboardForwardConfig = NonNullable<DashboardRuntimeAgent> & {
  dashboard?: { kind?: unknown } | null;
  dashboardUi?: unknown;
};

export function ensureAgentDashboardForward(options: {
  sandboxName: string;
  agent: AgentDashboardForwardConfig;
  ensureDashboardForward: EnsureDashboardForward;
  chatUiUrl?: string;
  controlUiPort?: number;
  preserveForwardPorts?: readonly (number | null | undefined)[];
  warn?: (message: string) => void;
}): number {
  const {
    sandboxName,
    agent,
    ensureDashboardForward,
    chatUiUrl,
    controlUiPort,
    preserveForwardPorts = [],
    warn = (message: string) => console.warn(message),
  } = options;
  if (!shouldManageDashboardForAgent(agent)) {
    return 0;
  }

  const declaredPrimaryPort = getAgentPrimaryForwardPort(agent, DASHBOARD_PORT);
  const usesFixedApiPort = agent.dashboard?.kind === "api";
  const agentDashboardPort =
    !usesFixedApiPort && isValidForwardPort(controlUiPort) ? controlUiPort : declaredPrimaryPort;
  const optionalDashboardPort =
    usesFixedApiPort && agent.dashboardUi && isValidForwardPort(controlUiPort)
      ? controlUiPort
      : null;
  const declaredPorts = getAgentDeclaredForwardPorts(agent).filter(
    (port) => port !== declaredPrimaryPort || port === agentDashboardPort,
  );
  const preservePorts = [
    ...new Set([
      agentDashboardPort,
      ...declaredPorts,
      optionalDashboardPort,
      ...preserveForwardPorts,
    ]),
  ].filter(isValidForwardPort);
  const requestedDashboardUrl =
    !usesFixedApiPort && chatUiUrl
      ? replaceUrlPort(chatUiUrl, agentDashboardPort)
      : `http://127.0.0.1:${agentDashboardPort}`;
  const actualAgentDashboardPort = ensureDashboardForward(sandboxName, requestedDashboardUrl, {
    preserveSandboxPorts: preservePorts,
  });
  if (!usesFixedApiPort) {
    process.env.CHAT_UI_URL = replaceUrlPort(requestedDashboardUrl, actualAgentDashboardPort);
  }

  const portsToPreserve = [...new Set([...preservePorts, actualAgentDashboardPort])];
  for (const port of preservePorts) {
    if (port === agentDashboardPort) continue;
    try {
      const forwardUrl =
        port === optionalDashboardPort && chatUiUrl
          ? replaceUrlPort(chatUiUrl, port)
          : `http://127.0.0.1:${port}`;
      ensureDashboardForward(sandboxName, forwardUrl, {
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

function replaceUrlPort(value: string, port: number): string {
  try {
    const parsed = new URL(value.includes("://") ? value : `http://${value}`);
    parsed.port = String(port);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}
