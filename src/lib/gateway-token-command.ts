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
  /** Pull gateway.auth.token from the sandbox config (host-side helper). */
  fetchToken: (sandboxName: string) => string | null;
  /** Optional stdout sink -- defaults to console.log. */
  log?: (message: string) => void;
  /** Optional stderr sink -- defaults to console.error. */
  error?: (message: string) => void;
}

export interface GatewayTokenCommandOptions {
  /** Suppress the stderr security warning when set (`--quiet` / `-q`). */
  quiet?: boolean;
}

const SECURITY_WARNING =
  "Treat this token like a password -- do not log, share, or commit it.";

/**
 * Run the gateway-token command. Returns the process exit code (0 on success,
 * 1 on failure). The caller is responsible for invoking `process.exit` and for
 * having validated that the sandbox exists in the registry.
 */
export function runGatewayTokenCommand(
  sandboxName: string,
  options: GatewayTokenCommandOptions,
  deps: GatewayTokenCommandDeps,
): number {
  const log = deps.log ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));

  let token: string | null;
  try {
    token = deps.fetchToken(sandboxName);
  } catch {
    token = null;
  }

  if (!token) {
    error(`  Could not retrieve the gateway auth token for sandbox '${sandboxName}'.`);
    error(`  Make sure the sandbox is running: nemoclaw ${sandboxName} status`);
    return 1;
  }

  log(token);
  if (!options.quiet) {
    error(SECURITY_WARNING);
  }
  return 0;
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
