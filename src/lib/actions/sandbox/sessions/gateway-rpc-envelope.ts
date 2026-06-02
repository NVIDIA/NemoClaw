// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth contract for the OpenClaw gateway RPC envelope:
//
//   - The authoritative shape is `{ "result": <payload> }` for success or
//     `{ "error": { "code"?, "message"? } }` for failure.
//   - `openclaw gateway call --json` is expected to emit a single envelope
//     line. The tolerant parser exists because the sandboxed OpenClaw runtime
//     can prepend warnings or interleave logs ahead of the envelope when
//     verbose/diagnostic flags are active (e.g. UNDICI/Node warnings on
//     stderr-merged streams, gateway debug logs in non-quiet modes).
//   - This workaround can be removed once the in-sandbox OpenClaw CLI
//     guarantees a single, exclusive JSON line on stdout for `gateway call
//     --json` and no other component writes JSON-shaped lines after the
//     envelope. Until then, only lines that match the envelope contract
//     (have a `result` or `error` key) are accepted, so an unrelated
//     trailing JSON log line cannot be mistaken for the envelope.

export interface GatewayCallSuccess<T = unknown> {
  result: T;
}

export interface GatewayCallFailure {
  error: { code?: string | number; message?: string };
}

export type GatewayCallEnvelope<T = unknown> = Partial<GatewayCallSuccess<T> & GatewayCallFailure>;

function hasEnvelopeShape(value: unknown): value is GatewayCallEnvelope<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "result" in value || "error" in value;
}

export function parseGatewayCallEnvelope<T = unknown>(
  output: string,
): GatewayCallEnvelope<T> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (hasEnvelopeShape(parsed)) return parsed as GatewayCallEnvelope<T>;
    } catch {
      continue;
    }
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (hasEnvelopeShape(parsed)) return parsed as GatewayCallEnvelope<T>;
  } catch {
    return null;
  }
  return null;
}
