// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import {
  type HermesMcpCommandResult,
  isHermesGatewayDrainingResponse,
} from "./mcp-bridge-hermes-http.ts";

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;
const HERMES_GATEWAY_DRAINING_RETRIES = 3;
const HERMES_GATEWAY_DRAINING_RETRY_DELAY_MS = 5_000;
export const MCP_BRIDGE_TEST_REDACTION_VALUES = Object.values(MCP_BRIDGE_TEST_CREDENTIALS);
const OPENCLAW_BASELINE_SCOPE_CAUSE =
  "its canonical CLI device did not receive the required baseline scopes";
const HERMES_RESTART_TRANSPORT_FAILURE_SUFFIX = [
  `Error: x code: 'Unknown error', message: "h2 protocol error: error reading a body`,
  `| from connection", source: hyper::Error(Body, Error { kind: Io(Custom`,
  `| { kind: BrokenPipe, error: "stream closed because of a broken pipe" }) })`,
  `|-> error reading a body from connection`,
  `|-> stream closed because of a broken pipe`,
].join("\n");
const HERMES_RESTART_SUCCESS_PREFIX = new RegExp(
  `^${[
    String.raw`Effective egress that would be opened:`,
    String.raw`(?:.*\n)*?\s*- (?<host>[a-z0-9-]+\.trycloudflare\.com):\d+[^\n]*`,
    String.raw`(?:.*\n)*?Applied preset: mcp-bridge-concurrent`,
    String.raw`Narrowing sandbox egress — removing: \k<host>`,
    String.raw`Removed preset: mcp-bridge-concurrent`,
    String.raw`✓ Policy version (?<cleanupVersion>\d+) submitted \(hash: [0-9a-f]+\)`,
    String.raw`✓ Policy version \k<cleanupVersion> loaded \(active version: \k<cleanupVersion>\)`,
    String.raw`Preset not found: mcp-bridge-concurrent`,
    String.raw`✓ Policy version (?<commitVersion>\d+) submitted \(hash: [0-9a-f]+\)`,
    String.raw`✓ Policy version \k<commitVersion> loaded \(active version: \k<commitVersion>\)`,
  ].join("\n")}$`,
  "u",
);

function normalizeHermesTransportDiagnostic(diagnostic: string): string {
  return diagnostic
    .replace(ANSI_ESCAPE, "")
    .replaceAll("\u00d7", "x")
    .replaceAll("\u2502", "|")
    .replaceAll("\u251c\u2500\u25b6", "|->")
    .replaceAll("\u2570\u2500\u25b6", "|->")
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter(Boolean)
    .join("\n");
}

export function isRetryableOpenClawBaselineScopeOnboardFailure(
  agent: string,
  sandboxName: string,
  result: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
): boolean {
  if (
    agent !== "openclaw" ||
    result.exitCode === null ||
    result.exitCode === 0 ||
    result.signal !== null ||
    result.timedOut
  ) {
    return false;
  }
  const expected = `OpenClaw onboarding for '${sandboxName}' is incomplete because ${OPENCLAW_BASELINE_SCOPE_CAUSE}. Resume or rerun onboarding.`;
  return `${result.stdout}\n${result.stderr}`
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/u)
    .some((line) => line.trim() === expected);
}

export async function retryOpenClawBaselineScopeOnboardFailure<
  T extends {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
>(options: {
  agent: string;
  sandboxName: string;
  initialResult: T;
  retry: () => Promise<T>;
}): Promise<T> {
  return isRetryableOpenClawBaselineScopeOnboardFailure(
    options.agent,
    options.sandboxName,
    options.initialResult,
  )
    ? options.retry()
    : options.initialResult;
}

export function isHermesRestartTransportFailure(adapter: string, diagnostic: string): boolean {
  // The producer is OpenShell's sandbox-exec HTTP/2 stream while the packaged
  // Hermes transaction helper performs its acknowledged SIGUSR1 gateway reload.
  // NemoClaw cannot repair that transport from this E2E boundary. The live
  // caller first proves one coherent committed bridge, then retries only the
  // serialized loser and still requires the canonical duplicate rejection.
  // Remove this classifier when OpenShell preserves command completion across
  // that managed reload or returns a structured post-commit outcome (#6692).
  if (adapter !== "hermes-config") return false;
  const normalized = normalizeHermesTransportDiagnostic(diagnostic);
  const suffix = `\n${HERMES_RESTART_TRANSPORT_FAILURE_SUFFIX}`;
  if (!normalized.endsWith(suffix)) return false;

  return HERMES_RESTART_SUCCESS_PREFIX.test(normalized.slice(0, -suffix.length));
}

export async function retryAfterHermesRestartTransportFailure<T>(options: {
  adapter: string;
  committedBridgeVerified: boolean;
  diagnostic: string;
  originalResult: T;
  retry: () => Promise<T>;
}): Promise<T> {
  if (!options.committedBridgeVerified) {
    throw new Error("Hermes restart retry requires a verified committed bridge");
  }
  if (/already exists/iu.test(options.diagnostic)) return options.originalResult;
  if (!isHermesRestartTransportFailure(options.adapter, options.diagnostic)) {
    throw new Error("rejected concurrent add was not a known Hermes restart transport failure");
  }
  return options.retry();
}

export async function retryHermesGatewayDraining<T extends HermesMcpCommandResult>(options: {
  initialResult: T;
  retry: (attempt: number) => Promise<T>;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let result = options.initialResult;
  for (
    let attempt = 1;
    attempt <= HERMES_GATEWAY_DRAINING_RETRIES && isHermesGatewayDrainingResponse(result);
    attempt += 1
  ) {
    await wait(HERMES_GATEWAY_DRAINING_RETRY_DELAY_MS);
    result = await options.retry(attempt);
  }
  return result;
}

export async function restartBridgeWithoutHostSecret(
  host: HostCliClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  const restart = await host.nemoclaw([sandboxName, "mcp", "restart", "fake"], {
    artifactName: `${artifactPrefix}-mcp-restart-provider-reuse`,
    env: buildAvailabilityProbeEnv(),
    redactionValues: MCP_BRIDGE_TEST_REDACTION_VALUES,
    timeoutMs: 12 * 60_000,
  });
  assertExitZero(restart, `${artifactPrefix} mcp restart without host secret`);
}
