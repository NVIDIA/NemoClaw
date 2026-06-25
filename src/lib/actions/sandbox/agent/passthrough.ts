// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth boundary for the `nemoclaw <name> agent` passthrough:
//
// - Invalid state: the local registry is the source of truth for which agent a
//   sandbox runs (openclaw vs hermes vs future variants). Forwarding to
//   `openclaw agent` against a non-OpenClaw sandbox triggers an in-sandbox
//   binary that does not exist (or exists with incompatible flags), and would
//   silently bypass the host-side guard intended to redirect Hermes callers to
//   the OpenAI-compatible API on port 8642.
//
// - Source boundary: this wrapper owns the host-side guard only. The in-sandbox
//   agent invocation, OpenClaw argv contract, and streaming behaviour are owned
//   by upstream OpenClaw. Terminal-runtime dispatch uses the manifest command
//   only when it can be represented as simple whitespace-delimited argv tokens;
//   shell quoting/escaping fails closed until the manifest exposes argv natively.
//
// - Source-fix constraint: NemoClaw cannot prove agent type from anywhere
//   except the registry, because the OpenShell exec transport has no
//   pre-execution probe that reveals the sandbox's configured agent. A
//   registry read failure therefore has to fail closed — silently degrading
//   to OpenClaw-as-default would let a Hermes-onboarded sandbox dispatch the
//   wrong binary on transient I/O errors.
//
// - Regression tests: `passthrough.test.ts` covers the Hermes redirect, the
//   forwarded argv, the registry-miss fallback to OpenClaw, registry and
//   manifest-resolution fail-closed paths, quoted manifest command rejection,
//   and the enforced `--no-tty` argv shape.
//
// - Removal condition: when OpenShell exposes a metadata endpoint that returns
//   the sandbox's configured agent, drop the registry read and consult that
//   endpoint directly. When terminal runtime manifests expose argv arrays, drop
//   the simple-token parser and unsupported-shell-syntax rejection.

import { isTerminalAgent, loadAgent, type AgentDefinition } from "../../../agent/defs";
import * as registry from "../../../state/registry";
import { execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { hasAgentPassthroughHelpToken, printAgentPassthroughHelp } from "./passthrough-help";

export {
  hasAgentPassthroughHelpToken,
  printAgentPassthroughHelp,
} from "./passthrough-help";

export interface AgentPassthroughOptions {
  extraArgs?: readonly string[];
}

export interface AgentPassthroughDeps {
  getSandbox?: typeof registry.getSandbox;
  ensureLive?: typeof ensureLiveSandboxOrExit;
  exec?: typeof execSandbox;
  process?: {
    exit(code: number): never;
    stderr: { write(s: string): unknown };
  };
}

type RegistryReadResult =
  | { kind: "missing" }
  | { kind: "agent"; agent: string | null }
  | { kind: "error"; message: string };
type ResolvedRegistryReadResult = Exclude<RegistryReadResult, { kind: "error" }>;
type TerminalCommandResult =
  | { kind: "command"; argv: string[] }
  | { kind: "unsupported"; message: string };

function readSandboxAgentFromRegistry(
  sandboxName: string,
  getSandbox: typeof registry.getSandbox = registry.getSandbox,
): RegistryReadResult {
  try {
    const sandbox = getSandbox(sandboxName);
    if (!sandbox) return { kind: "missing" };
    return { kind: "agent", agent: sandbox.agent ?? null };
  } catch (error) {
    return { kind: "error", message: (error as Error).message ?? String(error) };
  }
}

function rejectNonOpenclawAgent(
  sandboxName: string,
  agent: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  The \`sandbox agent\` wrapper cannot dispatch to sandbox '${sandboxName}' because it runs '${agent}'.\n`,
  );
  proc.stderr.write("  Hermes exposes an OpenAI-compatible API on port 8642 inside the sandbox;\n");
  proc.stderr.write(
    `  forward it with 'openshell forward start --background 8642 ${sandboxName}'\n`,
  );
  proc.stderr.write("  and POST to http://127.0.0.1:8642/v1/chat/completions instead.\n");
  return proc.exit(2);
}

function rejectAgentResolutionError(
  sandboxName: string,
  agent: string,
  message: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  Could not resolve a passthrough command for registered agent '${agent}' in sandbox '${sandboxName}'.\n`,
  );
  proc.stderr.write(`  Agent resolution error: ${message}\n`);
  proc.stderr.write("  Refusing to dispatch because the sandbox agent guard cannot fail closed.\n");
  return proc.exit(2);
}

function splitManifestCommand(command: string): TerminalCommandResult {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "command", argv: [] };
  if (/["'\\]/.test(trimmed)) {
    return {
      kind: "unsupported",
      message:
        "terminal runtime commands must be simple whitespace-delimited argv tokens; quoted or escaped shell syntax is not supported",
    };
  }
  return { kind: "command", argv: trimmed.split(/\s+/).filter(Boolean) };
}

function getTerminalInteractiveCommand(agent: AgentDefinition): TerminalCommandResult {
  const command = agent.runtime?.interactive_command ?? agent.runtime?.headless_command ?? "";
  return splitManifestCommand(command);
}

function getPassthroughCommand(
  sandboxName: string,
  lookup: ResolvedRegistryReadResult,
  extraArgs: readonly string[],
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): string[] | null {
  if (lookup.kind === "missing") {
    if (extraArgs.length === 0 || hasAgentPassthroughHelpToken(extraArgs)) {
      printAgentPassthroughHelp();
      return null;
    }
    return ["openclaw", "agent", ...extraArgs];
  }

  const agentName = lookup.agent;
  if (agentName === null || agentName === "openclaw") {
    if (extraArgs.length === 0 || hasAgentPassthroughHelpToken(extraArgs)) {
      printAgentPassthroughHelp();
      return null;
    }
    return ["openclaw", "agent", ...extraArgs];
  }

  let agent: AgentDefinition;
  try {
    agent = loadAgent(agentName);
  } catch (error) {
    rejectAgentResolutionError(sandboxName, agentName, (error as Error).message, proc);
  }
  if (!isTerminalAgent(agent)) {
    rejectNonOpenclawAgent(sandboxName, agentName, proc);
  }

  const terminalCommand = getTerminalInteractiveCommand(agent);
  if (terminalCommand.kind === "unsupported") {
    rejectAgentResolutionError(sandboxName, agentName, terminalCommand.message, proc);
  }
  if (terminalCommand.argv.length === 0) {
    rejectNonOpenclawAgent(sandboxName, agentName, proc);
  }
  return [...terminalCommand.argv, ...extraArgs];
}

function rejectRegistryReadError(
  sandboxName: string,
  message: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  Could not read the local sandbox registry to confirm agent type for '${sandboxName}'.\n`,
  );
  proc.stderr.write(`  Registry read error: ${message}\n`);
  proc.stderr.write(
    "  Refusing to forward to `openclaw agent` because the agent guard cannot fail closed.\n",
  );
  return proc.exit(2);
}

export async function runAgentPassthrough(
  sandboxName: string,
  { extraArgs = [] }: AgentPassthroughOptions = {},
  deps: AgentPassthroughDeps = {},
): Promise<void> {
  const proc = deps.process ?? process;
  const lookup = readSandboxAgentFromRegistry(sandboxName, deps.getSandbox);
  if (lookup.kind === "error") {
    rejectRegistryReadError(sandboxName, lookup.message, proc);
  }
  const command = getPassthroughCommand(sandboxName, lookup, extraArgs, proc);
  if (!command) return;
  const ensureLive = deps.ensureLive ?? ensureLiveSandboxOrExit;
  await ensureLive(sandboxName, { allowNonReadyPhase: true });
  const exec = deps.exec ?? execSandbox;
  await exec(sandboxName, command, { tty: false });
}
