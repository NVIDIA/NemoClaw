// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

export const SANDBOX_EXEC_STARTED_MARKER = "__NEMOCLAW_SANDBOX_EXEC_STARTED__";

export function buildSandboxExecMarkedCommand(command: string): string {
  if (!command.includes("validate-hermes-env-secret-boundary.py")) {
    return `printf '%s\\n' '${SANDBOX_EXEC_STARTED_MARKER}'; ${command}`;
  }
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  return [
    `printf '%s\\n' '${SANDBOX_EXEC_STARTED_MARKER}'`,
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
 * Security boundary: the sentinel must occupy its own stdout line after optional
 * frame-prefix stripping. A preamble that merely contains the sentinel string is
 * rejected so sandbox output cannot move the parser boundary forward. Remove
 * this compatibility shim once OpenShell exposes a stable machine-readable exec
 * output mode that preserves child stdout/stderr without human framing.
 */
export function extractSandboxExecCommandStdout(output: string): string | null {
  const stdout = output.trim();
  if (!stdout) return null;
  const lines = stdout.split(/\r?\n/).map(parseSandboxExecStdoutFrame);
  const exactMarkerIndex = lines.findIndex(
    (line) => line.text.trim() === SANDBOX_EXEC_STARTED_MARKER,
  );
  if (exactMarkerIndex >= 0) {
    return lines
      .slice(exactMarkerIndex + 1)
      .map((line) => line.text)
      .join("\n")
      .trim();
  }

  return null;
}
