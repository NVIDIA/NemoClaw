// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth boundary for the `nemoclaw <name> agent` passthrough.
//
// The wrapper enforces three host-side mirrors of upstream contracts, one
// advisory diagnostic, and one best-effort pre-dispatch recovery:
//
// 1. Agent-kind guard (registry mirror).
//
//    - Invalid state: the local registry is the source of truth for which
//      agent a sandbox runs (openclaw vs hermes vs future variants).
//      Forwarding to `openclaw agent` against a non-OpenClaw sandbox triggers
//      an in-sandbox binary that does not exist (or exists with incompatible
//      flags), and would silently bypass the host-side guard intended to
//      redirect Hermes callers to the sandbox's OpenAI-compatible API port.
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
// 4. Recent shields-relock diagnostic (advisory audit mirror). Its complete
//    source-boundary analysis lives with the focused implementation in
//    `passthrough-shields-warning.ts`.
//
// 5. Ollama restart recovery (best-effort lifecycle bridge). Ollama owns model
//    runner lifetime, while NemoClaw owns the registered route and dispatch
//    ordering. The focused source-boundary analysis, reporting, and regression
//    coverage live in `ollama-restart-recovery.ts` and
//    `passthrough-ollama-recovery.ts`.
//
// 6. Dispatch delivery contract and stdin posture. Both captured transports
//    fail loud when the exec returns success with no bytes on either stream,
//    and neither hands an interactive terminal to the non-interactive
//    dispatch. Both transports pin the sandbox's owning gateway and use the
//    shared asynchronous exec supervisor, which forwards host termination to
//    OpenShell before returning the signal-derived exit status. The complete
//    source-boundary analysis and classifier live in
//    `passthrough-dispatch.ts`; the operator-facing failure text lives beside
//    the help copy in `passthrough-help.ts`.
//
// Regression tests: `passthrough.test.ts` covers the Hermes redirect, the
// forwarded argv, SIGTERM exit status, the registry-miss fallback to OpenClaw,
// registry and manifest-resolution fail-closed paths, quoted manifest command
// rejection, the enforced `--no-tty` argv shape, the non-Ready phase recovery
// path, the unparseable phase fail-closed path, the OpenClaw no-selector rejection, and
// the `--flag=value` selector-acceptance branch, plus the OpenClaw JSON
// captured transport path used to append failure provenance without polluting
// machine-readable stdout. The focused shields and Ollama modules own their
// diagnostic and recovery tests.
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
//   - Drop Ollama pre-dispatch recovery when supported daemon restarts preserve
//     loaded runners or NemoClaw manages and warms the daemon lifecycle.

import { type AgentDefinition, isTerminalAgent, listAgents, loadAgent } from "../../../agent/defs";
import { CLI_NAME } from "../../../cli/branding";
import { isStdinTty } from "../../../core/stdin";
import { resolveSandboxHermesApiPort } from "../../../onboard/hermes-api-port";
import type { ShieldsAutoRestoreReadResult } from "../../../shields/audit";
import * as registry from "../../../state/registry";
import {
  buildOpenshellExecArgs,
  computeExitCode,
  execSandbox,
  wrapOpenClawAgentCommandWithRuntimeEnv,
} from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { getKnownSandboxTargetGatewayName } from "../gateway-target";
import {
  type AgentDispatchRunner,
  agentDispatchDeadlineSeconds,
  isSilentAgentDispatch,
  isTimedOutAgentDispatch,
  OPENCLAW_AGENT_BOOLEAN_FLAGS,
  OPENCLAW_AGENT_VALUE_FLAGS,
  runAgentDispatch,
  SILENT_AGENT_DISPATCH_EXIT_CODE,
  TIMED_OUT_AGENT_TURN_EXIT_CODE,
} from "./passthrough-dispatch";
import {
  hasAgentPassthroughHelpToken,
  printAgentPassthroughHelp,
  writeSilentAgentDispatchFailure,
  writeTimedOutAgentTurnFailure,
} from "./passthrough-help";
import {
  type AgentJsonPassthroughProcess,
  defaultGetOpenshellBinary,
  runAgentJsonPassthrough,
} from "./passthrough-json";
import { OLLAMA_LOCAL_PROVIDER, runOllamaRestartRecovery } from "./passthrough-ollama-recovery";
import { maybeEmitShieldsRelockWarning } from "./passthrough-shields-warning";

export { hasAgentPassthroughHelpToken, printAgentPassthroughHelp } from "./passthrough-help";

// OpenClaw can exit zero after running in embedded-fallback mode and does not
// expose a stable machine-readable transport discriminator. These patterns mirror
// the gateway-auth live tests in restore-gateway-pairing.ts and extend them with
// the reporter-observed `[agent/embedded]` line prefix (#8100). Removal condition:
// OpenClaw provides a supported machine-readable gateway-only result or removes
// embedded-fallback mode.
const OPENCLAW_EMBEDDED_FALLBACK_PATTERN =
  /EMBEDDED FALLBACK|\[agent\/embedded\]|fallbackFrom[": ]+gateway|transport[": ]+embedded/i;

export type AgentNonJsonPassthroughDeps = {
  getOpenshellBinary?: () => string;
  getGatewayName?: (sandboxName: string) => string | null;
  runDispatch?: AgentDispatchRunner;
  stdinIsTty?: () => boolean;
};

export async function runAgentNonJsonPassthrough(
  sandboxName: string,
  command: readonly string[],
  proc: NonNullable<AgentPassthroughDeps["process"]>,
  deps: AgentNonJsonPassthroughDeps = {},
): Promise<never> {
  const binary = (deps.getOpenshellBinary ?? defaultGetOpenshellBinary)();
  const result = await (deps.runDispatch ?? runAgentDispatch)(
    binary,
    buildOpenshellExecArgs(
      sandboxName,
      wrapOpenClawAgentCommandWithRuntimeEnv(command),
      { tty: false, timeoutSeconds: agentDispatchDeadlineSeconds(command) },
      (deps.getGatewayName ?? getKnownSandboxTargetGatewayName)(sandboxName) ?? undefined,
    ),
    {
      stdinIsTty: (deps.stdinIsTty ?? isStdinTty)(),
    },
  );
  const { stderr, stdout } = result;

  if (isSilentAgentDispatch(result, stdout, stderr)) {
    writeSilentAgentDispatchFailure(proc, sandboxName, command);
    return proc.exit(SILENT_AGENT_DISPATCH_EXIT_CODE);
  }

  if (OPENCLAW_EMBEDDED_FALLBACK_PATTERN.test(`${stdout}\n${stderr}`)) {
    proc.stderr.write(
      `  OpenClaw is running in embedded-fallback mode in sandbox '${sandboxName}': gateway pairing is broken or missing.\n`,
    );
    proc.stderr.write("  Documented recovery paths:\n");
    proc.stderr.write(
      `    ${CLI_NAME} ${sandboxName} recover         — re-pair the gateway without recreating the sandbox\n`,
    );
    proc.stderr.write(
      `    ${CLI_NAME} ${sandboxName} rebuild --yes   — recreate container, workspace preserved\n`,
    );
    proc.stderr.write(
      `    ${CLI_NAME} onboard --resume               — restore sandbox registration\n`,
    );
    return proc.exit(1);
  }

  if (stdout) (proc.stdout ?? process.stdout).write(stdout);
  if (stderr) proc.stderr.write(stderr);
  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    proc.stderr.write(`  Failed to invoke openshell: ${errorMessage}\n`);
    proc.stderr.write("  Ensure 'openshell' is installed and on PATH.\n");
  }

  // Last, so the partial trace is already on the wire: a turn whose deadline
  // fired must not exit 0 just because the transport did. An upstream non-zero
  // code is preserved as-is.
  if (code === 0 && isTimedOutAgentDispatch(stdout, stderr)) {
    writeTimedOutAgentTurnFailure(proc, sandboxName);
    return proc.exit(TIMED_OUT_AGENT_TURN_EXIT_CODE);
  }
  return proc.exit(code);
}

export interface AgentPassthroughOptions {
  extraArgs?: readonly string[];
}

export interface AgentPassthroughDeps {
  getSandbox?: typeof registry.getSandbox;
  ensureLive?: typeof ensureLiveSandboxOrExit;
  exec?: typeof execSandbox;
  execJson?: typeof runAgentJsonPassthrough;
  execNonJson?: typeof runAgentNonJsonPassthrough;
  runOllamaRestartRecovery?: typeof runOllamaRestartRecovery;
  getRecentShieldsAutoRestore?: (sandboxName: string) => ShieldsAutoRestoreReadResult;
  process?: {
    exit(code: number): never;
    stdout?: { write(s: string): unknown };
    stderr: { write(s: string): unknown };
  };
}

type RegistryReadResult =
  | { kind: "missing" }
  | {
      kind: "agent";
      agent: string | null;
      provider: string | null;
      model: string | null;
      endpointUrl: string | null;
      entry: registry.SandboxEntry;
    }
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
    return {
      kind: "agent",
      agent: sandbox.agent ?? null,
      provider: sandbox.provider ?? null,
      model: sandbox.model ?? null,
      endpointUrl: sandbox.endpointUrl ?? null,
      entry: sandbox,
    };
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
  const apiPort = resolveSandboxHermesApiPort(registry.getSandbox(sandboxName) ?? {});
  proc.stderr.write(
    `  Hermes exposes an OpenAI-compatible API on port ${apiPort} inside the sandbox;\n`,
  );
  proc.stderr.write(
    `  forward it with 'openshell forward start --background ${apiPort} ${sandboxName}'\n`,
  );
  proc.stderr.write(`  and POST to http://127.0.0.1:${apiPort}/v1/chat/completions instead.\n`);
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

function getTerminalPassthroughCommand(agent: AgentDefinition): TerminalCommandResult {
  const command =
    agent.name === "nemocua"
      ? (agent.runtime?.headless_command ?? "")
      : (agent.runtime?.interactive_command ?? agent.runtime?.headless_command ?? "");
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

  const terminalCommand = getTerminalPassthroughCommand(agent);
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
  // passthrough, where OpenClaw parses argv itself. Any newly documented value
  // flag, including a `--json-*` name, must be added to the value-flag set and
  // its tests together. Regression tests cover each documented value flag,
  // documented equals-form value flags, documented boolean flags, unknown flag
  // fallback, and the `--` terminator. Removal
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
  const phase = state?.phase ?? null;
  if (!phase) {
    rejectUnparseablePhase(sandboxName, proc);
  }
  if (phase !== "Ready" && phase !== "Running") {
    rejectNotReadyForAgent(sandboxName, phase, proc);
  }
  if (isOpenClawPassthroughCommand(command) && !hasTargetSelector(extraArgs)) {
    rejectNoTargetSelector(proc);
  }
  if (isOpenClawPassthroughCommand(command)) {
    if (lookup.kind === "agent" && lookup.provider === OLLAMA_LOCAL_PROVIDER) {
      const recoverOllama = deps.runOllamaRestartRecovery ?? runOllamaRestartRecovery;
      recoverOllama(lookup, proc);
    }
    maybeEmitShieldsRelockWarning(proc, sandboxName, deps.getRecentShieldsAutoRestore);
  }
  if (isOpenClawPassthroughCommand(command) && requestsOpenClawJsonOutput(extraArgs)) {
    const execJson = deps.execJson ?? runAgentJsonPassthrough;
    await execJson(sandboxName, command, {
      exit: proc.exit.bind(proc),
      stdout: proc.stdout ?? process.stdout,
      stderr: proc.stderr,
    } satisfies AgentJsonPassthroughProcess);
    return;
  }
  if (isOpenClawPassthroughCommand(command)) {
    const execNonJson = deps.execNonJson ?? runAgentNonJsonPassthrough;
    await execNonJson(sandboxName, command, proc);
    return;
  }
  const exec = deps.exec ?? execSandbox;
  await exec(sandboxName, command, { tty: false });
}
