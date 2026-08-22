// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getRegisteredAgent } from "../agent/runtime";
import type { AgentDefinition } from "../agent/definition-types";
import { formatEnvAssignment } from "../core/url-utils";
import { isValidProxyHost, isValidProxyPort } from "./dockerfile-patch";
import { appendExtraPlaceholderKeysEnvArg } from "./extra-placeholder-keys";
import { HERMES_API_PORT_ENV, resolveOnboardHermesApiPort } from "./hermes-api-port";
import {
  appendHermesDashboardEnvArgs,
  type HermesDashboardOnboardState,
} from "./hermes-dashboard";
import { appendHostProxyEnvArgs } from "./host-proxy-env";
import { appendOpenClawRuntimeEnvArgs } from "./openclaw-runtime-env";

const STARTUP_COMMAND_TOKEN = /^[A-Za-z0-9_./:=,@%+\-\[\]]+$/u;
const OPENCLAW_AUTO_PAIR_RUNTIME_ENV_KEYS = [
  "NEMOCLAW_AUTO_PAIR_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS",
  "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS",
  "NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS",
  "NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS",
] as const;
const OPENCLAW_DIAGNOSTIC_RUNTIME_ENV_KEYS = ["NEMOCLAW_MCP_SHADOW_DIAGNOSTICS"] as const;
const OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV = "NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS";
const OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS = 1500;
const OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS = 10_000;

function appendOpenClawAutoPairRuntimeEnvArgs(
  envArgs: string[],
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv,
): void {
  if (agent && agent.name !== "openclaw") return;
  for (const key of OPENCLAW_AUTO_PAIR_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) envArgs.push(formatEnvAssignment(key, value));
  }
}

function appendOpenClawDiagnosticRuntimeEnvArgs(
  envArgs: string[],
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv,
): void {
  if (agent && agent.name !== "openclaw") return;
  for (const key of OPENCLAW_DIAGNOSTIC_RUNTIME_ENV_KEYS) {
    if (env[key]?.trim() === "1") envArgs.push(formatEnvAssignment(key, "1"));
  }
}

function appendOpenClawMcpToolsListTimeoutRuntimeEnvArg(
  envArgs: string[],
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv,
): void {
  if (agent && agent.name !== "openclaw") return;
  const raw = env[OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return;
  const value = raw.trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(
      `${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV} must be an integer from ${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS} to ${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS} milliseconds.`,
    );
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS ||
    timeoutMs > OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV} must be an integer from ${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS} to ${OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS} milliseconds.`,
    );
  }
  envArgs.push(formatEnvAssignment(OPENCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV, String(timeoutMs)));
}

export interface SandboxRuntimeEnvArgsInput {
  agent: AgentDefinition | null;
  chatUiUrl: string;
  manageDashboard: boolean;
  getDashboardForwardPort(chatUiUrl: string): string;
  hermesDashboardState: HermesDashboardOnboardState;
  hermesApiPort?: number | null;
  extraPlaceholderKeys: readonly string[];
  allowHermesApiPortOverride?: boolean;
  observabilityEnabled?: boolean;
  sandboxName?: string;
  env: NodeJS.ProcessEnv;
  omitCredentialEnv?: boolean;
}

export function buildSandboxRuntimeEnvArgs(input: SandboxRuntimeEnvArgsInput): {
  envArgs: string[];
  effectiveDashboardPort: string;
} {
  const { agent, env, manageDashboard } = input;
  const envArgs = manageDashboard ? [formatEnvAssignment("CHAT_UI_URL", input.chatUiUrl)] : [];
  const effectiveDashboardPort = manageDashboard
    ? input.getDashboardForwardPort(input.chatUiUrl)
    : "0";
  if (manageDashboard) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_PORT", effectiveDashboardPort));
    if (env.NEMOCLAW_DASHBOARD_BIND === "0.0.0.0") {
      envArgs.push(formatEnvAssignment("NEMOCLAW_DASHBOARD_BIND", "0.0.0.0"));
    }
  }

  appendOpenClawRuntimeEnvArgs(envArgs, agent);
  appendOpenClawAutoPairRuntimeEnvArgs(envArgs, agent, env);
  appendOpenClawDiagnosticRuntimeEnvArgs(envArgs, agent, env);
  appendOpenClawMcpToolsListTimeoutRuntimeEnvArg(envArgs, agent, env);
  appendHermesDashboardEnvArgs(envArgs, input.hermesDashboardState, formatEnvAssignment);
  if (agent?.name === "hermes" && input.sandboxName) {
    const apiPort =
      input.hermesApiPort ??
      resolveOnboardHermesApiPort(input.sandboxName, {
        env,
        warn: console.warn,
        allowRegisteredOverride: input.allowHermesApiPortOverride,
      });
    envArgs.push(formatEnvAssignment(HERMES_API_PORT_ENV, String(apiPort)));
  }
  appendHostProxyEnvArgs(envArgs, env, {
    dropCredentialBearingProxyUrls:
      agent?.name === "langchain-deepagents-code" || input.omitCredentialEnv === true,
  });

  const sandboxProxyHost = env.NEMOCLAW_PROXY_HOST;
  if (sandboxProxyHost && isValidProxyHost(sandboxProxyHost)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_HOST", sandboxProxyHost));
  }
  const sandboxProxyPort = env.NEMOCLAW_PROXY_PORT;
  if (sandboxProxyPort && isValidProxyPort(sandboxProxyPort)) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_PROXY_PORT", sandboxProxyPort));
  }
  if (input.sandboxName) {
    envArgs.push(formatEnvAssignment("NEMOCLAW_SANDBOX_NAME", input.sandboxName));
  }
  if (agent?.name === "langchain-deepagents-code") {
    envArgs.push(
      formatEnvAssignment(
        "NEMOCLAW_OBSERVABILITY",
        input.observabilityEnabled === true ? "1" : "0",
      ),
    );
  }
  if (!input.omitCredentialEnv) {
    appendExtraPlaceholderKeysEnvArg(envArgs, input.extraPlaceholderKeys, formatEnvAssignment);
  }
  return { envArgs, effectiveDashboardPort };
}

export function buildCurrentHermesPortableRuntimeEnvArgs(
  input: Omit<SandboxRuntimeEnvArgsInput, "agent">,
): ReturnType<typeof buildSandboxRuntimeEnvArgs> {
  return buildSandboxRuntimeEnvArgs({ ...input, agent: currentHermesPortableAgentDefinition() });
}

export function currentHermesPortableAgentDefinition(): AgentDefinition {
  const agent = getRegisteredAgent({ agent: "hermes" });
  if (!agent) throw new Error("The current Hermes agent manifest is unavailable.");
  return agent;
}

export function openshellSandboxCommandEnvValue(
  command: readonly string[] | null | undefined,
): string | null {
  const parts = (command || []).map(String);
  if (parts.length === 0) return null;
  if (parts.some((part) => part.length === 0 || /[\s\u0085]/u.test(part))) {
    throw new Error(
      "OpenShell sandbox startup command tokens cannot be empty or contain whitespace.",
    );
  }
  if (parts.some((part) => !STARTUP_COMMAND_TOKEN.test(part))) {
    throw new Error(
      "OpenShell sandbox startup command tokens contain unsupported shell metacharacters.",
    );
  }
  return parts.join(" ");
}
