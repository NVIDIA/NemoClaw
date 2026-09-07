// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT, HERMES_OPENAI_API_PORT } from "../core/ports";
import { buildChain } from "../dashboard/contract";
import { type DashboardAccessOptions, resolveDashboardPlatformHints } from "./dashboard-access";
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

/**
 * Say so when a non-loopback `CHAT_UI_URL` is what takes the dashboard forward
 * off the loopback bind. Naming an external browser URL is not a request to
 * listen on every interface, and the operator opt-in for that is
 * `NEMOCLAW_DASHBOARD_BIND`, so onboarding has to report the wider surface it
 * is about to open rather than leave the user to find it with `ss` (#10861).
 *
 * The warning names the Host header check because a reader can reasonably
 * assume it is what keeps the wider bind safe, and it is not. The dashboard
 * binds `127.0.0.1` inside the sandbox and reaches the network through a socat
 * bridge and the host-side forward, so `_is_accepted_host` always observes a
 * loopback bind and cannot tell an exposed deployment from a private one. It
 * also accepts the `CHAT_UI_URL` hostname on purpose, for the reverse-proxy
 * deployments this variable exists to serve. It is Host validation, not
 * authentication.
 */
export function discloseDashboardBindWidening(
  dashboardUrl: string,
  port: number,
  warn: (message: string) => void,
  accessOptions: DashboardAccessOptions = {},
): void {
  // `bindWidenedByChatUiUrl` excludes WSL and the explicit
  // `NEMOCLAW_DASHBOARD_BIND` opt-in, but only when it is told about them.
  // Building the chain from the URL alone dropped both, so the warning fired
  // on hosts where the bind was already wide for another reason and told the
  // operator to unset `CHAT_UI_URL` to restore a loopback bind they would not
  // get back.
  const chain = buildChain({
    chatUiUrl: dashboardUrl,
    port,
    ...resolveDashboardPlatformHints(accessOptions),
  });
  if (!chain.bindWidenedByChatUiUrl) return;
  warn(
    `  ! CHAT_UI_URL is not a loopback address, so the dashboard forward for port ${String(port)} ` +
      `binds ${chain.bindAddress} instead of 127.0.0.1. Every host that can reach this machine on ` +
      `that port can reach the dashboard. The dashboard's Host header check is not an access ` +
      `control — it accepts the CHAT_UI_URL hostname by design — so serve it through an ` +
      `authenticating proxy, or unset CHAT_UI_URL to keep the loopback bind.`,
  );
}

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
  /** Host hints for the bind-widening disclosure; production reads the real environment. */
  dashboardAccess?: DashboardAccessOptions;
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
    dashboardAccess = {},
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
      ...new Set([agentDashboardPort, ...declaredPorts, optionalDashboardPort]),
    ].filter(isValidForwardPort);
    const requestedDashboardUrl =
      !usesFixedApiPort && chatUiUrl
        ? replaceUrlPort(chatUiUrl, agentDashboardPort)
        : `http://127.0.0.1:${agentDashboardPort}`;
    discloseDashboardBindWidening(requestedDashboardUrl, agentDashboardPort, warn, dashboardAccess);
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
