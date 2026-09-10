// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw owns argv validation. Inspect its supported options only to choose
// stdin, output, and deadline behavior; never rewrite or read message payloads.
// Unknown options stop inspection because their argument arity is unknown.
const VALUE_FLAGS = new Set([
  "--agent",
  "--message",
  "--message-file",
  "--model",
  "--provider",
  "--channel",
  "--reply-to",
  "--reply-channel",
  "--reply-account",
  "--session-id",
  "--session-key",
  "--thinking",
  "--timeout",
  "--to",
  "--verbose",
  "--profile",
  "--log-level",
  "--container",
]);
const BOOLEAN_FLAGS = new Set([
  "--deliver",
  "--local",
  "--json",
  "--help",
  "--dev",
  "--no-color",
  "--version",
]);
// Retain NemoClaw's existing -a/--provider recognition alongside OpenClaw 2026.7.1.
const SHORT_FLAGS: Readonly<Record<string, string>> = {
  "-a": "--agent",
  "-m": "--message",
  "-t": "--to",
  "-h": "--help",
  "-V": "--version",
  "-v": "--version",
};

type AgentOption = {
  flag: string;
  value: string | undefined;
  argumentIndex: number;
  inline: boolean;
};

function agentOptions(command: readonly string[]): { options: AgentOption[]; complete: boolean } {
  const options: AgentOption[] = [];
  if (command[0] !== "openclaw" || command[1] !== "agent") return { options, complete: false };
  for (let index = 2; index < command.length; index += 1) {
    const arg = command[index] as string;
    if (arg === "--") return { options, complete: true };
    const argumentIndex = index;
    const shortFlag = SHORT_FLAGS[arg.slice(0, 2)];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = shortFlag ?? (equals < 0 ? arg : arg.slice(0, equals));
    const takesValue = VALUE_FLAGS.has(flag);
    const inline = shortFlag ? arg.length > 2 : equals >= 0;
    if (!takesValue && (!BOOLEAN_FLAGS.has(flag) || (inline && flag !== "--json")))
      return { options, complete: false };
    const value = inline
      ? arg.slice(shortFlag ? 2 : equals + 1)
      : takesValue
        ? command[++index]
        : undefined;
    options.push({ flag, value, argumentIndex, inline });
  }
  return { options, complete: true };
}

function findOption(command: readonly string[], flags: readonly string[]): AgentOption | undefined {
  let found: AgentOption | undefined;
  for (const option of agentOptions(command).options) {
    if (flags.includes(option.flag)) found = option;
  }
  return found;
}

export function hasExplicitAgentMessage(command: readonly string[]): boolean {
  // Incomplete options must reach OpenClaw's usage error without waiting for stdin.
  return findOption(command, ["--message", "--message-file"]) !== undefined;
}

export function requestsOpenClawJsonOutput(command: readonly string[]): boolean {
  const option = findOption(command, ["--json"]);
  return (
    option !== undefined &&
    !["0", "false", "no", "off"].includes((option.value ?? "").toLowerCase())
  );
}

export function hasOpenClawAgentSelector(command: readonly string[]): boolean | undefined {
  const parsed = agentOptions(command);
  if (
    parsed.options.some(({ flag }) =>
      ["--agent", "--session-id", "--session-key", "--to"].includes(flag),
    )
  )
    return true;
  // Unknown options belong to OpenClaw. Do not invent a missing-selector error
  // when their arity prevents the host from interpreting later arguments.
  return parsed.complete ? false : undefined;
}

export function requestsOpenClawLocalMode(command: readonly string[]): boolean {
  return findOption(command, ["--local"]) !== undefined;
}

// #8723 observed timeout reports arriving up to 20.8 seconds after the requested
// deadline. Keep 30 seconds for the remote turn to report its own failure.
// This is an execution deadline, not a bound on host readiness or lock acquisition.
export const AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS = 30;

function requestedTimeout(command: readonly string[]): (AgentOption & { seconds: number }) | null {
  const option = findOption(command, ["--timeout"]);
  if (option?.value === undefined || !/^\d+$/.test(option.value)) return null;
  const seconds = Number(option.value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? { ...option, seconds } : null;
}

/** Zero, malformed, absent, or ambiguous timeouts keep the existing unbounded behavior. */
export function requestedAgentTimeoutSeconds(command: readonly string[]): number | null {
  return requestedTimeout(command)?.seconds ?? null;
}

export function replaceRequestedAgentTimeoutSeconds(
  argv: readonly string[],
  timeoutSeconds: number,
): readonly string[] {
  const requested = requestedTimeout(argv);
  if (!requested) return argv;
  const value = String(Math.max(1, Math.floor(timeoutSeconds)));
  const command = [...argv];
  command[requested.argumentIndex + (requested.inline ? 0 : 1)] = requested.inline
    ? `--timeout=${value}`
    : value;
  return command;
}

export function agentDispatchDeadlineSeconds(command: readonly string[]): number | undefined {
  const requested = requestedAgentTimeoutSeconds(command);
  if (requested === null) return undefined;
  const deadline = requested + AGENT_DISPATCH_DEADLINE_BUFFER_SECONDS;
  return Number.isSafeInteger(deadline) ? deadline : undefined;
}
