// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure classifiers for OpenShell gateway and sandbox state.
 *
 * Every function here takes string output from openshell CLI commands and
 * returns a typed result — no I/O, no side effects.
 */

const GATEWAY_NAME = "nemoclaw";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

export type GatewayReuseState =
  | "healthy"
  | "active-unnamed"
  | "foreign-active"
  | "stale"
  | "missing";

export type SandboxState = "ready" | "not_ready" | "missing";

function parseSandboxRow(output: string, sandboxName: string): string[] | null {
  if (typeof output !== "string") return null;
  const clean = stripAnsi(output);
  for (const line of clean.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === sandboxName) return cols;
  }
  return null;
}

/** True when `sandbox list` contains an exact first-column sandbox name. */
export function hasSandboxListEntry(output: string, sandboxName: string): boolean {
  return parseSandboxRow(output, sandboxName) !== null;
}

export function parseSandboxStatus(output: string, sandboxName: string): string | null {
  const cols = parseSandboxRow(output, sandboxName);
  return cols && cols.length >= 2 ? cols[1] : null;
}

/**
 * Check if a sandbox is in a live state from `openshell sandbox list` output.
 * Strips ANSI codes and exact-matches the sandbox name in the first column.
 * Checks all columns for "Ready" or "Running" (not just column 2) because
 * the column layout of `openshell sandbox list` varies across OpenShell versions.
 *
 * Both "Ready" and "Running" indicate the sandbox is alive and health
 * checks should proceed. On some deployments (e.g. Brev launchables) the
 * sandbox stays in "Running" phase which is functionally equivalent to
 * "Ready" — the agent is live and the gateway is reachable inside.
 */
export function isSandboxReady(output: string, sandboxName: string): boolean {
  const cols = parseSandboxRow(output, sandboxName);
  if (!cols) return false;
  return (cols.includes("Ready") || cols.includes("Running")) && !cols.includes("NotReady");
}

/**
 * Terminal failure phases reported by `openshell sandbox list`/`get` for a
 * sandbox whose underlying container is dead or unrecoverable. We treat these
 * as short-circuit signals during readiness waits so onboarding fails fast
 * with a clear phase rather than waiting out the full timeout window
 * (NemoClaw issue #4316 — Docker GPU patch leaves the sandbox in Error).
 */
const TERMINAL_SANDBOX_FAILURE_PHASES = new Set(["Error", "Failed", "CrashLoopBackOff"]);

/**
 * Return the failure phase token from `openshell sandbox list` if the row
 * is in a terminal failure phase, otherwise null. Useful for distinguishing
 * "Error" from "Failed"/"CrashLoopBackOff" in user-facing diagnostics.
 */
export function getSandboxFailurePhase(output: string, sandboxName: string): string | null {
  const cols = parseSandboxRow(output, sandboxName);
  if (!cols) return null;
  return cols.find((col) => TERMINAL_SANDBOX_FAILURE_PHASES.has(col)) ?? null;
}

/**
 * Determine whether stale NemoClaw gateway output indicates a previous
 * session that should be cleaned up before the port preflight check.
 */
export function hasStaleGateway(gwInfoOutput: string, gatewayName = GATEWAY_NAME): boolean {
  const clean = typeof gwInfoOutput === "string" ? stripAnsi(gwInfoOutput) : "";
  return (
    clean.length > 0 &&
    getReportedGatewayName(clean) === gatewayName &&
    !clean.includes("No gateway metadata found")
  );
}

export function getReportedGatewayName(output = ""): string | null {
  if (typeof output !== "string") return null;
  const clean = stripAnsi(output);
  const match = clean.match(/^\s*Gateway:\s+([^\s]+)/m);
  return match ? match[1] : null;
}

/**
 * OpenShell v0.0.85 compatibility boundary: `openshell status` prints the
 * selected gateway on stdout, then reports a failed probe on stderr as either
 * `Error: <detail>` or `client error ...`. `runCapture` combines those streams
 * for this probe. OpenShell is an independently versioned external CLI, so
 * NemoClaw cannot retrofit a structured lifecycle discriminator into v0.0.85;
 * this parser limits the compatibility fallback to the producer's error
 * suffix instead of matching diagnostic text elsewhere in the output.
 *
 * Keep this contract aligned with
 * `test/fixtures/openshell-status-errors-v0.0.85.json`. Remove the text parser
 * once NemoClaw's entire supported OpenShell range guarantees a structured
 * status error kind (or an equivalent stable exit-code contract) and callers
 * consume that signal directly.
 */
function getGatewayStatusErrorText(output = ""): string {
  if (typeof output !== "string") return "";
  const clean = stripAnsi(output);
  const match = /(?:^|\n)\s*(?:Error\s*:|client error\b)/i.exec(clean);
  return match ? clean.slice(match.index).trim() : "";
}

function hasGatewayStatusError(output = ""): boolean {
  return getGatewayStatusErrorText(output).length > 0;
}

function hasGatewayConnectionError(output = ""): boolean {
  if (typeof output !== "string") return false;
  const clean = stripAnsi(output);
  const statusError = getGatewayStatusErrorText(clean);
  if (
    statusError &&
    /\b(?:auth(?:entication|orization)?|unauthorized|forbidden|permission denied|credentials?|tokens?|TLS|SSL|cert(?:ificate)?|configuration|config|invalid (?:argument|option|value)|unexpected argument|unknown (?:argument|command|option)|usage)\b/i.test(
      statusError,
    )
  ) {
    return false;
  }
  // Connection phrases can also appear in successful status details. Only
  // treat them as lifecycle evidence when the status command emitted an
  // actual error line (including stderr appended by runCapture).
  return (
    statusError.length > 0 &&
    (/\bConnection refused\b/i.test(statusError) ||
      /\bNo active gateway\b/i.test(statusError) ||
      /\btcp connect error\b/i.test(statusError) ||
      /\berror trying to connect\b/i.test(statusError) ||
      /\bclient error\s*\(\s*Connect\s*\)/i.test(statusError) ||
      /\btransport error\b/i.test(statusError) ||
      /\bConnection (?:reset|aborted|closed)\b/i.test(statusError))
  );
}

export function isGatewayConnected(statusOutput = ""): boolean {
  if (typeof statusOutput !== "string") return false;
  const clean = stripAnsi(statusOutput);
  if (hasGatewayStatusError(clean) || hasGatewayConnectionError(clean)) {
    return false;
  }
  return clean.includes("Connected") || clean.includes("Server Status");
}

export function hasActiveGatewayInfo(activeGatewayInfoOutput = ""): boolean {
  return (
    typeof activeGatewayInfoOutput === "string" &&
    activeGatewayInfoOutput.includes("Gateway endpoint:") &&
    !activeGatewayInfoOutput.includes("No gateway metadata found")
  );
}

export function isSelectedGateway(statusOutput = "", gatewayName = GATEWAY_NAME): boolean {
  return getReportedGatewayName(statusOutput) === gatewayName;
}

export function isGatewayHealthy(
  statusOutput = "",
  gwInfoOutput = "",
  activeGatewayInfoOutput = "",
  gatewayName = GATEWAY_NAME,
): boolean {
  const namedGatewayKnown = hasStaleGateway(gwInfoOutput, gatewayName);
  const activeGatewayName =
    getReportedGatewayName(statusOutput) || getReportedGatewayName(activeGatewayInfoOutput);
  const connected = isGatewayConnected(statusOutput);
  const activeInfo = hasActiveGatewayInfo(activeGatewayInfoOutput);

  // Primary path: status reports connected and gateway name matches
  if (connected && activeGatewayName === gatewayName) return true;

  // Fallback: status is empty (ARM64/non-TTY) but gateway info confirms
  // the named gateway exists and has an active endpoint
  const statusEmpty =
    typeof statusOutput === "string" && stripAnsi(statusOutput).trim().length === 0;
  if (statusEmpty && namedGatewayKnown && activeInfo && activeGatewayName === gatewayName)
    return true;

  return false;
}

export function getGatewayReuseState(
  statusOutput = "",
  gwInfoOutput = "",
  activeGatewayInfoOutput = "",
  gatewayName = GATEWAY_NAME,
): GatewayReuseState {
  if (isGatewayHealthy(statusOutput, gwInfoOutput, activeGatewayInfoOutput, gatewayName)) {
    return "healthy";
  }
  const connected = isGatewayConnected(statusOutput);
  const activeGatewayName =
    getReportedGatewayName(statusOutput) || getReportedGatewayName(activeGatewayInfoOutput);
  const activeInfo = hasActiveGatewayInfo(activeGatewayInfoOutput);
  if (connected && activeGatewayName === gatewayName) {
    return "active-unnamed";
  }
  if ((connected || activeInfo) && activeGatewayName && activeGatewayName !== gatewayName) {
    return "foreign-active";
  }
  if (activeGatewayName === gatewayName && hasGatewayConnectionError(statusOutput)) {
    return "stale";
  }
  // A status-command failure such as auth, config, TLS, or CLI validation is
  // not proof that a named gateway is stale. Preserve the metadata and let the
  // later operation surface the real error instead of destructively cleaning
  // up the gateway through the metadata-only fallback below.
  if (hasGatewayStatusError(statusOutput)) {
    return "missing";
  }
  if (hasStaleGateway(gwInfoOutput, gatewayName)) {
    return "stale";
  }
  if (activeInfo) {
    return "active-unnamed";
  }
  return "missing";
}

export function shouldSelectNamedGatewayForReuse(
  statusOutput = "",
  gwInfoOutput = "",
  activeGatewayInfoOutput = "",
  gatewayName = GATEWAY_NAME,
): boolean {
  return (
    getGatewayReuseState(statusOutput, gwInfoOutput, activeGatewayInfoOutput, gatewayName) ===
      "foreign-active" && hasStaleGateway(gwInfoOutput, gatewayName)
  );
}

export function parseSandboxPhase(getOutput: string): string | null {
  if (typeof getOutput !== "string") return null;
  const clean = stripAnsi(getOutput);
  const match = clean.match(/^\s*Phase:\s+(\S+)/m);
  return match ? match[1] : null;
}

// Phases that represent a settled, non-transitional failure rather than a
// sandbox still coming up. OpenShell only reports these when it has real
// state, so a Docker-outage reclassification must NOT hide them — the user
// needs the genuine failure/rebuild guidance even during a daemon blip
// (#4428). Mirrors the terminal set used by the connect readiness loop.
export const TERMINAL_SANDBOX_PHASES = new Set<string>([
  "Failed",
  "Error",
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "Unknown",
  "Evicted",
]);

export function isTerminalSandboxPhase(phase: string | null | undefined): boolean {
  return !!phase && TERMINAL_SANDBOX_PHASES.has(phase);
}

export function getSandboxStateFromOutputs(
  sandboxName: string,
  getOutput = "",
  listOutput = "",
): SandboxState {
  if (!sandboxName) return "missing";
  if (!getOutput) return "missing";
  if (/\bNotFound\b|\bNot Found\b|sandbox not found/i.test(stripAnsi(getOutput))) {
    return "missing";
  }
  return isSandboxReady(listOutput, sandboxName) ? "ready" : "not_ready";
}
