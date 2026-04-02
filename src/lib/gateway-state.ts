// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure classifiers for OpenShell gateway and sandbox state.
 *
 * Every function here takes string output from openshell CLI commands and
 * returns a typed result — no I/O, no side effects.
 */

const GATEWAY_NAME = "nemoclaw";

// eslint-disable-next-line no-control-regex
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

/**
 * Check if a sandbox is in Ready state from `openshell sandbox list` output.
 * Strips ANSI codes and exact-matches the sandbox name in the first column.
 */
export function isSandboxReady(output: string, sandboxName: string): boolean {
  const clean = stripAnsi(output);
  return clean.split("\n").some((l) => {
    const cols = l.trim().split(/\s+/);
    return cols[0] === sandboxName && cols.includes("Ready") && !cols.includes("NotReady");
  });
}

/**
 * Determine whether stale NemoClaw gateway output indicates a previous
 * session that should be cleaned up before the port preflight check.
 */
export function hasStaleGateway(gwInfoOutput: string): boolean {
  const clean = typeof gwInfoOutput === "string" ? stripAnsi(gwInfoOutput) : "";
  return (
    clean.length > 0 &&
    clean.includes(`Gateway: ${GATEWAY_NAME}`) &&
    !clean.includes("No gateway metadata found")
  );
}

export function getReportedGatewayName(output = ""): string | null {
  if (typeof output !== "string") return null;
  const clean = stripAnsi(output);
  const match = clean.match(/^\s*Gateway:\s+([^\s]+)/m);
  return match ? match[1] : null;
}

export function isGatewayConnected(statusOutput = ""): boolean {
  return typeof statusOutput === "string" && statusOutput.includes("Connected");
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
): boolean {
  const namedGatewayKnown = hasStaleGateway(gwInfoOutput);
  if (!namedGatewayKnown || !isGatewayConnected(statusOutput)) return false;

  const activeGatewayName =
    getReportedGatewayName(statusOutput) || getReportedGatewayName(activeGatewayInfoOutput);
  return activeGatewayName === GATEWAY_NAME;
}

export function getGatewayReuseState(
  statusOutput = "",
  gwInfoOutput = "",
  activeGatewayInfoOutput = "",
): GatewayReuseState {
  if (isGatewayHealthy(statusOutput, gwInfoOutput, activeGatewayInfoOutput)) {
    return "healthy";
  }
  const connected = isGatewayConnected(statusOutput);
  const activeGatewayName =
    getReportedGatewayName(statusOutput) || getReportedGatewayName(activeGatewayInfoOutput);
  if (connected && activeGatewayName === GATEWAY_NAME) {
    return "active-unnamed";
  }
  if (connected && activeGatewayName && activeGatewayName !== GATEWAY_NAME) {
    return "foreign-active";
  }
  if (hasStaleGateway(gwInfoOutput)) {
    return "stale";
  }
  if (hasActiveGatewayInfo(activeGatewayInfoOutput)) {
    return "active-unnamed";
  }
  return "missing";
}

export function getSandboxStateFromOutputs(
  sandboxName: string,
  getOutput = "",
  listOutput = "",
): SandboxState {
  if (!sandboxName) return "missing";
  if (!getOutput) return "missing";
  return isSandboxReady(listOutput, sandboxName) ? "ready" : "not_ready";
}
