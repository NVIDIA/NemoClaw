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
const PROXY_HTTP_DENIAL_DETAIL_RE =
  /^([A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}) (\[[^\]\s]+\]:\d{1,5}|[^\s:]+:\d{1,5})(\/\S{0,2047}) (.+)$/;
const SAFE_PROXY_PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,2047}$/;
const SAFE_DYNAMIC_PROXY_REASON_RE = /^[\x20-\x7e]{1,512}$/;
const MAX_STRUCTURED_PROXY_LINE_LENGTH = 4096;
const MAX_STRUCTURED_PROXY_DETAIL_LENGTH = 1024;

function isStructuredL7PolicyDenialReason(method: string, path: string, reason: string): boolean {
  if (
    reason === `${method} ${path} not permitted by policy` ||
    reason === `${method} ${path} blocked by deny rule`
  ) {
    return true;
  }
  if (
    reason === "GraphQL persisted query is not registered" ||
    reason === "GraphQL operation blocked by endpoint policy" ||
    reason === "GraphQL operation not permitted by policy" ||
    reason === "JSON-RPC response frames are not permitted from client to server" ||
    reason === "request denied by policy"
  ) {
    return true;
  }
  const dynamicPrefixes = [
    "GraphQL request rejected: ",
    "JSON-RPC request rejected: ",
    "L7 evaluation error: ",
  ];
  const prefix = dynamicPrefixes.find((candidate) => reason.startsWith(candidate));
  return Boolean(prefix && SAFE_DYNAMIC_PROXY_REASON_RE.test(reason.slice(prefix.length)));
}

function isStructuredForwardProxyPolicyDenial(detail: string): boolean {
  const forward = detail.match(PROXY_HTTP_DENIAL_DETAIL_RE);
  if (!forward) return false;
  const [, method, endpoint, path, suffix] = forward;
  if (!isSafeEndpoint(endpoint) || !SAFE_PROXY_PATH_RE.test(path)) {
    return false;
  }
  if (suffix === "not permitted by policy" || suffix === "did not match an L7 endpoint path") {
    return true;
  }
  const reasonPrefix = "denied by L7 policy: ";
  if (!suffix.startsWith(reasonPrefix)) return false;
  return isStructuredL7PolicyDenialReason(method, path, suffix.slice(reasonPrefix.length));
}

function isStructuredProxyPolicyDenialDetail(detail: string): boolean {
  if (detail.length > MAX_STRUCTURED_PROXY_DETAIL_LENGTH) return false;
  const connect = detail.match(PROXY_DENIAL_DETAIL_RE);
  if (connect) return isSafeEndpoint(connect[1]);
  return isStructuredForwardProxyPolicyDenial(detail);
}

// Source-of-truth for structured proxy JSON:
// - Invalid state: OpenShell reports some policy refusals only in structured
//   CONNECT or forward-HTTP 403 JSON while the child tool receives opaque text.
// - Source boundary/fix constraint: the payload is emitted by the external
//   OpenShell proxy, so NemoClaw can only translate it after exec returns.
//   curl may interleave that response body with its own stderr text, so extract
//   one complete JSON object without trusting surrounding output.
// - Regression coverage: prefixed, suffixed, unprefixed, malformed, and
//   near-miss JSON payloads live in exec-policy-hint-detection.test.ts.
// - Removal condition: delete this fallback when OpenShell provides a typed
//   exec-denial result. Until then, require both the exact error code and the
//   complete safely bounded CONNECT or forward-HTTP detail so unrelated JSON
//   cannot match. The forward forms mirror OpenShell v0.0.85's endpoint, path,
//   and L7 policy denial messages.
function firstJsonObject(line: string): string | null {
  const start = line.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return line.slice(start, index + 1);
    }
  }
  return null;
}

function isStructuredJsonPolicyDenial(line: string): boolean {
  if (line.length > MAX_STRUCTURED_PROXY_LINE_LENGTH) return false;
  const jsonObject = firstJsonObject(line);
  if (jsonObject === null) return false;
  try {
    const parsed: unknown = JSON.parse(jsonObject);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const payload = parsed as Record<string, unknown>;
    const keys = Object.keys(payload);
    if (keys.length !== 2 || !keys.includes("detail") || !keys.includes("error")) return false;
    if (payload.error !== "policy_denied" || typeof payload.detail !== "string") return false;
    return isStructuredProxyPolicyDenialDetail(payload.detail);
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
