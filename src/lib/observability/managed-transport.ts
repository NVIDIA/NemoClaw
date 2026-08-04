// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { isSafeEndpoint } from "../actions/sandbox/exec-policy-hint-detection";
import { redactSensitiveText } from "../security/redact";

export const MANAGED_TRANSPORT_FAILURE_EVENT = "managed_transport_failure";

export type ManagedTransportPhase =
  | "policy"
  | "connect"
  | "tls"
  | "app_connect"
  | "request"
  | "response_headers"
  | "response_stream";

export type ManagedTransportRoute = "trusted_env_proxy" | "direct" | "unknown";

export interface ManagedTransportCause {
  name?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  family?: number;
  port?: number;
  message?: string;
}

export interface ManagedTransportFailure {
  event: typeof MANAGED_TRANSPORT_FAILURE_EVENT;
  consumer: string;
  operation?: string;
  route: ManagedTransportRoute;
  proxy?: string;
  target?: string;
  phase: ManagedTransportPhase;
  httpStatus?: number;
  elapsedMs?: number;
  causeCode?: string;
  causeChain: ManagedTransportCause[];
  responseHeaders: Record<string, string>;
  errorBody?: string;
  sessionPresent: boolean;
  traceId: string;
}

const MAX_CAUSE_DEPTH = 8;
const MAX_CAUSE_MESSAGE_LENGTH = 240;
const MAX_HEADER_VALUE_LENGTH = 256;
const MAX_ERROR_BODY_LENGTH = 2048;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

const SAFE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "retry-after",
  "server",
  "via",
  "x-envoy-attempt-count",
  "x-envoy-decorator-operation",
  "x-envoy-response-flags",
  "x-envoy-upstream-service-time",
  "x-request-id",
]);

const ERROR_BODY_CONTENT_TYPES = [
  "application/json",
  "application/problem+json",
  "text/html",
  "text/plain",
];

const TLS_CAUSE_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EPROTO",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const APP_CONNECT_CAUSE_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const POLICY_DENIAL_TEXT_RE =
  /\b(?:not permitted by policy|not allowed by (?:any )?policy|blocked by deny rule|denied by L7 policy|request denied by policy)\b/i;
const CONNECT_TUNNEL_TEXT_RE = /CONNECT tunnel failed/i;
const CONNECT_DENIED_STATUS_RE = /CONNECT tunnel failed,\s*response (?:403|407)/i;

export function newManagedTransportTraceId(): string {
  return randomBytes(16).toString("hex");
}

const SESSION_IDENTIFIER_RE =
  /\b((?:mcp[-_ ]?)?session[-_ ]?id)\b["']?\s*[:=]?\s*["']?[A-Za-z0-9._~-]{4,}/gi;

export function redactSessionIdentifiers(value: string): string {
  return value.replace(SESSION_IDENTIFIER_RE, "$1 <REDACTED>");
}

function safeMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const redacted = redactSensitiveText(redactSessionIdentifiers(value));
  if (!redacted) return undefined;
  return redacted.slice(0, MAX_CAUSE_MESSAGE_LENGTH);
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
}

function safeInteger(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return Math.abs(value) <= max ? value : undefined;
}

export function describeErrorCauseChain(error: unknown): ManagedTransportCause[] {
  const chain: ManagedTransportCause[] = [];
  const seen = new WeakSet<object>();
  let current = error;
  while (current && typeof current === "object" && chain.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    const entry = current as Record<string, unknown>;
    const cause: ManagedTransportCause = {};
    const name = safeCode(entry.name);
    if (name) cause.name = name;
    const code = safeCode(entry.code);
    if (code) cause.code = code;
    const errno = safeInteger(entry.errno, 4_294_967_295);
    if (errno !== undefined) cause.errno = errno;
    const syscall = safeCode(entry.syscall);
    if (syscall) cause.syscall = syscall;
    const family = safeInteger(entry.family, 255);
    if (family !== undefined) cause.family = family;
    const port = safeInteger(entry.port, 65_535);
    if (port !== undefined) cause.port = port;
    const message = safeMessage(entry.message);
    if (message) cause.message = message;
    if (Object.keys(cause).length > 0) chain.push(cause);
    current = entry.cause;
  }
  return chain;
}

export function collectSafeResponseHeaders(
  headers: Iterable<[string, string]> | Record<string, string | string[] | undefined> | null,
): Record<string, string> {
  const safe: Record<string, string> = {};
  if (!headers) return safe;
  const entries: Array<[string, string | string[] | undefined]> =
    Symbol.iterator in Object(headers)
      ? [...(headers as Iterable<[string, string]>)]
      : Object.entries(headers as Record<string, string | string[] | undefined>);
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(name)) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    if (typeof value !== "string" || value.length === 0) continue;
    if (value.length > MAX_HEADER_VALUE_LENGTH || !PRINTABLE_ASCII_RE.test(value)) continue;
    safe[name] = value;
  }
  return safe;
}

export function captureErrorBody(
  status: number | undefined,
  contentType: string | undefined,
  body: string | undefined,
): string | undefined {
  if (status === undefined || (status >= 200 && status < 300)) return undefined;
  if (typeof body !== "string" || body.length === 0) return undefined;
  const normalized = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!ERROR_BODY_CONTENT_TYPES.includes(normalized)) return undefined;
  const bounded = redactSessionIdentifiers(body.slice(0, MAX_ERROR_BODY_LENGTH));
  return redactSensitiveText(bounded) ?? undefined;
}

export interface ManagedTransportOutcome {
  error?: unknown;
  httpStatus?: number;
  policyDenied?: boolean;
  responseHeadersReceived?: boolean;
  responseStreamStarted?: boolean;
}

function causeChainText(chain: ManagedTransportCause[]): string {
  return chain.map((cause) => `${cause.code ?? ""} ${cause.message ?? ""}`).join(" ");
}

function firstMatchingCode(
  chain: ManagedTransportCause[],
  codes: ReadonlySet<string>,
): string | undefined {
  return chain.find((cause) => cause.code && codes.has(cause.code))?.code;
}

export function classifyManagedTransportPhase(
  outcome: ManagedTransportOutcome,
  chain: ManagedTransportCause[] = describeErrorCauseChain(outcome.error),
): ManagedTransportPhase {
  const text = causeChainText(chain);
  if (outcome.policyDenied === true) return "policy";
  if (POLICY_DENIAL_TEXT_RE.test(text) || CONNECT_DENIED_STATUS_RE.test(text)) return "policy";
  if (CONNECT_TUNNEL_TEXT_RE.test(text)) return "connect";
  if (firstMatchingCode(chain, TLS_CAUSE_CODES)) return "tls";
  if (firstMatchingCode(chain, APP_CONNECT_CAUSE_CODES)) return "app_connect";
  if (chain.some((cause) => cause.code === "UND_ERR_BODY_TIMEOUT")) return "response_stream";
  if (outcome.responseStreamStarted === true) return "response_stream";
  if (chain.some((cause) => cause.code === "UND_ERR_HEADERS_TIMEOUT")) return "response_headers";
  if (outcome.responseHeadersReceived === true || outcome.httpStatus !== undefined) {
    return "response_headers";
  }
  return "request";
}

export interface ManagedTransportFailureInput extends ManagedTransportOutcome {
  consumer: string;
  operation?: string;
  route?: ManagedTransportRoute;
  proxy?: string;
  target?: string;
  elapsedMs?: number;
  responseHeaders?:
    | Iterable<[string, string]>
    | Record<string, string | string[] | undefined>
    | null;
  errorBody?: string;
  sessionPresent?: boolean;
  traceId?: string;
}

function safeEndpoint(value: string | undefined): string | undefined {
  return value && isSafeEndpoint(value) ? value : undefined;
}

export function buildManagedTransportFailure(
  input: ManagedTransportFailureInput,
): ManagedTransportFailure {
  const causeChain = describeErrorCauseChain(input.error);
  const responseHeaders = collectSafeResponseHeaders(input.responseHeaders ?? null);
  const failure: ManagedTransportFailure = {
    event: MANAGED_TRANSPORT_FAILURE_EVENT,
    consumer: input.consumer,
    route: input.route ?? "unknown",
    phase: classifyManagedTransportPhase(input, causeChain),
    causeChain,
    responseHeaders,
    sessionPresent: input.sessionPresent === true,
    traceId: input.traceId ?? newManagedTransportTraceId(),
  };
  if (input.operation) failure.operation = input.operation;
  const proxy = safeEndpoint(input.proxy);
  if (proxy) failure.proxy = proxy;
  const target = safeEndpoint(input.target);
  if (target) failure.target = target;
  if (input.httpStatus !== undefined) failure.httpStatus = input.httpStatus;
  const elapsedMs = safeInteger(input.elapsedMs, Number.MAX_SAFE_INTEGER);
  if (elapsedMs !== undefined) failure.elapsedMs = elapsedMs;
  if (causeChain[0]?.code) failure.causeCode = causeChain[0].code;
  const errorBody = captureErrorBody(
    input.httpStatus,
    responseHeaders["content-type"],
    input.errorBody,
  );
  if (errorBody) failure.errorBody = errorBody;
  return failure;
}

export function formatManagedTransportFailure(failure: ManagedTransportFailure): string {
  const lines = [failure.event, `consumer=${failure.consumer}`];
  if (failure.operation) lines.push(`operation=${failure.operation}`);
  lines.push(`route=${failure.route}`);
  if (failure.proxy) lines.push(`proxy=${failure.proxy}`);
  if (failure.target) lines.push(`target=${failure.target}`);
  lines.push(`phase=${failure.phase}`);
  if (failure.httpStatus !== undefined) lines.push(`http_status=${failure.httpStatus}`);
  if (failure.elapsedMs !== undefined) lines.push(`elapsed_ms=${failure.elapsedMs}`);
  if (failure.causeCode) lines.push(`cause_code=${failure.causeCode}`);
  for (const [name, value] of Object.entries(failure.responseHeaders)) {
    lines.push(`${name.replaceAll("-", "_")}=${value}`);
  }
  lines.push(`session_present=${failure.sessionPresent}`);
  lines.push(`trace_id=${failure.traceId}`);
  if (failure.causeChain.length > 0) {
    lines.push(`cause_chain=${JSON.stringify(failure.causeChain)}`);
  }
  if (failure.errorBody) lines.push(`error_body=${JSON.stringify(failure.errorBody)}`);
  return lines.join("\n");
}
