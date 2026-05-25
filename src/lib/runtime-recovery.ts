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

export function parseLiveSandboxNames(listOutput = ""): Set<string> {
  const clean = stripAnsi(listOutput);
  const names = new Set<string>();
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(NAME|No sandboxes found\.?$)/i.test(line)) continue;
    if (/^Error:/i.test(line)) continue;
    if (isOpenShellProtobufSchemaMismatch(line)) continue;
    const cols = line.split(/\s+/);
    if (cols[0]) {
      names.add(cols[0]);
    }
  }
  return names;
}
