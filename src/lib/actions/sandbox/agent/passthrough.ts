// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth boundary for the `nemoclaw <name> agent` passthrough.
//
// The wrapper enforces three host-side mirrors of upstream contracts:
//
// 1. Agent-kind guard (registry mirror).
//
//    - Invalid state: the local registry is the source of truth for which
//      agent a sandbox runs (openclaw vs hermes vs future variants).
//      Forwarding to `openclaw agent` against a non-OpenClaw sandbox triggers
//      an in-sandbox binary that does not exist (or exists with incompatible
//      flags), and would silently bypass the host-side guard intended to
//      redirect Hermes callers to the OpenAI-compatible API on port 8642.
//    - Source boundary: the registry and agent manifest allowlist are
//      NemoClaw-owned. The in-sandbox invocation, its argv contract, and its
//      streaming behaviour are owned by the selected upstream agent command.
//      NemoClaw does not rewrite agent flags here; it forwards them verbatim.
//      Terminal-runtime dispatch uses the manifest command only when it can
//      be represented as simple whitespace-delimited argv tokens; shell
//      quoting/escaping fails closed until manifests expose argv natively.
//    - Source-fix constraint: NemoClaw cannot prove agent type from anywhere
//      except the registry, because the OpenShell exec transport has no
//      pre-execution probe that reveals the sandbox's configured agent. A
//      registry read failure therefore has to fail closed — silently
//      degrading to OpenClaw-as-default would let a Hermes-onboarded sandbox
//      dispatch the wrong binary on transient I/O errors.
//
// 2. Non-ready phase guard (OpenShell phase mirror).
//
//    - Invalid state: when a sandbox container is stopped, errored, or
//      otherwise not Ready/Running, a bare `openshell sandbox exec` either
//      hangs, fails with a generic transport error, or silently runs against
//      a stale container. None of those surface the documented recovery
//      paths (`recover`, `rebuild --yes`, `onboard --resume`).
//    - Source boundary: OpenShell owns the phase value and the underlying
//      readiness mechanism; NemoClaw owns the host-side recovery copy and
//      the precedence of the phase check vs the selector check.
//    - Source-fix constraint: NemoClaw cannot teach `openshell sandbox exec`
//      to emit recovery commands on its own — that would require an upstream
//      change to OpenShell. The wrapper therefore inspects `ensureLive`'s
//      gateway-state output and rejects with NemoClaw's recovery copy before
//      forwarding to the in-sandbox binary. The phase check runs before the
//      selector check so a stopped sandbox still gets recovery guidance even
//      when the caller forgot the selector flag. If the gateway-state output
//      cannot be parsed for a `Phase:` line at all, the wrapper fails closed
//      with exit 2 rather than dispatching against an unknown phase.
//
// 3. Selector-required guard (OpenClaw argv mirror).
//
//    - Invalid state: upstream `openclaw agent` reports the missing-selector
//      error on stderr but then exits with status `0` (success), so CLI
//      consumers that branch on the exit code see the call as successful
//      and never learn that no selector was provided. The host-side mirror
//      converts that misuse into a clean exit `2` with the same diagnostic
//      before any in-sandbox dispatch runs.
//    - Source boundary: OpenClaw owns the argv contract; NemoClaw mirrors
//      only the selector requirement (one of `--agent`, `--session-id`,
//      `--session-key`, `--to`) to surface a clean exit 2 with a usage hint
//      before sending the argv into the sandbox. The scan stops at the
//      first literal `--`, mirroring the help-token boundary, so a token
//      that looks like a selector after the argv separator is treated as
//      OpenClaw's payload and not as the host-side selector.
//    - Source-fix constraint: NemoClaw forwards the rest of OpenClaw's argv
//      verbatim, so the mirror is intentionally narrow — only the missing-
//      selector case is intercepted; everything else still flows through to
//      the in-sandbox binary.
//
// Regression tests: `passthrough.test.ts` covers the Hermes redirect, the
// forwarded argv, the registry-miss fallback to OpenClaw, registry and
// manifest-resolution fail-closed paths, quoted manifest command rejection,
// the enforced `--no-tty` argv shape, the non-Ready phase recovery path, the
// unparseable phase fail-closed path, the OpenClaw no-selector rejection, and
// the `--flag=value` selector-acceptance branch, plus the OpenClaw JSON
// captured transport path used to append failure provenance without polluting
// machine-readable stdout.
//
// Removal conditions:
//
//   - Drop the registry-based agent-kind guard when OpenShell exposes a
//     metadata endpoint that returns the sandbox's configured agent.
//   - Drop the host-side phase guard when `openshell sandbox exec` surfaces
//     readiness or recovery guidance itself.
//   - Drop the selector mirror when upstream `openclaw agent` rejects a
//     missing selector with a clean exit 2 and an actionable message.
//   - Drop the simple-token parser when terminal runtime manifests expose
//     argv arrays natively.

import { type AgentDefinition, isTerminalAgent, listAgents, loadAgent } from "../../../agent/defs";
import { CLI_NAME } from "../../../cli/branding";
import { parseSandboxPhase } from "../../../state/gateway";
import * as registry from "../../../state/registry";
import { execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { hasAgentPassthroughHelpToken, printAgentPassthroughHelp } from "./passthrough-help";
import { type AgentJsonPassthroughProcess, runAgentJsonPassthrough } from "./passthrough-json";

export {
  hasAgentPassthroughHelpToken,
  printAgentPassthroughHelp,
} from "./passthrough-help";

const OPENCLAW_AGENT_VALUE_FLAGS = new Set([
  "-a",
  "--agent",
  "-m",
  "--message",
  "--model",
  "--provider",
  "--reply-channel",
  "--session-id",
  "--session-key",
  "--thinking",
  "--timeout",
  "--to",
]);

const OPENCLAW_AGENT_BOOLEAN_FLAGS = new Set(["--deliver"]);

export interface AgentPassthroughOptions {
  extraArgs?: readonly string[];
}

export interface AgentPassthroughDeps {
  getSandbox?: typeof registry.getSandbox;
  ensureLive?: typeof ensureLiveSandboxOrExit;
  exec?: typeof execSandbox;
  execJson?: typeof runAgentJsonPassthrough;
  process?: {
    exit(code: number): never;
    stdout?: { write(s: string): unknown };
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

function ensureRegisteredAgentIsKnown(
  sandboxName: string,
  agent: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): void {
  let knownAgents: string[];
  try {
    knownAgents = listAgents();
  } catch (error) {
    rejectAgentResolutionError(
      sandboxName,
      agent,
      `Could not read local agent manifest allowlist: ${(error as Error).message}`,
      proc,
    );
  }
  if (!knownAgents.includes(agent)) {
    rejectAgentResolutionError(
      sandboxName,
      agent,
      "Registered agent is not present in the local agent manifest allowlist",
      proc,
    );
  }
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
    if (hasAgentPassthroughHelpToken(extraArgs)) {
      printAgentPassthroughHelp();
      return null;
    }
    return ["openclaw", "agent", ...extraArgs];
  }

  const agentName = lookup.agent;
  if (agentName === null || agentName === "openclaw") {
    if (hasAgentPassthroughHelpToken(extraArgs)) {
      printAgentPassthroughHelp();
      return null;
    }
    return ["openclaw", "agent", ...extraArgs];
  }

  ensureRegisteredAgentIsKnown(sandboxName, agentName, proc);
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

function isOpenClawPassthroughCommand(command: readonly string[]): boolean {
  return command[0] === "openclaw" && command[1] === "agent";
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

function requestsOpenClawJsonOutput(extraArgs: readonly string[]): boolean {
  // Invalid state: the host wrapper must pick captured JSON transport only for
  // the top-level OpenClaw output flag, not for a literal "--json" consumed as
  // a value by another OpenClaw option. Source boundary: upstream OpenClaw owns
  // the complete argv grammar; NemoClaw mirrors documented flags only to choose
  // the host transport path. Unknown options fail conservative to normal
  // passthrough, where OpenClaw parses argv itself. Regression tests cover each
  // documented value flag, documented equals-form value flags, documented
  // boolean flags, unknown flag fallback, and the `--` terminator. Removal
  // condition: OpenClaw exposes a machine-readable argv schema or NemoClaw stops
  // special-casing the JSON transport path.
  let skipNextValue = false;
  for (const arg of extraArgs) {
    if (skipNextValue) {
      skipNextValue = false;
      continue;
    }
    if (arg === "--") return false;
    if (arg === "--json") return true;
    if (arg.startsWith("--json=")) {
      return !["0", "false", "no", "off"].includes(arg.slice("--json=".length).toLowerCase());
    }
    if (OPENCLAW_AGENT_VALUE_FLAGS.has(arg)) {
      skipNextValue = true;
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    if (
      equalsIndex > 0 &&
      arg.startsWith("--") &&
      OPENCLAW_AGENT_VALUE_FLAGS.has(arg.slice(0, equalsIndex))
    ) {
      continue;
    }
    if (OPENCLAW_AGENT_BOOLEAN_FLAGS.has(arg)) continue;
    if (arg.startsWith("-")) return false;
  }
  return false;
}

const TARGET_SELECTOR_FLAGS = ["--agent", "--session-id", "--session-key", "--to"] as const;

function hasTargetSelector(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (TARGET_SELECTOR_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      return true;
    }
  }
  return false;
}

function rejectNoTargetSelector(proc: NonNullable<AgentPassthroughDeps["process"]>): never {
  proc.stderr.write(
    "  No target session selected. Use --agent <id>, --session-key <key>, --session-id <id>, or --to <E.164>.\n",
  );
  proc.stderr.write("  Run `openclaw agents list` inside the sandbox to see available agents.\n");
  return proc.exit(2);
}

function rejectUnparseablePhase(
  sandboxName: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  Could not parse a 'Phase:' line from the live state of sandbox '${sandboxName}'.\n`,
  );
  proc.stderr.write(
    "  Refusing to dispatch the agent command because the readiness guard cannot fail closed.\n",
  );
  proc.stderr.write(
    `  Run \`${CLI_NAME} ${sandboxName} status\` to inspect the gateway-state output.\n`,
  );
  return proc.exit(2);
}

function rejectNotReadyForAgent(
  sandboxName: string,
  phase: string,
  proc: NonNullable<AgentPassthroughDeps["process"]>,
): never {
  proc.stderr.write(
    `  Sandbox '${sandboxName}' is not ready for the agent wrapper (phase: ${phase}).\n`,
  );
  proc.stderr.write("  Documented recovery paths:\n");
  proc.stderr.write(
    `    ${CLI_NAME} ${sandboxName} recover         — gateway down, sandbox alive\n`,
  );
  proc.stderr.write(
    `    ${CLI_NAME} ${sandboxName} rebuild --yes   — recreate container, workspace preserved\n`,
  );
  proc.stderr.write(
    `    ${CLI_NAME} onboard --resume               — restore sandbox registration\n`,
  );
  return proc.exit(1);
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
  const state = await ensureLive(sandboxName, { allowNonReadyPhase: true });
  const phase = parseSandboxPhase(state?.output ?? "");
  if (!phase) {
    rejectUnparseablePhase(sandboxName, proc);
  }
  if (phase !== "Ready" && phase !== "Running") {
    rejectNotReadyForAgent(sandboxName, phase, proc);
  }
  if (isOpenClawPassthroughCommand(command) && !hasTargetSelector(extraArgs)) {
    rejectNoTargetSelector(proc);
  }
  if (isOpenClawPassthroughCommand(command) && requestsOpenClawJsonOutput(extraArgs)) {
    const execJson = deps.execJson ?? runAgentJsonPassthrough;
    execJson(sandboxName, command, {
      exit: proc.exit.bind(proc),
      stdout: proc.stdout ?? process.stdout,
      stderr: proc.stderr,
    } satisfies AgentJsonPassthroughProcess);
    return;
  }
  const exec = deps.exec ?? execSandbox;
  await exec(sandboxName, command, { tty: false });
}
