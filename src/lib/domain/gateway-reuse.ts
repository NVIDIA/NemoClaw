// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pure classifiers for OpenShell gateway reuse observations. */

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

export function getReportedGatewayName(output = ""): string | null {
  if (typeof output !== "string") return null;
  const clean = stripAnsi(output);
  const match = clean.match(/^\s*Gateway:\s+([^\s]+)/m);
  return match ? match[1] : null;
}

/**
 * OpenShell v0.0.99 compatibility boundary: a failed `openshell status` probe
 * reports only a miette `Error:` / `client error ...` chain and no longer
 * repeats the selected gateway name. `runCapture` combines stderr and stdout
 * for this probe. OpenShell is an independently versioned external CLI, so
 * NemoClaw cannot retrofit a structured lifecycle discriminator into v0.0.99;
 * this parser limits the compatibility fallback to the producer's error suffix
 * instead of matching diagnostic text elsewhere in the output.
 *
 * Keep this contract aligned with
 * `test/fixtures/openshell-status-errors-v0.0.99.json`. Remove the text parser
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
  statusGatewayName: string | null = null,
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
  if (
    (activeGatewayName === gatewayName || statusGatewayName === gatewayName) &&
    hasGatewayConnectionError(statusOutput)
  ) {
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
