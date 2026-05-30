// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime recovery helpers — classify sandbox/gateway state from CLI
 * output and determine recovery strategy.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SANDBOX_PHASES = new Set(["Ready", "Running", "NotReady", "Provisioning", "Error"]);

function stripAnsi(text: string | null | undefined): string {
  return String(text || "").replace(ANSI_RE, "");
}

export function isOpenShellProtobufSchemaMismatch(output = ""): boolean {
  const clean = stripAnsi(output);
  return (
    /invalid wire type/i.test(clean) ||
    /proto(?:buf)?(?: decode| schema| wire)/i.test(clean)
  );
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
