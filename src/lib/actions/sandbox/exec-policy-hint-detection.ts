// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseLineTimestamp } from "../../domain/sandbox/logs";

// A denied endpoint is a bare `host:port` (or `ip:port`) target from a CONNECT
// audit event, never secret material. This allowlist bounds what may be echoed
// into terminal/CI logs. Anything else falls back to a generic message.
const SAFE_ENDPOINT_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*:\d{1,5}$/;
const SAFE_IPV6_ENDPOINT_RE = /^\[[0-9A-Fa-f:.]{2,45}\]:\d{1,5}$/;
const MAX_DNS_HOST_LENGTH = 253;
const MAX_NETWORK_PORT = 65_535;

function isSafeEndpoint(candidate: string): boolean {
  const separator = candidate.lastIndexOf(":");
  if (separator === -1) return false;
  const port = Number(candidate.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > MAX_NETWORK_PORT) return false;
  if (SAFE_IPV6_ENDPOINT_RE.test(candidate)) return true;
  if (!SAFE_ENDPOINT_RE.test(candidate)) return false;
  return candidate.slice(0, separator).length <= MAX_DNS_HOST_LENGTH;
}

// Require DENIED in the OCSF decision slot. This rejects allowed events whose
// unrelated metadata happens to contain the word DENIED.
const OCSF_NETWORK_DENIAL_RE = /\bNET:OPEN\b\]?(?:\s+\[[^\]\r\n]*\])*\s+DENIED(?=\s|$)/;
const PROXY_DENIAL_DETAIL_RE =
  /^CONNECT\s+(\[[^\]\s]+\]:\d{1,5}|[^\s:]+:\d{1,5})\s+not\s+(?:allowed|permitted)\s+by\s+(?:any\s+)?policy$/i;

// Source-of-truth for structured proxy JSON:
// - Invalid state: OpenShell reports the policy refusal only in its CONNECT 403
//   JSON while the child tool receives opaque protocol text.
// - Source boundary/fix constraint: the payload is emitted by the external
//   OpenShell proxy, so NemoClaw can only translate it after exec returns.
// - Regression coverage: prefixed, unprefixed, malformed, and near-miss JSON
//   payloads live in exec-policy-hint-detection.test.ts.
// - Removal condition: delete this fallback when OpenShell provides a typed
//   exec-denial result. Until then, require both the exact error code and the
//   complete safely bounded CONNECT detail so unrelated JSON cannot match.
function isStructuredJsonPolicyDenial(line: string): boolean {
  const jsonStart = line.indexOf("{");
  if (jsonStart === -1) return false;
  try {
    const parsed: unknown = JSON.parse(line.slice(jsonStart));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const payload = parsed as Record<string, unknown>;
    if (payload.error !== "policy_denied" || typeof payload.detail !== "string") return false;
    const detail = payload.detail.match(PROXY_DENIAL_DETAIL_RE);
    return Boolean(detail && isSafeEndpoint(detail[1]));
  } catch {
    return false;
  }
}

/**
 * @internal Temporary structured-log detector for the exec breadcrumb.
 *
 * Matches only the structured OpenShell OCSF decision or an exact proxy JSON
 * error. Loose policy prose and config keys are ignored so an unrelated failed
 * exec cannot inherit a misleading breadcrumb.
 */
export function isPolicyDenialLine(line: string): boolean {
  if (OCSF_NETWORK_DENIAL_RE.test(line)) return true;
  return isStructuredJsonPolicyDenial(line);
}

const LEADING_EPOCH_TIMESTAMP_RE = /^\s*\[\d+(?:\.\d+)?\]\s*/;
const LEADING_ISO_TIMESTAMP_RE =
  /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*/;

/**
 * Extract the denied `host:port`, preferring the NET:OPEN arrow target.
 * Returns null when no candidate passes the terminal-output allowlist.
 */
export function extractDeniedEndpoint(line: string): string | null {
  const candidates: string[] = [];
  const arrow = line.match(/->\s*(\[[^\]\s]+\]:\d{1,5}|[^\s\]]+:\d{1,5})(?:\b|$)/);
  if (arrow) candidates.push(arrow[1]);
  const withoutTimestamp = line
    .replace(LEADING_EPOCH_TIMESTAMP_RE, "")
    .replace(LEADING_ISO_TIMESTAMP_RE, "");
  const genericIpv6 = withoutTimestamp.match(/\[[0-9A-Fa-f:.]+\]:\d{1,5}/);
  if (genericIpv6) candidates.push(genericIpv6[0]);
  const generic = withoutTimestamp.match(/\b([a-zA-Z0-9.-]+:\d{1,5})\b/);
  if (generic) candidates.push(generic[1]);
  for (const candidate of candidates) {
    if (isSafeEndpoint(candidate)) return candidate;
  }
  return null;
}

export type PolicyDenialMatch = { endpoint: string | null };

// Source-of-truth for timestamp correlation:
// - Invalid state: a prior command's denial must not be attributed to the
//   current failed exec.
// - Source boundary/fix constraint: OpenShell owns the audit timestamp while
//   NemoClaw owns the pre-dispatch cutoff; both share the host kernel clock.
// - Precision rule: +999 ms is the exact representation bound of a timestamp
//   without fractional seconds, not a measured skew or tuning heuristic.
//   Millisecond timestamps therefore use zero backward tolerance.
// - Evidence/coverage: restricted-sandbox curl, Python, and git validation for
//   this change recorded denials after dispatch; tests pin exact, 1 ms-stale,
//   and both second-precision boundary cases.
// - Removal condition: remove this compensation if OpenShell guarantees
//   millisecond timestamps or returns a typed denial for this exec.
const SECOND_PRECISION_EPOCH_RE = /^\s*\[\d+\]/;
const SECOND_PRECISION_ISO_RE =
  /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?(?!\.\d)/;

function latestPossibleTimestampMs(line: string, timestamp: number): number {
  const secondPrecise = SECOND_PRECISION_EPOCH_RE.test(line) || SECOND_PRECISION_ISO_RE.test(line);
  return secondPrecise ? timestamp + 999 : timestamp;
}

/**
 * Find the last policy denial that could have occurred at or after command
 * dispatch. There is no arbitrary backward tolerance: the child must spawn and
 * request egress after NemoClaw records the shared-clock cutoff.
 */
export function findRecentPolicyDenial(
  logOutput: string,
  commandStartedAtMs: number,
): PolicyDenialMatch | null {
  let match: PolicyDenialMatch | null = null;
  for (const line of logOutput.split(/\r?\n/)) {
    if (!isPolicyDenialLine(line)) continue;
    const timestamp = parseLineTimestamp(line);
    if (timestamp === null || latestPossibleTimestampMs(line, timestamp) < commandStartedAtMs) {
      continue;
    }
    match = { endpoint: extractDeniedEndpoint(line) };
  }
  return match;
}
