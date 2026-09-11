// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getRegisteredAgent } from "../agent/runtime";
import type { AgentDefinition } from "../agent/definition-types";
import { formatEnvAssignment } from "../core/url-utils";
import { isValidProxyHost, isValidProxyPort } from "./dockerfile-patch";
import { appendExtraPlaceholderKeysEnvArg } from "./extra-placeholder-keys";
import { HERMES_API_PORT_ENV, resolveOnboardHermesApiPort } from "./hermes-api-port";
import { appendHermesDashboardEnvArgs, type HermesDashboardOnboardState } from "./hermes-dashboard";
import { appendHostProxyEnvArgs } from "./host-proxy-env";
import { appendOpenClawRuntimeEnvArgs } from "./openclaw-runtime-env";

const STARTUP_COMMAND_TOKEN = /^[A-Za-z0-9_./:=,@%+\-[\]]+$/u;
export const OPENSHELL_MAIN_PROCESS_SPEC_ENV = "OPENSHELL_MAIN_PROCESS_SPEC";
const OPENSHELL_MAIN_PROCESS_SPEC_VERSION = 1;
const MAX_MAIN_PROCESS_ARGV_BYTES = 128 * 1024;
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

export type OpenShellMainProcessSpec = Readonly<{
  version: 1;
  command: readonly string[];
  tty: boolean;
}>;

function exactMainProcessCommand(command: unknown): readonly string[] {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.includes("\0") ||
        Buffer.byteLength(entry, "utf8") > 64 * 1024,
    )
  ) {
    throw new Error("OpenShell main-process spec contains an invalid command argv.");
  }
  const result = command.map(String);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_MAIN_PROCESS_ARGV_BYTES) {
    throw new Error("OpenShell main-process spec command exceeds its bounded argv transport.");
  }
  return Object.freeze(result);
}

/** Decode the exact Docker-driver main-process transport introduced in OpenShell 0.0.116. */
export function parseOpenShellMainProcessSpecEnvValue(value: string): OpenShellMainProcessSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OpenShell main-process spec is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OpenShell main-process spec is not an object.");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "command" ||
    keys[1] !== "tty" ||
    keys[2] !== "version" ||
    record.version !== OPENSHELL_MAIN_PROCESS_SPEC_VERSION ||
    typeof record.tty !== "boolean"
  ) {
    throw new Error("OpenShell main-process spec does not match the 0.0.116 Docker contract.");
  }
  return Object.freeze({
    version: OPENSHELL_MAIN_PROCESS_SPEC_VERSION,
    command: exactMainProcessCommand(record.command),
    tty: record.tty,
  });
}

export function openshellMainProcessSpecEnvValue(command: readonly string[], tty: boolean): string {
  return JSON.stringify({
    version: OPENSHELL_MAIN_PROCESS_SPEC_VERSION,
    command: exactMainProcessCommand(command),
    tty,
  });
}

export function replaceOpenShellMainProcessSpecCommand(
  value: string,
  command: readonly string[],
): string {
  const spec = parseOpenShellMainProcessSpecEnvValue(value);
  return openshellMainProcessSpecEnvValue(command, spec.tty);
}
