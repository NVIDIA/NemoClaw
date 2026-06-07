// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth contract for OpenClaw `gateway call --json` responses:
//
//   - The CLI emits the handler's raw return value, not a JSON-RPC envelope.
//     `sessions.reset` and `sessions.delete` success payloads have the shape
//     `{ "ok": true, "key": ..., "entry"?: ... }`; failure payloads have the
//     shape `{ "ok": false, "error": { "code"?, "message"? } }` or a bare
//     `{ "error": { ... } }` for transport-level failures.
//   - The parser is tolerant about leading log noise (UNDICI/Node warnings,
//     gateway debug lines on stderr-merged streams, pretty-printed debug
//     objects emitted before the payload) and is otherwise format-preserving:
//     it returns the parsed object directly so callers can match on `ok` and
//     `error` without an intermediate rewrite step.

export interface GatewayCallPayload {
  ok?: boolean;
  error?: { code?: string | number; message?: string };
}

function looksLikeGatewayPayload(value: unknown): value is GatewayCallPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "ok" in (value as Record<string, unknown>) || "error" in (value as Record<string, unknown>);
}

export function parseGatewayCallPayload<T extends GatewayCallPayload = GatewayCallPayload>(
  output: string,
): T | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  // 1. Single-line JSON candidates in reverse order — robust to log noise
  //    that precedes a one-line payload.
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      candidates.push(candidate);
    }
  }
  // 2. Whole-output parse for pretty-printed multi-line JSON with no prefix.
  candidates.push(trimmed);
  // 3. Multi-line `{...}` blocks embedded in surrounding noise. Enumerate
  //    every (`{` start, `}` end) pairing so an unrelated pretty-printed
  //    debug block before or after the real payload cannot fool the scan.
  const lines = trimmed.split(/\r?\n/);
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start]?.trim() !== "{") continue;
    for (let end = lines.length - 1; end > start; end -= 1) {
      if (lines[end]?.trim() !== "}") continue;
      candidates.push(lines.slice(start, end + 1).join("\n"));
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (looksLikeGatewayPayload(parsed)) return parsed as T;
    } catch {
      // try next candidate
    }
  }
  return null;
}
