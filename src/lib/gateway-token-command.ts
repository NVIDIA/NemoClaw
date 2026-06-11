// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `nemoclaw <name> gateway-token` -- print the OpenClaw gateway auth token
 * for a running sandbox to stdout so automation can capture it.
 *
 * Output contract (intended to be pipe-friendly):
 *   stdout: the token, followed by a single newline.
 *   stderr: a one-line security warning, suppressed by --quiet / -q.
 *   exit 0: token printed.
 *   exit 1: token unavailable; diagnostics written to stderr.
 */

export interface GatewayTokenCommandDeps {
  /**
   * Fetch the agent-appropriate auth token for the sandbox (host-side helper).
   * The bridge wires the right fetcher based on the resolved agent: OpenClaw's
   * gateway.auth.token, or a bearer_token agent's web-auth key (e.g. Hermes'
   * API_SERVER_KEY).
   */
  fetchToken: (sandboxName: string) => string | null;
  /**
   * Resolve the agent name registered for the sandbox (e.g. "openclaw",
   * "hermes"). When omitted -- or when the lookup throws -- the OpenClaw
   * code path is used unchanged so callers without registry access keep
   * working. Returning null is treated the same as "openclaw" since the
   * registry stored that as the implicit default before the agent field
   * existed.
   */
  getSandboxAgent?: (sandboxName: string) => string | null;
  /**
   * Whether the resolved agent exposes a retrievable auth token. OpenClaw
   * (gateway token) and bearer_token agents like Hermes (API key) return
   * true; agents with no token mechanism return false and get the
   * not-applicable message. Defaults to "openclaw only" when omitted so
   * callers without agent metadata keep the historical behaviour.
   */
  agentExposesToken?: (agentName: string | null) => boolean;
  /** Optional stdout sink -- defaults to console.log. */
  log?: (message: string) => void;
  /** Optional stderr sink -- defaults to console.error. */
  error?: (message: string) => void;
}

export interface GatewayTokenCommandOptions {
  /** Suppress the stderr security warning when set (`--quiet` / `-q`). */
  quiet?: boolean;
}

export class GatewayTokenCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n"));
    this.name = "GatewayTokenCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function gatewayTokenFail(lines: string | readonly string[], exitCode = 1): never {
  throw new GatewayTokenCommandError(lines, exitCode);
}

const SECURITY_WARNING = "Treat this token like a password -- do not log, share, or commit it.";

/**
 * Run the gateway-token command. Throws {@link GatewayTokenCommandError} on
 * failure. The caller is responsible for rendering failures and for having
 * validated that the sandbox exists in the registry.
 */
export function runGatewayTokenCommand(
  sandboxName: string,
  options: GatewayTokenCommandOptions,
  deps: GatewayTokenCommandDeps,
): void {
  const log = deps.log ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));

  // NCQ #3180: surface an agent-aware "not applicable" message (instead of the
  // misleading "make sure the sandbox is running" hint) for agents that have no
  // retrievable auth token. OpenClaw exposes its gateway token; bearer_token
  // agents like Hermes expose their web-auth key (API_SERVER_KEY). Anything
  // else is rejected.
  let resolvedAgent: string | null = null;
  if (deps.getSandboxAgent) {
    try {
      resolvedAgent = deps.getSandboxAgent(sandboxName);
    } catch {
      resolvedAgent = null;
    }
  }
  const exposesToken = deps.agentExposesToken
    ? deps.agentExposesToken(resolvedAgent)
    : resolvedAgent === null || resolvedAgent === "openclaw";
  if (!exposesToken) {
    gatewayTokenFail(
      `  gateway-token is not applicable for sandbox '${sandboxName}': it uses the '${resolvedAgent}' agent, which does not expose a retrievable auth token.`,
    );
  }

  let token: string | null;
  try {
    token = deps.fetchToken(sandboxName);
  } catch {
    token = null;
  }

  if (!token) {
    gatewayTokenFail([
      `  Could not retrieve the gateway auth token for sandbox '${sandboxName}'.`,
      `  Make sure the sandbox is running: nemoclaw ${sandboxName} status`,
    ]);
  }

  log(token);
  if (!options.quiet) {
    error(SECURITY_WARNING);
  }
}

/** Parse the raw `gateway-token` action arguments. */
export function parseGatewayTokenArgs(actionArgs: readonly string[]): {
  options: GatewayTokenCommandOptions;
  unknown: string[];
} {
  const options: GatewayTokenCommandOptions = { quiet: false };
  const unknown: string[] = [];
  for (const arg of actionArgs) {
    if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
    } else {
      unknown.push(arg);
    }
  }
  return { options, unknown };
}
