// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime recovery helpers — classify sandbox/gateway state from CLI
 * output and determine recovery strategy.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

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
    if (cols.at(-1) !== "Ready") continue;
    names.add(cols[0]);
  }
  return names;
}
