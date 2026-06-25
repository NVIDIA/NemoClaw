// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime recovery helpers — classify sandbox/gateway state from CLI
 * output and determine recovery strategy.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SANDBOX_PHASES = new Set(["Ready", "Running", "NotReady", "Provisioning", "Error"]);
// Broader phase vocabulary for surfacing the live PHASE on #5714 recovered list
// rows. Unions the lifecycle phases above with the terminal/failure phases used
// elsewhere (see state/gateway.ts TERMINAL_SANDBOX_PHASES) plus common
// transient phases, so a recovered row reports the real phase (e.g. Failed,
// CrashLoopBackOff, Creating) instead of "unknown". Kept separate from
// SANDBOX_PHASES so parseReadySandboxNames' Ready/Running gate is unchanged.
const LIVE_SANDBOX_DISPLAY_PHASES = new Set([
  "Ready",
  "Running",
  "NotReady",
  "Provisioning",
  "Creating",
  "Pending",
  "Terminating",
  "Error",
  "Failed",
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "Unknown",
]);

function stripAnsi(text: string | null | undefined): string {
  return String(text || "").replace(ANSI_RE, "");
}

export function isOpenShellProtobufSchemaMismatch(output = ""): boolean {
  const clean = stripAnsi(output);
  return /invalid wire type/i.test(clean) || /proto(?:buf)?(?: decode| schema| wire)/i.test(clean);
}

function isNonSandboxRow(line: string, firstCol: string): boolean {
  if (firstCol === "NAME") return true;
  if (line === "No sandboxes found" || line === "No sandboxes found.") return true;
  if (/^Error:/i.test(line)) return true;
  if (isOpenShellProtobufSchemaMismatch(line)) return true;
  return false;
}

function parseSandboxListPhase(cols: string[]): string | null {
  const compactPhase = cols[1];
  if (cols.length <= 3 && SANDBOX_PHASES.has(compactPhase)) return compactPhase;
  const trailingPhase = cols.at(-1);
  return trailingPhase && SANDBOX_PHASES.has(trailingPhase) ? trailingPhase : null;
}

export function parseLiveSandboxNames(listOutput = ""): Set<string> {
  const clean = stripAnsi(listOutput);
  const names = new Set<string>();
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (!cols[0]) continue;
    if (isNonSandboxRow(line, cols[0])) continue;
    names.add(cols[0]);
  }
  return names;
}

export interface LiveSandboxEntry {
  name: string;
  phase: string | null;
}

/**
 * Parse `openshell sandbox list` rows into name + live PHASE pairs, skipping
 * headers and status/error lines. Used by #5714 list recovery to surface the
 * live phase (e.g. Ready) of a rediscovered sandbox without trusting the list
 * output for any other (e.g. agent) metadata it does not contain.
 */
export function parseLiveSandboxEntries(listOutput = ""): LiveSandboxEntry[] {
  const clean = stripAnsi(listOutput);
  const entries: LiveSandboxEntry[] = [];
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (!cols[0]) continue;
    if (isNonSandboxRow(line, cols[0])) continue;
    // Scan every column after the name for a known phase token so we read the
    // phase regardless of column layout — trailing (`NAME CREATED PHASE`),
    // compact (`NAME PHASE`), or with an age suffix (`NAME PHASE 2m ago`). The
    // first column is the name and is never a phase. Uses the broader display
    // vocabulary so terminal/transient phases (Failed, Creating, …) are kept.
    const phase = cols.slice(1).find((col) => LIVE_SANDBOX_DISPLAY_PHASES.has(col)) ?? null;
    entries.push({ name: cols[0], phase });
  }
  return entries;
}

export function parseReadySandboxNames(listOutput = ""): Set<string> {
  const clean = stripAnsi(listOutput);
  const names = new Set<string>();
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (!cols[0]) continue;
    if (isNonSandboxRow(line, cols[0])) continue;
    const phase = parseSandboxListPhase(cols);
    const isReadyOrRunning = phase === "Ready" || phase === "Running";
    if (phase === "NotReady" || !isReadyOrRunning) continue;
    names.add(cols[0]);
  }
  return names;
}
