// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure classifiers for OpenShell sandbox state.
 *
 * Every function here takes string output from openshell CLI commands and
 * returns a typed result — no I/O, no side effects.
 */

// Transitional compatibility for legacy callers. Pure gateway reuse decisions
// are owned by the domain layer.
export {
  getGatewayReuseState,
  getReportedGatewayName,
  hasActiveGatewayInfo,
  hasStaleGateway,
  isGatewayConnected,
  isGatewayHealthy,
  isSelectedGateway,
  shouldSelectNamedGatewayForReuse,
} from "../domain/gateway-reuse";
export type { GatewayReuseState } from "../domain/gateway-reuse";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

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

export function parseSandboxPhase(getOutput: string): string | null {
  if (typeof getOutput !== "string") return null;
  const clean = stripAnsi(getOutput);
  const match = clean.match(/^\s*Phase:\s+(\S+)/m);
  return match ? match[1] : null;
}

/** True only for the OpenShell phase that requires a lifecycle start. */
export function sandboxPhaseNeedsLifecycleStart(phase: string | null): boolean {
  return phase === "Stopped";
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
