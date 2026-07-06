// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SAFE_PROBE_DIAGNOSTICS = new Map<string, string>([
  ["anthropic-streaming-content-after-message-stop", "content events after message_stop"],
  ["anthropic-streaming-content-before-message-start", "content events before message_start"],
  ["anthropic-streaming-duplicate-message-start", "duplicate message_start"],
  ["anthropic-streaming-duplicate-message-stop", "duplicate message_stop"],
  ["anthropic-streaming-missing-content-block-delta", "missing content_block_delta"],
  ["anthropic-streaming-missing-message-start", "missing message_start"],
  ["anthropic-streaming-missing-message-stop", "missing message_stop"],
]);

function summarizeSafeProbeDiagnostics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const summaries = new Set<string>();
  for (const code of value) {
    if (typeof code !== "string") continue;
    const summary = SAFE_PROBE_DIAGNOSTICS.get(code);
    if (summary) summaries.add(summary);
  }
  return [...summaries];
}

function summarizeProbeFailureForDisplay(failure: Record<string, unknown>): string {
  const name = typeof failure.name === "string" ? failure.name : "probe";
  const httpStatus = typeof failure.httpStatus === "number" ? failure.httpStatus : 0;
  const curlStatus = typeof failure.curlStatus === "number" ? failure.curlStatus : 0;
  if (httpStatus > 0 && (httpStatus < 200 || httpStatus >= 300)) {
    return `${name}: HTTP ${httpStatus}`;
  }
  if (curlStatus !== 0) return `${name}: curl exit ${curlStatus}`;
  const diagnostics = summarizeSafeProbeDiagnostics(failure.diagnosticCodes);
  if (diagnostics.length > 0) return `${name}: ${diagnostics.join("; ")}`;
  if (httpStatus > 0) return `${name}: HTTP ${httpStatus}`;
  return `${name}: no HTTP response`;
}

export function summarizeProbeForDisplay(probe: {
  failures?: unknown[];
  message?: unknown;
}): string {
  const failures = Array.isArray(probe.failures)
    ? probe.failures.filter((failure): failure is Record<string, unknown> => {
        return Boolean(failure) && typeof failure === "object";
      })
    : [];
  if (failures.length > 0) return failures.map(summarizeProbeFailureForDisplay).join("; ");
  const message = typeof probe.message === "string" ? probe.message : "no probe details available";
  const httpMatch = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (httpMatch) return `HTTP ${httpMatch[1]}`;
  const curlMatch = message.match(/curl failed \(exit (-?\d+)\)/i);
  if (curlMatch) return `curl exit ${curlMatch[1]}`;
  if (/timed? out|timeout/i.test(message)) return "timeout";
  return "probe failed";
}
