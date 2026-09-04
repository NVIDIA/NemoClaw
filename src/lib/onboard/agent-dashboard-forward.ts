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

// The port deployment verification must probe lives with the rest of this
// module's "which host port does this agent publish" logic, so onboarding
// reaches it through the dashboard helpers it already consumes (#9290).
export { resolveVerifyAgentApiPort } from "./hermes-api-port";

export type EnsureDashboardForward = (
  sandboxName: string,
  chatUiUrl?: string,
  options?: {
    allowPortReallocation?: boolean;
    revalidateSandboxIdentity?: (operation: string) => void;
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
  beforeForwardPort?: (port: number) => Promise<void> | void;
  revalidateSandboxIdentity?: (operation: string) => void;
  warn?: (message: string) => void;
}): Promise<number> {
  const {
    sandboxName,
    agent,
    ensureDashboardForward,
    chatUiUrl,
    controlUiPort,
    hermesApiPort,
    beforeForwardPort,
    revalidateSandboxIdentity,
    warn = (message: string) => console.warn(message),
  } = options;
  if (!shouldManageDashboardForAgent(agent)) {
    return 0;
  }
  const previousChatUiUrl = process.env.CHAT_UI_URL;
  const restoreChatUiUrl = (): void => {
    if (previousChatUiUrl === undefined) delete process.env.CHAT_UI_URL;
    else process.env.CHAT_UI_URL = previousChatUiUrl;
  };
  let identityFailure: unknown = null;
  const revalidateIdentity = revalidateSandboxIdentity
    ? (operation: string): void => {
        try {
          revalidateSandboxIdentity(operation);
        } catch (error) {
          identityFailure = error;
          throw error;
        }
      }
    : undefined;

  try {
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
      ]),
    ].filter(isValidForwardPort);
    const requestedDashboardUrl =
      !usesFixedApiPort && chatUiUrl
        ? replaceUrlPort(chatUiUrl, agentDashboardPort)
        : `http://127.0.0.1:${agentDashboardPort}`;
    await beforeForwardPort?.(agentDashboardPort);
    const actualAgentDashboardPort = ensureDashboardForward(sandboxName, requestedDashboardUrl, {
      allowPortReallocation: false,
      ...(revalidateIdentity ? { revalidateSandboxIdentity: revalidateIdentity } : {}),
    });
    if (!usesFixedApiPort) {
      revalidateIdentity?.(`publish the dashboard URL for sandbox '${sandboxName}'`);
      process.env.CHAT_UI_URL = replaceUrlPort(requestedDashboardUrl, actualAgentDashboardPort);
    }

    for (const port of preservePorts) {
      if (port === agentDashboardPort) continue;
      try {
        await beforeForwardPort?.(port);
        const forwardUrl =
          port === optionalDashboardPort && chatUiUrl
            ? replaceUrlPort(chatUiUrl, port)
            : `http://127.0.0.1:${port}`;
        ensureDashboardForward(sandboxName, forwardUrl, {
          allowPortReallocation: false,
          ...(revalidateIdentity ? { revalidateSandboxIdentity: revalidateIdentity } : {}),
        });
      } catch (err) {
        if (err === identityFailure) throw err;
        warn(
          `  ! Could not start optional agent port forward ${port}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    revalidateIdentity?.(`report successful dashboard forwarding for sandbox '${sandboxName}'`);
    return actualAgentDashboardPort;
  } catch (error) {
    if (error === identityFailure) {
      restoreChatUiUrl();
    }
    throw error;
  }
}

export function replaceUrlPort(value: string, port: number): string {
  try {
    const parsed = new URL(value.includes("://") ? value : `http://${value}`);
    parsed.port = String(port);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return `http://127.0.0.1:${port}`;
  }
}
