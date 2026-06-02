// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Source-of-truth contract for the OpenClaw gateway RPC response:
//
//   - The OpenClaw `gateway call --json` command emits the handler's raw
//     return value, not a JSON-RPC envelope. For `sessions.reset` and
//     `sessions.delete`, the success shape is `{ "ok": true, "key": ..., ... }`
//     and the failure shape is `{ "ok": false, "error": { ... } }` (or a
//     bare `{ "error": { ... } }` for transport-level failures). The CLI may
//     also pretty-print the payload across multiple lines.
//   - For symmetry with the JSON-RPC envelope shape that earlier versions of
//     the gateway emitted, and to keep adapter code single-shaped, the
//     parser also accepts an explicit `{ "result": ... }` / `{ "error": ... }`
//     envelope and normalises raw payloads into that shape.
//   - The tolerant parser exists because the sandboxed OpenClaw runtime can
//     prepend warnings or interleave logs ahead of the payload when
//     verbose/diagnostic flags are active (e.g. UNDICI/Node warnings on
//     stderr-merged streams, gateway debug logs in non-quiet modes), so we
//     try single-line candidates in reverse order before falling back to a
//     whole-output parse for multi-line pretty-printed JSON.

export interface GatewayCallSuccess<T = unknown> {
  result: T;
}

export interface GatewayCallFailure {
  error: { code?: string | number; message?: string };
}

export type GatewayCallEnvelope<T = unknown> = Partial<GatewayCallSuccess<T> & GatewayCallFailure>;

function normalisePayload(value: unknown): GatewayCallEnvelope<unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  // JSON-RPC envelope passes through unchanged.
  if ("result" in obj || "error" in obj) {
    if ("result" in obj) return { result: obj.result };
    const err = obj.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      return { error: err as GatewayCallFailure["error"] };
    }
    return null;
  }
  // Raw payload: `{ok: true, ...}` success or `{ok: false, error: ...}` failure.
  if (typeof obj.ok === "boolean") {
    if (obj.ok === true) return { result: obj };
    const err = obj.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      return { error: err as GatewayCallFailure["error"] };
    }
    return { error: { code: "unknown", message: "gateway returned ok=false" } };
  }
  return null;
}

export function parseGatewayCallEnvelope<T = unknown>(
  output: string,
): GatewayCallEnvelope<T> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  // First try single-line JSON candidates in reverse order. This is robust to
  // leading log noise (Node warnings, gateway debug lines) that precede a
  // compact one-line payload.
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate);
      const normalised = normalisePayload(parsed);
      if (normalised) return normalised as GatewayCallEnvelope<T>;
    } catch {
      continue;
    }
  }
  // Fall back to parsing the entire output, which catches multi-line
  // pretty-printed JSON the per-line scan necessarily skips.
  try {
    const parsed = JSON.parse(trimmed);
    const normalised = normalisePayload(parsed);
    if (normalised) return normalised as GatewayCallEnvelope<T>;
  } catch {
    // Continue to the multi-line scan below.
  }
  // Last resort: scan for a multi-line JSON block embedded in surrounding
  // noise — take from the first line that is exactly `{` to the last line
  // that is exactly `}`.
  const lines = trimmed.split(/\r?\n/);
  let blockStart = -1;
  let blockEnd = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "{") {
      blockStart = i;
      break;
    }
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.trim() === "}") {
      blockEnd = i;
      break;
    }
  }
  if (blockStart >= 0 && blockEnd > blockStart) {
    try {
      const parsed = JSON.parse(lines.slice(blockStart, blockEnd + 1).join("\n"));
      const normalised = normalisePayload(parsed);
      if (normalised) return normalised as GatewayCallEnvelope<T>;
    } catch {
      // ignore and fall through
    }
  }
  return null;
}
