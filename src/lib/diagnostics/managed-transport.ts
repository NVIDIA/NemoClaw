// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { sanitizeTraceAttributes } from "../trace";

/**
 * Failure-only diagnostic contract for managed outbound transports.
 *
 * A consumer that owns a managed HTTP or socket boundary builds one
 * ManagedTransportFailure per failed operation and emits it through
 * emitManagedTransportFailure. Every field is copied through an allowlist:
 * authorization material, cookies, tokens, query strings, request bodies,
 * and application session identifiers never reach the event. Successful
 * traffic emits nothing.
 */

/** The event name shared with OpenShell audit correlation. */
export const MANAGED_TRANSPORT_FAILURE_EVENT = "managed_transport_failure";

/** The transport phase that failed, in connection order. */
export type ManagedTransportPhase =
  | "policy"
  | "proxy_connect"
  | "tls"
  | "app_connect"
  | "request"
  | "response_headers"
  | "response_stream";

/** One sanitized entry of a transport error-cause chain. */
export interface SafeTransportCause {
  name?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  port?: number;
}

/** The redacted, structured record of one failed managed-transport operation. */
export interface ManagedTransportFailure {
  consumer: string;
  operation: string;
  route: string;
  phase: ManagedTransportPhase;
  traceId: string;
  elapsedMs: number;
  proxy?: string;
  target?: string;
  httpStatus?: number;
  causeCode?: string;
  causeChain: SafeTransportCause[];
  responseServer?: string;
  responseVia?: string;
  xRequestId?: string;
  xEnvoyResponseFlags?: string;
  /** Whether an opaque application session identifier was present; never its value. */
  sessionIdPresent?: boolean;
  errorBodySnippet?: string;
}

/** Generates a correlation identifier safe to share across process boundaries. */
export function generateTransportTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** Strips credentials, query string, and fragment from a URL-shaped value, keeping host:port/path. */
export function safeTargetRef(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return `${url.hostname}:${port}${url.pathname}`;
    } catch {
      // fall through to the plain-string stripping below
    }
  }
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? "";
  return withoutQuery.replace(/^[^@]*@/, "");
}

const MAX_CAUSE_DEPTH = 8;

/**
 * Walks an error's cause chain and keeps only fields that cannot carry
 * request content or credentials. Free-text messages are deliberately
 * dropped: undici and Node network errors embed URLs and header values.
 */
export function safeCauseChain(error: unknown): SafeTransportCause[] {
  const chain: SafeTransportCause[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (chain.length >= MAX_CAUSE_DEPTH) break;
    const record = current as Record<string, unknown>;
    const entry: SafeTransportCause = {};
    if (typeof record.name === "string") entry.name = record.name;
    if (typeof record.code === "string") entry.code = record.code;
    if (typeof record.errno === "number") entry.errno = record.errno;
    if (typeof record.syscall === "string") entry.syscall = record.syscall;
    if (typeof record.port === "number") entry.port = record.port;
    if (Object.keys(entry).length > 0) chain.push(entry);
    current = record.cause;
  }
  return chain;
}

/** Picks the diagnostic response headers the contract allows, dropping everything else. */
export function pickSafeResponseHeaders(
  headers: Iterable<[string, string]>,
): Pick<
  ManagedTransportFailure,
  "responseServer" | "responseVia" | "xRequestId" | "xEnvoyResponseFlags"
> {
  const picked: ReturnType<typeof pickSafeResponseHeaders> = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (name === "server") picked.responseServer = value;
    else if (name === "via") picked.responseVia = value;
    else if (name === "x-request-id") picked.xRequestId = value;
    else if (name === "x-envoy-response-flags") picked.xEnvoyResponseFlags = value;
  }
  return picked;
}

const MAX_ERROR_BODY_SNIPPET = 512;
const TEXTUAL_BODY_TYPES = /^(?:text\/|application\/(?:json|problem\+json)\b)/;

/**
 * Bounds a non-2xx error body to a short redacted snippet. Non-textual
 * content types yield nothing, and the caller must pass an already-consumed
 * copy so streaming consumption stays untouched.
 */
export function boundedErrorBodySnippet(
  body: string,
  contentType: string | undefined,
): string | undefined {
  if (!contentType || !TEXTUAL_BODY_TYPES.test(contentType)) return undefined;
  const bounded = body.slice(0, MAX_ERROR_BODY_SNIPPET);
  const sanitized = sanitizeTraceAttributes({ body: bounded }).body;
  return typeof sanitized === "string" ? sanitized : undefined;
}

/** Maps a sanitized cause code and HTTP outcome onto the failing phase. */
export function classifyTransportPhase(input: {
  policyDenied?: boolean;
  causeCode?: string;
  tlsFailure?: boolean;
  httpStatus?: number;
  streamInterrupted?: boolean;
}): ManagedTransportPhase {
  if (input.policyDenied) return "policy";
  if (input.tlsFailure) return "tls";
  const code = input.causeCode ?? "";
  if (
    /^(?:UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)$/.test(
      code,
    )
  ) {
    return "app_connect";
  }
  if (/CERT|TLS|SSL/.test(code)) return "tls";
  if (input.streamInterrupted) return "response_stream";
  if (input.httpStatus !== undefined) return "response_headers";
  if (/^(?:UND_ERR_SOCKET|ECONNRESET|EPIPE|UND_ERR_HEADERS_TIMEOUT)$/.test(code)) {
    return "response_headers";
  }
  if (/^(?:UND_ERR_BODY_TIMEOUT|UND_ERR_ABORTED)$/.test(code)) return "response_stream";
  return "request";
}

/** Builder input: unsanitized operational context plus the raw error. */
export interface ManagedTransportFailureInput {
  consumer: string;
  operation: string;
  route: string;
  phase: ManagedTransportPhase;
  elapsedMs: number;
  traceId?: string;
  proxy?: string;
  target?: string;
  httpStatus?: number;
  error?: unknown;
  responseHeaders?: Iterable<[string, string]>;
  sessionIdPresent?: boolean;
  errorBody?: { body: string; contentType?: string };
}

/**
 * Builds the redacted event from operational context. Only allowlisted
 * fields are copied; proxy and target lose credentials and query strings,
 * and the error contributes nothing beyond its safe cause chain.
 */
export function buildManagedTransportFailure(
  input: ManagedTransportFailureInput,
): ManagedTransportFailure {
  const causeChain = safeCauseChain(input.error);
  return {
    consumer: input.consumer,
    operation: input.operation,
    route: input.route,
    phase: input.phase,
    traceId: input.traceId ?? generateTransportTraceId(),
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    ...(input.proxy === undefined ? {} : { proxy: safeTargetRef(input.proxy) }),
    ...(input.target === undefined ? {} : { target: safeTargetRef(input.target) }),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(causeChain[0]?.code === undefined ? {} : { causeCode: causeChain[0].code }),
    causeChain,
    ...(input.responseHeaders === undefined ? {} : pickSafeResponseHeaders(input.responseHeaders)),
    ...(input.sessionIdPresent === undefined ? {} : { sessionIdPresent: input.sessionIdPresent }),
    ...(input.errorBody === undefined
      ? {}
      : (() => {
          const snippet = boundedErrorBodySnippet(
            input.errorBody.body,
            input.errorBody.contentType,
          );
          return snippet === undefined ? {} : { errorBodySnippet: snippet };
        })()),
  };
}

/**
 * Formats the event as stable key=value lines under the shared event name
 * and hands it to write; stderr by default. Consumers call this on failure
 * only.
 */
export function emitManagedTransportFailure(
  event: ManagedTransportFailure,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  const pairs: string[] = [MANAGED_TRANSPORT_FAILURE_EVENT];
  const push = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) pairs.push(`${key}=${value}`);
  };
  push("consumer", event.consumer);
  push("operation", event.operation);
  push("route", event.route);
  push("proxy", event.proxy);
  push("target", event.target);
  push("phase", event.phase);
  push("http_status", event.httpStatus);
  push("elapsed_ms", event.elapsedMs);
  push("cause_code", event.causeCode);
  push("response_server", event.responseServer);
  push("response_via", event.responseVia);
  push("x_request_id", event.xRequestId);
  push("x_envoy_response_flags", event.xEnvoyResponseFlags);
  push("session_id_present", event.sessionIdPresent);
  push("trace_id", event.traceId);
  write(pairs.join(" "));
  if (event.causeChain.length > 0) {
    const chain = event.causeChain
      .map((cause) =>
        [cause.name, cause.code, cause.syscall, cause.errno, cause.port]
          .filter((part) => part !== undefined)
          .join("/"),
      )
      .join(" -> ");
    write(`${MANAGED_TRANSPORT_FAILURE_EVENT} trace_id=${event.traceId} cause_chain=${chain}`);
  }
  if (event.errorBodySnippet !== undefined) {
    write(
      `${MANAGED_TRANSPORT_FAILURE_EVENT} trace_id=${event.traceId} error_body=${JSON.stringify(event.errorBodySnippet)}`,
    );
  }
}
