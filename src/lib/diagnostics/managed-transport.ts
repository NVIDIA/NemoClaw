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

/** The event name shared with the OpenClaw managed-transport diagnostics. */
export const MANAGED_TRANSPORT_FAILURE_EVENT = "managed_transport_failure";

/**
 * The transport phase that failed, in connection order. The first six values
 * match the documented `transport_phase` vocabulary of the OpenClaw managed
 * transport dist patch; `response_stream` extends it for consumers that
 * classify failures after response headers arrive.
 */
export type ManagedTransportPhase =
  | "policy"
  | "connect"
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
  sessionPresent?: boolean;
  errorBodySnippet?: string;
}

/** Generates a correlation identifier safe to share across process boundaries. */
export function generateTransportTraceId(): string {
  return randomBytes(16).toString("hex");
}

const TRACE_ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

/** Keeps a supplied trace id only when its shape is allowed and sanitization leaves it unchanged. */
function safeSuppliedTraceId(supplied: string | undefined): string {
  if (supplied !== undefined && TRACE_ID_SHAPE.test(supplied)) {
    const redacted = redactField(supplied);
    if (redacted === supplied) return supplied;
  }
  return generateTransportTraceId();
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
const MAX_CAUSE_TOKEN = 64;
const CAUSE_TOKEN_SHAPE = /^[A-Za-z0-9_.-]+$/;

/**
 * Constrains one copied error identifier: error names, codes, and syscalls
 * are short identifier tokens, so anything longer or carrying other
 * characters is replaced rather than propagated into a serializable event.
 */
function safeCauseToken(value: string): string {
  const bounded = value.slice(0, MAX_CAUSE_TOKEN);
  return CAUSE_TOKEN_SHAPE.test(bounded) ? bounded : "<invalid>";
}

/**
 * Walks an error's cause chain and keeps only fields that cannot carry
 * request content or credentials. Free-text messages are deliberately
 * dropped: undici and Node network errors embed URLs and header values.
 */
export function safeCauseChain(error: unknown): SafeTransportCause[] {
  const chain: SafeTransportCause[] = [];
  const seen = new Set<unknown>();
  let current = error;
  let visited = 0;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    visited < MAX_CAUSE_DEPTH
  ) {
    visited += 1;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const entry: SafeTransportCause = {};
    if (typeof record.name === "string") entry.name = safeCauseToken(record.name);
    if (typeof record.code === "string") entry.code = safeCauseToken(record.code);
    if (typeof record.errno === "number") entry.errno = record.errno;
    if (typeof record.syscall === "string") entry.syscall = safeCauseToken(record.syscall);
    if (typeof record.port === "number") entry.port = record.port;
    if (Object.keys(entry).length > 0) chain.push(entry);
    current = record.cause;
  }
  return chain;
}

/**
 * Redacts one untrusted string field through the shared trace sanitizer so a
 * credential embedded by an upstream cannot survive into the built event.
 * This runs at build time; the event object is safe to serialize or forward
 * before it ever reaches the line formatter.
 */
export function redactField(value: string): string {
  const redacted = sanitizeTraceAttributes({ value }).value;
  return typeof redacted === "string" ? redacted : "<redacted>";
}

/** Picks the diagnostic response headers the contract allows, redacting each kept value. */
export function pickSafeResponseHeaders(
  headers: Iterable<[string, string]>,
): Pick<
  ManagedTransportFailure,
  "responseServer" | "responseVia" | "xRequestId" | "xEnvoyResponseFlags"
> {
  const picked: ReturnType<typeof pickSafeResponseHeaders> = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (name === "server") picked.responseServer = redactField(value);
    else if (name === "via") picked.responseVia = redactField(value);
    else if (name === "x-request-id") picked.xRequestId = redactField(value);
    else if (name === "x-envoy-response-flags") picked.xEnvoyResponseFlags = redactField(value);
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
/**
 * Whether a status is a captured failure status. Body capture is restricted
 * to non-2xx responses, so a caller cannot attach a successful response body
 * to failure diagnostics. An absent status is not a failure status: a
 * transport error that never produced a response has no body to capture.
 */
function isErrorStatus(httpStatus: number | undefined): boolean {
  return httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300);
}

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
  proxyConnectFailure?: boolean;
  causeCode?: string;
  tlsFailure?: boolean;
  httpStatus?: number;
  streamInterrupted?: boolean;
}): ManagedTransportPhase {
  if (input.policyDenied) return "policy";
  if (input.tlsFailure) return "tls";
  if (input.proxyConnectFailure) return "connect";
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
  if (/^(?:UND_ERR_BODY_TIMEOUT|UND_ERR_ABORTED)$/.test(code)) return "response_stream";
  if (input.httpStatus !== undefined) return "response_headers";
  if (/^(?:UND_ERR_SOCKET|ECONNRESET|EPIPE|UND_ERR_HEADERS_TIMEOUT)$/.test(code)) {
    return "response_headers";
  }
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
  sessionPresent?: boolean;
  errorBody?: { body: string; contentType?: string };
}

/**
 * Builds the redacted event from operational context. Every untrusted string
 * field is redacted here so the returned object is safe to serialize or
 * forward without the line formatter: consumer, operation, route, endpoints,
 * and allowlisted headers cannot carry a credential. proxy and target also
 * lose credentials and query strings, and the error contributes nothing
 * beyond its safe cause chain. The top-level causeCode is the first cause in
 * the chain that carries a code, since wrapped errors keep the network code
 * in a nested cause.
 */
export function buildManagedTransportFailure(
  input: ManagedTransportFailureInput,
): ManagedTransportFailure {
  const causeChain = safeCauseChain(input.error);
  const causeCode = causeChain.find((cause) => cause.code !== undefined)?.code;
  return {
    consumer: redactField(input.consumer),
    operation: redactField(input.operation),
    route: redactField(input.route),
    phase: input.phase,
    traceId: safeSuppliedTraceId(input.traceId),
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    ...(input.proxy === undefined ? {} : { proxy: redactField(safeTargetRef(input.proxy)) }),
    ...(input.target === undefined ? {} : { target: redactField(safeTargetRef(input.target)) }),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(causeCode === undefined ? {} : { causeCode }),
    causeChain,
    ...(input.responseHeaders === undefined ? {} : pickSafeResponseHeaders(input.responseHeaders)),
    ...(input.sessionPresent === undefined ? {} : { sessionPresent: input.sessionPresent }),
    ...(input.errorBody === undefined || !isErrorStatus(input.httpStatus)
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

const MAX_LOG_FIELD = 256;

/**
 * Encodes one value for a single-record key=value log line. The value is
 * redacted again (defense in depth on top of the build-time redaction),
 * length-bounded to maxLength, and any value carrying a control character, whitespace,
 * quote, or `=` is JSON quoted so it cannot inject a line break or forge a
 * second field.
 */
export function encodeLogField(
  value: string | number | boolean,
  maxLength: number = MAX_LOG_FIELD,
): string {
  if (typeof value !== "string") return String(value);
  const text = redactField(value).slice(0, maxLength);
  if (/[\s="\\]|[\u0000-\u001f\u007f]/.test(text)) return JSON.stringify(text);
  return text;
}

/**
 * Formats the event as stable single-record key=value lines under the shared
 * event name and hands each to write; stderr by default. Every emitted string
 * passes through encodeLogField, including the error-body snippet, so a
 * delimiter- or credential-bearing upstream value cannot forge records or
 * leak even when the event object was constructed directly rather than by
 * buildManagedTransportFailure. Consumers call this on failure only.
 */
export function emitManagedTransportFailure(
  event: ManagedTransportFailure,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  const pairs: string[] = [MANAGED_TRANSPORT_FAILURE_EVENT];
  const push = (key: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) pairs.push(`${key}=${encodeLogField(value)}`);
  };
  // Key names shared with the OpenClaw managed transport dist patch use its
  // documented vocabulary: transport_phase and session_present, as read by
  // the MCP troubleshooting guide. trace_id stays distinct from the patch's
  // diagnostic_id, which is documented as a local, non-correlating identifier.
  push("consumer", event.consumer);
  push("operation", event.operation);
  push("route", event.route);
  push("proxy", event.proxy);
  push("target", event.target);
  push("transport_phase", event.phase);
  push("http_status", event.httpStatus);
  push("elapsed_ms", event.elapsedMs);
  push("cause_code", event.causeCode);
  push("response_server", event.responseServer);
  push("response_via", event.responseVia);
  push("x_request_id", event.xRequestId);
  push("x_envoy_response_flags", event.xEnvoyResponseFlags);
  push("session_present", event.sessionPresent);
  push("trace_id", event.traceId);
  write(pairs.join(" "));
  if (event.causeChain.length > 0) {
    const chain = encodeLogField(
      event.causeChain
        .map((cause) =>
          [cause.name, cause.code, cause.syscall, cause.errno, cause.port]
            .filter((part) => part !== undefined)
            .join("/"),
        )
        .join(" -> "),
    );
    write(
      `${MANAGED_TRANSPORT_FAILURE_EVENT} trace_id=${encodeLogField(event.traceId)} cause_chain=${chain}`,
    );
  }
  if (event.errorBodySnippet !== undefined) {
    write(
      `${MANAGED_TRANSPORT_FAILURE_EVENT} trace_id=${encodeLogField(event.traceId)} error_body=${encodeLogField(event.errorBodySnippet, MAX_ERROR_BODY_SNIPPET)}`,
    );
  }
}
