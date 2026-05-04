// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime recovery helpers — classify sandbox/gateway state from CLI
 * output and determine recovery strategy.
 */

import { loadSession } from "./onboard-session";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string | null | undefined): string {
  return String(text || "").replace(ANSI_RE, "");
}

export interface StateClassification {
  state: string;
  reason: string;
}

export function parseLiveSandboxNames(listOutput = ""): Set<string> {
  const clean = stripAnsi(listOutput);
  const names = new Set<string>();
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(NAME|No sandboxes found\.?$)/i.test(line)) continue;
    if (/^Error:/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols[0]) {
      names.add(cols[0]);
    }
  }
  return names;
}

export function classifySandboxLookup(output = ""): StateClassification {
  const clean = stripAnsi(output).trim();
  if (!clean) {
    return { state: "missing", reason: "empty" };
  }
  if (/sandbox not found|status:\s*NotFound/i.test(clean)) {
    return { state: "missing", reason: "not_found" };
  }
  if (
    /transport error|client error|Connection reset by peer|Connection refused|No active gateway|Gateway: .*Error/i.test(
      clean,
    )
  ) {
    return { state: "unavailable", reason: "gateway_unavailable" };
  }
  return { state: "present", reason: "ok" };
}

export function classifyGatewayStatus(output = ""): StateClassification {
  const clean = stripAnsi(output).trim();
  if (!clean) {
    return { state: "inactive", reason: "empty" };
  }
  if (
    /No active gateway|transport error|client error|Connection reset by peer|Connection refused|Gateway: .*Error/i.test(
      clean,
    )
  ) {
    return { state: "unavailable", reason: "gateway_unavailable" };
  }
  if (/^\s*(?:Status:\s*)?Connected\s*$/im.test(clean)) {
    return { state: "connected", reason: "ok" };
  }
  return { state: "inactive", reason: "not_connected" };
}

export function shouldAttemptGatewayRecovery({
  sandboxState = "missing",
  gatewayState = "inactive",
} = {}): boolean {
  return sandboxState === "unavailable" && gatewayState !== "connected";
}

export function getRecoveryCommand(): string {
  const session = loadSession();
  if (session && session.resumable !== false) {
    return "nemoclaw onboard --resume";
  }
  return "nemoclaw onboard";
}
