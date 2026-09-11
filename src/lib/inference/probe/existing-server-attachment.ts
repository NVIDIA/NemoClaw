// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared helpers for attaching operator-run servers on a fixed loopback port. */

import type { CurlProbeResult } from "../../adapters/http/probe";

export const ATTACHMENT_MAX_PROBE_RESPONSE_BYTES = 256 * 1024;

const MAX_SERVED_MODEL_REFERENCE_BYTES = 256;

export type BoundedProbeFailureReason = "oversized-response" | "probe-timeout";

/** A served model id may contain namespaces and tags, but never a filesystem path. */
export function isSafeServedModelReference(value: string): boolean {
  const reference = value.trim();
  if (!reference || reference !== value) return false;
  if (Buffer.byteLength(reference, "utf8") > MAX_SERVED_MODEL_REFERENCE_BYTES) return false;
  if (!/^[A-Za-z0-9._:/-]+$/.test(reference)) return false;
  if (/^(?:file:|[A-Za-z]:[\\/]|[./~]|\\\\)/i.test(reference)) return false;
  if (reference.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return !/\.gguf$/i.test(reference);
}

export function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function isAuthenticationStatus(httpStatus: number): boolean {
  return httpStatus === 401 || httpStatus === 403;
}

export function attachmentProbeArgs(authArgs: readonly string[], url: string): string[] {
  return [
    "-sS",
    "--connect-timeout",
    "2",
    "--max-time",
    "5",
    "--max-filesize",
    String(ATTACHMENT_MAX_PROBE_RESPONSE_BYTES),
    ...authArgs,
    url,
  ];
}

/** Map curl's size-cap and timeout exits to a failure, or null for any other outcome. */
export function boundedProbeFailure(
  result: CurlProbeResult,
  label: string,
): { reason: BoundedProbeFailureReason; message: string } | null {
  if (result.curlStatus === 63) {
    return {
      reason: "oversized-response",
      message: `A ${label} fingerprint response exceeded the 256 KiB probe limit.`,
    };
  }
  if (result.curlStatus === 28) {
    return {
      reason: "probe-timeout",
      message: `A ${label} fingerprint probe exceeded its time limit.`,
    };
  }
  return null;
}

/** Accept only `http://<loopback>:<port>` with no credentials, path, query, or fragment. */
export function resolveFixedLoopbackOrigin(value: string, port: number): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
    parsed.port !== String(port) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  return parsed.origin;
}
