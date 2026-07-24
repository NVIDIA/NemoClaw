// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "./agent/defs";
import type { SandboxEntry } from "./state/registry";

export interface ConnectionInfoCommandDeps {
  getSandbox: (sandboxName: string) => SandboxEntry | null;
  fetchToken: (sandboxName: string) => string | null;
  loadAgent: (agentName: string) => AgentDefinition | null;
  isTerminalAgent: (agent: AgentDefinition) => boolean;
  printDashboard: (
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer: string | null,
    agent: AgentDefinition | null,
    ready: boolean,
  ) => void;
  log: (message: string) => void;
}

export class ConnectionInfoCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n"));
    this.name = "ConnectionInfoCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function connectionInfoFail(lines: string | readonly string[], exitCode = 1): never {
  throw new ConnectionInfoCommandError(lines, exitCode);
}

function resolveAgentDefinition(
  agentName: string | null,
  loadAgent: ConnectionInfoCommandDeps["loadAgent"],
): AgentDefinition | null {
  if (!agentName || agentName === "openclaw") return null;
  try {
    return loadAgent(agentName);
  } catch {
    return null;
  }
}

function printTerminalConnectionBlock(
  sandboxName: string,
  agent: AgentDefinition,
  log: (message: string) => void,
): void {
  const runtime = agent.runtime ?? null;
  log(`  ${agent.displayName || "Terminal agent"} terminal runtime`);
  log("");
  log("  Terminal:");
  log(`    nemoclaw ${sandboxName} connect`);
  if (runtime?.interactive_command) {
    log(`    then run: ${runtime.interactive_command}`);
  }
  if (runtime?.headless_command) {
    log(`    headless: ${runtime.headless_command} "<task>"`);
  }
}

export function runConnectionInfoCommand(
  sandboxName: string,
  deps: ConnectionInfoCommandDeps,
): void {
  let sandbox: SandboxEntry | null = null;
  try {
    sandbox = deps.getSandbox(sandboxName);
  } catch {
    sandbox = null;
  }

  if (!sandbox) {
    connectionInfoFail([
      `  Sandbox '${sandboxName}' does not exist.`,
      `  Run 'nemoclaw onboard' to create one, or 'nemoclaw list' to see existing sandboxes.`,
    ]);
  }

  const agent = resolveAgentDefinition(sandbox.agent ?? null, deps.loadAgent);

  if (agent && deps.isTerminalAgent(agent)) {
    printTerminalConnectionBlock(sandboxName, agent, deps.log);
    return;
  }

  if (!agent) {
    let token: string | null;
    try {
      token = deps.fetchToken(sandboxName);
    } catch {
      token = null;
    }
    if (!token) {
      connectionInfoFail([
        `  Could not read the connection details for sandbox '${sandboxName}'.`,
        `  Make sure the sandbox is running: nemoclaw ${sandboxName} status`,
      ]);
    }
  }

  const model = sandbox.model ?? "";
  const provider = sandbox.provider ?? "";
  deps.printDashboard(sandboxName, model, provider, null, agent, true);
}
