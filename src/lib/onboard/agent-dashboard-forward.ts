// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT, HERMES_OPENAI_API_PORT } from "../core/ports";
import {
  type DashboardRuntimeAgent,
  getAgentDeclaredForwardPorts,
  getAgentPrimaryForwardPort,
  isValidForwardPort,
  shouldManageDashboardForAgent,
} from "./dashboard-runtime";
import { resolveOnboardHermesApiPort } from "./hermes-api-port";

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

export async function ensureAgentDashboardForward(options: {
  sandboxName: string;
  agent: AgentDashboardForwardConfig;
  ensureDashboardForward: EnsureDashboardForward;
  chatUiUrl?: string;
  controlUiPort?: number;
  /** Host port allocated to this sandbox's OpenAI-compatible API, when it has one. */
  hermesApiPort?: number | null;
  preserveForwardPorts?: readonly (number | null | undefined)[];
  beforeForwardPort?: (port: number) => Promise<void> | void;
  warn?: (message: string) => void;
}): Promise<number> {
  const {
    sandboxName,
    agent,
    ensureDashboardForward,
    chatUiUrl,
    controlUiPort,
    hermesApiPort,
    preserveForwardPorts = [],
    beforeForwardPort,
    warn = (message: string) => console.warn(message),
  } = options;
  if (!shouldManageDashboardForAgent(agent)) {
    return 0;
  }

  // The manifest names the agent's default API port. This sandbox owns its own,
  // so forward the allocated port instead of the sibling sandbox's default.
  const resolveDeclaredPort = (port: number): number =>
    port === HERMES_OPENAI_API_PORT
      ? (hermesApiPort ?? resolveOnboardHermesApiPort(sandboxName, { warn }))
      : port;
  const declaredPrimaryPort = getAgentPrimaryForwardPort(agent, DASHBOARD_PORT);
  const usesFixedApiPort = agent.dashboard?.kind === "api";
  const agentDashboardPort = usesFixedApiPort
    ? resolveDeclaredPort(declaredPrimaryPort)
    : isValidForwardPort(controlUiPort)
      ? controlUiPort
      : declaredPrimaryPort;
  const optionalDashboardPort =
    usesFixedApiPort && agent.dashboardUi && isValidForwardPort(controlUiPort)
      ? controlUiPort
      : null;
  const declaredPorts = getAgentDeclaredForwardPorts(agent)
    .filter((port) => port !== declaredPrimaryPort || port === agentDashboardPort)
    .map(resolveDeclaredPort);
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
  await beforeForwardPort?.(agentDashboardPort);
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
      await beforeForwardPort?.(port);
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
