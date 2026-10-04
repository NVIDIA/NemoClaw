// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

export const SANDBOX_EXEC_STARTED_MARKER = "__NEMOCLAW_SANDBOX_EXEC_STARTED__";
const GENERATED_SANDBOX_EXEC_MARKER_PATTERN = new RegExp(
  `^${SANDBOX_EXEC_STARTED_MARKER}_[0-9a-f]{32}$`,
);

function assertSandboxExecMarker(marker: string): void {
  if (
    marker === SANDBOX_EXEC_STARTED_MARKER ||
    GENERATED_SANDBOX_EXEC_MARKER_PATTERN.test(marker)
  ) {
    return;
  }
  throw new Error("Invalid sandbox exec marker");
}

export function createSandboxExecMarker(): string {
  return `${SANDBOX_EXEC_STARTED_MARKER}_${randomBytes(16).toString("hex")}`;
}

export function buildSandboxExecMarkedCommand(
  command: string,
  marker = SANDBOX_EXEC_STARTED_MARKER,
): string {
  assertSandboxExecMarker(marker);
  if (!command.includes("validate-hermes-env-secret-boundary.py")) {
    return `printf '%s\\n' '${marker}'; ${command}`;
  }
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  return [
    `printf '%s\\n' '${marker}'`,
    "command -v base64 >/dev/null 2>&1 || { echo NEMOCLAW_BASE64_MISSING >&2; exit 127; }",
    `printf '%s' '${encodedCommand}' | base64 -d | sh`,
  ].join("; ");
}

function parseSandboxExecStdoutFrame(line: string): { text: string; framed: boolean } {
  const trimmed = line.trimStart();
  const stdoutPrefix = trimmed.match(/^(?:\[stdout\]|stdout:)\s*/i);
  if (!stdoutPrefix) return { text: line, framed: false };
  return { text: trimmed.slice(stdoutPrefix[0].length), framed: true };
}

/**
 * Extract child-command stdout from `openshell sandbox exec` output after the
 * sentinel printed by `markedCommand`. Some OpenShell versions frame child
 * stdout for humans, e.g. `stdout: __NEMOCLAW_SANDBOX_EXEC_STARTED__`, while
 * older versions pass raw stdout through unchanged. Normalize only recognized
 * stdout frame prefixes at this transport boundary so recovery, status, and
 * Hermes boundary callers keep consuming plain command stdout.
 *
 * Security boundary: accept exactly one marker across the captured stdout and
 * stderr streams. A duplicate before or after the authentic boundary is
 * ambiguous and must fail closed. A fresh marker for each exec also prevents
 * fixed preamble text from being mistaken for the current boundary.
 *
 * Remove this compatibility shim once OpenShell exposes a stable
 * machine-readable exec output mode that preserves child stdout/stderr
 * without human framing.
 */
export function extractSandboxExecCommandStdoutFromStreams(
  streams: { stdout?: string; stderr?: string },
  marker = SANDBOX_EXEC_STARTED_MARKER,
): string | null {
  let markerLocation: { lines: Array<{ text: string; framed: boolean }>; index: number } | null =
    null;

  for (const output of [streams.stdout ?? "", streams.stderr ?? ""]) {
    const normalized = output.trim();
    if (!normalized) continue;
    const lines = normalized.split(/\r?\n/).map(parseSandboxExecStdoutFrame);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].text.trim() !== marker) continue;
      if (markerLocation !== null) return null;
      markerLocation = { lines, index };
    }
  }

  if (markerLocation !== null) {
    return markerLocation.lines
      .slice(markerLocation.index + 1)
      .map((line) => line.text)
      .join("\n")
      .trim();
  }

  return null;
}

export function extractSandboxExecCommandStdout(
  output: string,
  marker = SANDBOX_EXEC_STARTED_MARKER,
): string | null {
  return extractSandboxExecCommandStdoutFromStreams({ stdout: output }, marker);
}
