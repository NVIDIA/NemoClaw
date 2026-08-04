// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  extractDeniedEndpoint,
  isPolicyDenialLine,
} from "../actions/sandbox/exec-policy-hint-detection";
import { parseLineTimestamp } from "../domain/sandbox/logs";
import type { ManagedTransportFailure } from "./managed-transport";

export const DEFAULT_CORRELATION_WINDOW_MS = 5_000;

export interface CorrelatedAuditLine {
  line: string;
  timestampMs: number;
  policyDenial: boolean;
  endpoint: string | null;
}

export interface ManagedTransportCorrelation {
  traceId: string;
  target?: string;
  windowMs: number;
  failedAtMs: number;
  lines: CorrelatedAuditLine[];
  sharedIdentifier: false;
}

/**
 * Interim endpoint-and-time correlation between an application-side failure and
 * the sandbox audit stream. OpenShell carries no request-scoped correlation
 * identifier, so `sharedIdentifier` stays false until NVIDIA/OpenShell#2508
 * lands one.
 */
export function correlateManagedTransportFailure(
  failure: ManagedTransportFailure,
  auditLog: string,
  failedAtMs: number,
  windowMs: number = DEFAULT_CORRELATION_WINDOW_MS,
): ManagedTransportCorrelation {
  const lines: CorrelatedAuditLine[] = [];
  const earliest = failedAtMs - windowMs;
  const latest = failedAtMs + windowMs;
  for (const line of auditLog.split("\n")) {
    if (line.trim().length === 0) continue;
    const timestampMs = parseLineTimestamp(line);
    if (timestampMs === null || timestampMs < earliest || timestampMs > latest) continue;
    const endpoint = extractDeniedEndpoint(line);
    if (failure.target && endpoint && endpoint !== failure.target) continue;
    if (failure.target && !endpoint && !line.includes(failure.target)) continue;
    lines.push({
      line,
      timestampMs,
      policyDenial: isPolicyDenialLine(line),
      endpoint,
    });
  }
  lines.sort((left, right) => left.timestampMs - right.timestampMs);
  const correlation: ManagedTransportCorrelation = {
    traceId: failure.traceId,
    windowMs,
    failedAtMs,
    lines,
    sharedIdentifier: false,
  };
  if (failure.target) correlation.target = failure.target;
  return correlation;
}

export function formatManagedTransportCorrelation(
  correlation: ManagedTransportCorrelation,
): string {
  const header = [
    `trace_id=${correlation.traceId}`,
    correlation.target ? `target=${correlation.target}` : null,
    `window_ms=${correlation.windowMs}`,
    `matched_audit_lines=${correlation.lines.length}`,
    "correlation=endpoint_and_time",
  ].filter((entry): entry is string => entry !== null);
  if (correlation.lines.length === 0) {
    return [...header, "no sandbox audit line matched this failure window"].join("\n");
  }
  return [...header, ...correlation.lines.map((entry) => entry.line)].join("\n");
}
