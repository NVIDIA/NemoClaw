// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;
export type McpAdapter = "mcporter" | "hermes-config" | "deepagents-config";
const HERMES_RESTART_TRANSPORT_FAILURE_SUFFIX = [
  `Error: x code: 'Unknown error', message: "h2 protocol error: error reading a body`,
  `| from connection", source: hyper::Error(Body, Error { kind: Io(Custom`,
  `| { kind: BrokenPipe, error: "stream closed because of a broken pipe" }) })`,
  `|-> error reading a body from connection`,
  `|-> stream closed because of a broken pipe`,
].join("\n");
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hermesRestartSuccessPrefix(serverName: string): RegExp {
  const policyName = escapeRegExp(`mcp-bridge-${serverName}`);
  return new RegExp(
    `^${[
      String.raw`Effective egress that would be opened:`,
      String.raw`(?:.*\n)*?\s*- (?<host>[a-z0-9-]+\.trycloudflare\.com):\d+[^\n]*`,
      String.raw`(?:.*\n)*?Applied preset: ${policyName}`,
      String.raw`Narrowing sandbox egress — removing: \k<host>`,
      String.raw`Removed preset: ${policyName}`,
      String.raw`✓ Policy version (?<cleanupVersion>\d+) submitted \(hash: [0-9a-f]+\)`,
      String.raw`✓ Policy version \k<cleanupVersion> loaded \(active version: \k<cleanupVersion>\)`,
      String.raw`Preset not found: ${policyName}`,
      String.raw`✓ Policy version (?<commitVersion>\d+) submitted \(hash: [0-9a-f]+\)`,
      String.raw`✓ Policy version \k<commitVersion> loaded \(active version: \k<commitVersion>\)`,
    ].join("\n")}$`,
    "u",
  );
}

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

export function isHermesRestartTransportFailure(
  adapter: McpAdapter,
  diagnostic: string,
  serverName = "concurrent",
): boolean {
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

  return hermesRestartSuccessPrefix(serverName).test(normalized.slice(0, -suffix.length));
}

export async function retryAfterHermesRestartTransportFailure<T>(options: {
  adapter: McpAdapter;
  committedBridgeVerified: boolean;
  diagnostic: string;
  originalResult: T;
  serverName?: string;
  retry: () => Promise<T>;
}): Promise<T> {
  if (!options.committedBridgeVerified) {
    throw new Error("Hermes restart retry requires a verified committed bridge");
  }
  if (/already exists/iu.test(options.diagnostic)) return options.originalResult;
  if (
    !isHermesRestartTransportFailure(
      options.adapter,
      options.diagnostic,
      options.serverName ?? "concurrent",
    )
  ) {
    throw new Error("rejected concurrent add was not a known Hermes restart transport failure");
  }
  return options.retry();
}
