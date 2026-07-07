// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isErrnoException } from "../../core/errno";
import { compactText } from "../../core/url-utils";
import type { ProbeResult } from "../../onboard/types";
import { buildScrubbedCurlProbeEnv, scrubCredentialEnv } from "../../security/credential-env";
import { ROOT } from "../../state/paths";
import { addTraceEvent, withTraceSpan } from "../../trace";
import { buildCurlProbeSpawnArgs, validateCurlProbeArgs } from "./curl-args";

export type CurlProbeResult = ProbeResult;

export interface CurlProbeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  replaceEnv?: boolean;
  timeoutMs?: number;
  /** Absolute or cwd-relative curl config files created by trusted NemoClaw callers. */
  trustedConfigFiles?: readonly string[];
  /**
   * Connection capability returned by the endpoint SSRF preflight. A defined
   * value, including `[]` for an approved no-DNS origin, requires direct
   * connection with ambient proxies disabled.
   */
  pinnedAddresses?: readonly string[];
  spawnSyncImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
}

export interface StreamingProbeResult {
  ok: boolean;
  missingEvents: string[];
  message: string;
}

const DEFAULT_CURL_PROCESS_TIMEOUT_MS = 30_000;
const CURL_PROCESS_TIMEOUT_SLACK_MS = 5_000;

function resolveCurlProbeSpawnEnv(
  args: readonly string[],
  opts: CurlProbeOptions,
): NodeJS.ProcessEnv {
  const env = opts.replaceEnv
    ? scrubCredentialEnv(opts.env ?? {})
    : buildScrubbedCurlProbeEnv(opts.env ?? {});
  const hasPreflightCapability = opts.pinnedAddresses !== undefined;
  const hasResolvePin = args.some((arg) => arg === "--resolve" || arg.startsWith("--resolve="));
  if (!hasPreflightCapability && !hasResolvePin) return env;

  // A proxy defeats the preflight trust boundary: curl sends CONNECT host:port
  // and delegates origin selection (and DNS for names) to the proxy. Every
  // preflight-approved probe therefore bypasses all proxy env spellings,
  // including approved no-pin loopback, managed-alias, and IP-literal origins.
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete env[name];
  }
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  return env;
}

function validateTempPrefix(prefix: string): string {
  if (
    prefix.length === 0 ||
    prefix !== path.basename(prefix) ||
    prefix.includes(path.posix.sep) ||
    prefix.includes(path.win32.sep)
  ) {
    throw new Error(`Invalid temp file prefix: ${prefix}`);
  }
  return prefix;
}

function secureTempFile(prefix: string, ext = ""): string {
  const safePrefix = validateTempPrefix(prefix);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${safePrefix}-`));
  return path.join(dir, `${safePrefix}${ext}`);
}

function cleanupTempDir(filePath: string, expectedPrefix: string): void {
  const safePrefix = validateTempPrefix(expectedPrefix);
  const tempRoot = path.resolve(os.tmpdir());
  const parentDir = path.resolve(path.dirname(filePath));
  const relativeParent = path.relative(tempRoot, parentDir);
  const isInsideTempRoot =
    relativeParent !== "" && !relativeParent.startsWith("..") && !path.isAbsolute(relativeParent);
  if (isInsideTempRoot && path.basename(parentDir).startsWith(`${safePrefix}-`)) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
}

export function getCurlTimingArgs(): string[] {
  return ["--connect-timeout", "10", "--max-time", "60"];
}

function getCurlMaxTimeSeconds(argv: string[]): number | null {
  let maxTimeSeconds: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--max-time") {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) {
        maxTimeSeconds = value;
      }
      continue;
    }
    if (arg.startsWith("--max-time=")) {
      const value = Number(arg.slice("--max-time=".length));
      if (Number.isFinite(value) && value > 0) {
        maxTimeSeconds = value;
      }
    }
  }
  return maxTimeSeconds;
}

function resolveCurlProcessTimeoutMs(argv: string[], opts: CurlProbeOptions): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const maxTimeSeconds = getCurlMaxTimeSeconds(argv);
  if (maxTimeSeconds === null) return DEFAULT_CURL_PROCESS_TIMEOUT_MS;
  return Math.max(
    DEFAULT_CURL_PROCESS_TIMEOUT_MS,
    Math.ceil(maxTimeSeconds * 1000) + CURL_PROCESS_TIMEOUT_SLACK_MS,
  );
}

function normalizeSpawnErrorCode(error: unknown): number {
  if (isErrnoException(error) && error.code === "ETIMEDOUT") return -110;
  const rawErrorCode = isErrnoException(error) ? (error.errno ?? error.code) : undefined;
  return typeof rawErrorCode === "number" ? rawErrorCode : 1;
}

function sanitizeCurlUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "<REDACTED>");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return value.replace(/(Bearer\s+)\S+/gi, "$1<REDACTED>");
  }
}

function getCurlProbeTraceAttributes(
  argv: string[],
  opts: CurlProbeOptions,
): Record<string, unknown> {
  const url = argv.at(-1) || "";
  const methodIndex = argv.findIndex((arg) => arg === "-X" || arg === "--request");
  const method =
    methodIndex >= 0 && argv[methodIndex + 1] ? argv[methodIndex + 1].toUpperCase() : "POST";
  return {
    "http.url": sanitizeCurlUrl(String(url)),
    "http.request.method": method,
    "process.timeout_ms": resolveCurlProcessTimeoutMs(argv, opts),
  };
}

function emitCurlResultTraceEvent(attributes: Record<string, unknown>): void {
  addTraceEvent("curl_result", attributes);
}

export function summarizeCurlFailure(curlStatus = 0, stderr = "", body = ""): string {
  const detail = compactText(stderr || body);
  return detail
    ? `curl failed (exit ${curlStatus}): ${detail.slice(0, 200)}`
    : `curl failed (exit ${curlStatus})`;
}

type ProbeErrorDetail =
  | string
  | number
  | boolean
  | null
  | { [key: string]: string | number | boolean | null }
  | Array<string | number | boolean | null>;

type ProbeErrorBody = {
  error?: { message?: ProbeErrorDetail; details?: ProbeErrorDetail };
  message?: ProbeErrorDetail;
  detail?: ProbeErrorDetail;
  details?: ProbeErrorDetail;
};

function formatProbeErrorDetail(detail: ProbeErrorDetail): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (typeof detail === "number" || typeof detail === "boolean" || detail === null) {
    return String(detail);
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return "[unserializable detail]";
  }
}

export function summarizeProbeError(body = "", status = 0): string {
  if (!body) return `HTTP ${status} with no response body`;
  try {
    const parsed: ProbeErrorBody = JSON.parse(body);
    const message =
      parsed?.error?.message ||
      parsed?.error?.details ||
      parsed?.message ||
      parsed?.detail ||
      parsed?.details;
    if (message !== undefined) return `HTTP ${status}: ${formatProbeErrorDetail(message)}`;
  } catch {
    /* non-JSON body — fall through to raw text */
  }
  const compact = String(body).replace(/\s+/g, " ").trim();
  return `HTTP ${status}: ${compact.slice(0, 200)}`;
}

export function summarizeProbeFailure(body = "", status = 0, curlStatus = 0, stderr = ""): string {
  if (curlStatus) {
    return summarizeCurlFailure(curlStatus, stderr, body);
  }
  return summarizeProbeError(body, status);
}

export function runCurlProbe(argv: string[], opts: CurlProbeOptions = {}): CurlProbeResult {
  return withTraceSpan(
    "nemoclaw.inference.curl_probe",
    getCurlProbeTraceAttributes(argv, opts),
    () => runCurlProbeImpl(argv, opts),
  );
}

function runCurlProbeImpl(argv: string[], opts: CurlProbeOptions = {}): CurlProbeResult {
  const bodyFile = secureTempFile("nemoclaw-curl-probe", ".json");
  try {
    const { args, url } = validateCurlProbeArgs(argv, opts);
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const timeout = resolveCurlProcessTimeoutMs(argv, opts);
    const curlArgs = buildCurlProbeSpawnArgs(args, url, bodyFile, "json");
    const result = spawnSyncImpl(
      "curl",
      // lgtm[js/file-access-to-http] curlArgs were validated and rebuilt from safe probe fields.
      curlArgs,
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout,
        env: resolveCurlProbeSpawnEnv(args, opts),
      },
    );
    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    if (result.error) {
      const errorCode = normalizeSpawnErrorCode(result.error);
      const errorMessage = compactText(
        `${result.error.message || String(result.error)} ${String(result.stderr || "")}`,
      );
      const failure = {
        ok: false,
        httpStatus: 0,
        curlStatus: errorCode,
        body,
        stderr: errorMessage,
        message: summarizeProbeFailure(body, 0, errorCode, errorMessage),
      };
      emitCurlResultTraceEvent({ ok: false, http_status: 0, curl_status: errorCode });
      return failure;
    }
    const status = Number(String(result.stdout || "").trim());
    const probeResult = {
      ok: result.status === 0 && status >= 200 && status < 300,
      httpStatus: Number.isFinite(status) ? status : 0,
      curlStatus: result.status || 0,
      body,
      stderr: String(result.stderr || ""),
      message: summarizeProbeFailure(
        body,
        status || 0,
        result.status || 0,
        String(result.stderr || ""),
      ),
    };
    emitCurlResultTraceEvent({
      ok: probeResult.ok,
      http_status: probeResult.httpStatus,
      curl_status: probeResult.curlStatus,
    });
    return probeResult;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const probeResult = {
      ok: false,
      httpStatus: 0,
      curlStatus:
        typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1,
      body: "",
      stderr: detail,
      message: summarizeCurlFailure(
        typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1,
        detail,
      ),
    };
    emitCurlResultTraceEvent({ ok: false, http_status: 0, curl_status: probeResult.curlStatus });
    return probeResult;
  } finally {
    cleanupTempDir(bodyFile, "nemoclaw-curl-probe");
  }
}

function hasChatCompletionsStreamingData(body: string): boolean {
  let seenChoices = false;
  for (const line of body.split("\n")) {
    const match = /^data:\s*(.+)$/i.exec(line.trim());
    if (!match) continue;
    const data = match[1].trim();
    if (data === "[DONE]") return seenChoices;
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) {
        seenChoices = true;
      }
    } catch {
      /* Ignore malformed SSE data lines and keep scanning. */
    }
  }
  return seenChoices;
}

export function runChatCompletionsStreamingProbe(
  argv: string[],
  opts: CurlProbeOptions = {},
): CurlProbeResult {
  return withTraceSpan(
    "nemoclaw.inference.curl_streaming_probe",
    getCurlProbeTraceAttributes(argv, opts),
    () => runChatCompletionsStreamingProbeImpl(argv, opts),
  );
}

function runChatCompletionsStreamingProbeImpl(
  argv: string[],
  opts: CurlProbeOptions = {},
): CurlProbeResult {
  const bodyFile = secureTempFile("nemoclaw-chat-streaming-probe", ".sse");
  try {
    const { args, url } = validateCurlProbeArgs(argv, opts);
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const timeout = resolveCurlProcessTimeoutMs(argv, opts);
    const curlArgs = buildCurlProbeSpawnArgs(args, url, bodyFile, "chat-stream");
    const result = spawnSyncImpl(
      "curl",
      // lgtm[js/file-access-to-http] curlArgs were validated and rebuilt from safe probe fields.
      curlArgs,
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout,
        env: resolveCurlProbeSpawnEnv(args, opts),
      },
    );

    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    if (result.error) {
      const errorCode = normalizeSpawnErrorCode(result.error);
      const errorMessage = compactText(
        `${result.error.message || String(result.error)} ${String(result.stderr || "")}`,
      );
      emitCurlResultTraceEvent({ ok: false, http_status: 0, curl_status: errorCode });
      return {
        ok: false,
        httpStatus: 0,
        curlStatus: errorCode,
        body,
        stderr: errorMessage,
        message: summarizeProbeFailure(body, 0, errorCode, errorMessage),
      };
    }

    const status = Number(String(result.stdout || "").trim());
    const curlStatus = result.status || 0;
    const hasStreamingData = hasChatCompletionsStreamingData(body);
    const httpOk = Number.isFinite(status) && status >= 200 && status < 300;
    if (httpOk && hasStreamingData && (curlStatus === 0 || curlStatus === 28)) {
      emitCurlResultTraceEvent({ ok: true, http_status: status, curl_status: curlStatus });
      return {
        ok: true,
        httpStatus: status,
        curlStatus,
        body,
        stderr: String(result.stderr || ""),
        message: `HTTP ${status}: chat completions stream returned SSE data`,
      };
    }

    const message =
      httpOk && !hasStreamingData
        ? `HTTP ${status}: chat completions stream did not return SSE data`
        : summarizeProbeFailure(body, status || 0, curlStatus, String(result.stderr || ""));
    emitCurlResultTraceEvent({
      ok: false,
      http_status: Number.isFinite(status) ? status : 0,
      curl_status: curlStatus,
    });
    return {
      ok: false,
      httpStatus: Number.isFinite(status) ? status : 0,
      curlStatus,
      body,
      stderr: String(result.stderr || ""),
      message,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const curlStatus =
      typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1;
    emitCurlResultTraceEvent({ ok: false, http_status: 0, curl_status: curlStatus });
    return {
      ok: false,
      httpStatus: 0,
      curlStatus,
      body: "",
      stderr: detail,
      message: summarizeCurlFailure(curlStatus, detail),
    };
  } finally {
    cleanupTempDir(bodyFile, "nemoclaw-chat-streaming-probe");
  }
}

/**
 * The minimum set of streaming events that OpenClaw requires from a
 * `/v1/responses` endpoint. Backends that only emit the top-level lifecycle
 * events (created / in_progress / completed) will cause runtime failures
 * because OpenClaw never receives the incremental content deltas.
 */
const REQUIRED_STREAMING_EVENTS = ["response.output_text.delta"];

/**
 * Send a streaming request to a `/v1/responses`-style endpoint and verify
 * that the SSE event stream includes the granular events OpenClaw needs.
 *
 * This catches backends like SGLang that return valid non-streaming
 * responses but emit only `response.created`, `response.in_progress`, and
 * `response.completed` in streaming mode — missing the content deltas that
 * OpenClaw relies on.
 */
export function runStreamingEventProbe(
  argv: string[],
  opts: CurlProbeOptions = {},
): StreamingProbeResult {
  return withTraceSpan(
    "nemoclaw.inference.curl_streaming_event_probe",
    getCurlProbeTraceAttributes(argv, opts),
    () => runStreamingEventProbeImpl(argv, opts),
  );
}

interface SseEventCaptureResult {
  ok: boolean;
  httpStatus: number;
  curlStatus: number;
  /** Transport/execution error detail when `ok` is false. */
  detail: string;
  /** Occurrence count per SSE `event:` type parsed from the response body. */
  eventCounts: Map<string, number>;
  /** SSE `event:` types in stream order, for sequence validation. */
  eventSequence: string[];
}

/**
 * Run a streaming curl probe and count the SSE `event:` types in the
 * response body. Shared by the Responses API and Anthropic Messages
 * streaming validators, which apply protocol-specific rules to the counts.
 */
function captureSseEventCounts(
  argv: string[],
  opts: CurlProbeOptions,
  tempPrefix: string,
  captureHttpStatus = false,
): SseEventCaptureResult {
  const bodyFile = secureTempFile(tempPrefix, ".sse");
  try {
    const { args, url } = validateCurlProbeArgs(argv, opts);
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const timeout = resolveCurlProcessTimeoutMs(argv, opts);
    const curlArgs = buildCurlProbeSpawnArgs(
      args,
      url,
      bodyFile,
      captureHttpStatus ? "event-stream-with-status" : "event-stream",
    );
    const result = spawnSyncImpl(
      "curl",
      // lgtm[js/file-access-to-http] curlArgs were validated and rebuilt from safe probe fields.
      curlArgs,
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout,
        env: resolveCurlProbeSpawnEnv(args, opts),
      },
    );

    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";

    if (result.error || (result.status !== null && result.status !== 0 && result.status !== 28)) {
      // curl exit 28 = timeout, which is expected — we cap with --max-time
      // and may still have collected enough events before the timeout.
      const curlStatus = result.error
        ? normalizeSpawnErrorCode(result.error)
        : (result.status ?? 1);
      const detail = result.error
        ? String(result.error.message || result.error)
        : String(result.stderr || "");
      return {
        ok: false,
        httpStatus: 0,
        curlStatus,
        detail,
        eventCounts: new Map(),
        eventSequence: [],
      };
    }

    const status = captureHttpStatus ? Number(String(result.stdout || "").trim()) : 0;
    const httpStatus = captureHttpStatus && Number.isFinite(status) ? status : 0;
    if (captureHttpStatus && (httpStatus < 200 || httpStatus >= 300)) {
      return {
        ok: false,
        httpStatus,
        curlStatus: result.status ?? 0,
        detail: summarizeProbeFailure(
          body,
          httpStatus,
          result.status ?? 0,
          String(result.stderr || ""),
        ),
        eventCounts: new Map(),
        eventSequence: [],
      };
    }

    // Parse SSE event types from the raw output.
    // Each event line looks like: "event: response.output_text.delta"
    const eventCounts = new Map<string, number>();
    const eventSequence: string[] = [];
    for (const line of body.split("\n")) {
      const match = /^event:\s*(.+)$/i.exec(line.trim());
      if (match) {
        const eventType = match[1].trim();
        eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);
        eventSequence.push(eventType);
      }
    }
    return {
      ok: true,
      httpStatus,
      curlStatus: result.status ?? 0,
      detail: "",
      eventCounts,
      eventSequence,
    };
  } finally {
    cleanupTempDir(bodyFile, tempPrefix);
  }
}

function runStreamingEventProbeImpl(
  argv: string[],
  opts: CurlProbeOptions = {},
): StreamingProbeResult {
  try {
    const capture = captureSseEventCounts(argv, opts, "nemoclaw-streaming-probe");
    if (!capture.ok) {
      emitCurlResultTraceEvent({
        ok: false,
        missing_events_count: REQUIRED_STREAMING_EVENTS.length,
        curl_status: capture.curlStatus,
      });
      return {
        ok: false,
        missingEvents: REQUIRED_STREAMING_EVENTS,
        message: `Streaming probe failed: ${compactText(capture.detail).slice(0, 200)}`,
      };
    }

    const missing = REQUIRED_STREAMING_EVENTS.filter(
      (e) => (capture.eventCounts.get(e) ?? 0) === 0,
    );
    if (missing.length > 0) {
      emitCurlResultTraceEvent({
        ok: false,
        missing_events_count: missing.length,
        curl_status: capture.curlStatus,
      });
      return {
        ok: false,
        missingEvents: missing,
        message:
          `Responses API streaming is missing required events: ${missing.join(", ")}. ` +
          "Falling back to chat completions API.",
      };
    }

    emitCurlResultTraceEvent({
      ok: true,
      missing_events_count: 0,
      curl_status: capture.curlStatus,
    });
    return { ok: true, missingEvents: [], message: "" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const curlStatus =
      typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1;
    emitCurlResultTraceEvent({
      ok: false,
      missing_events_count: REQUIRED_STREAMING_EVENTS.length,
      curl_status: curlStatus,
    });
    return {
      ok: false,
      missingEvents: REQUIRED_STREAMING_EVENTS,
      message: `Streaming probe error: ${detail}`,
    };
  }
}

/**
 * The Anthropic Messages streaming event sequence that agent runtimes
 * (Hermes `api_mode=anthropic_messages`, OpenClaw Anthropic routes) require
 * from a `/v1/messages` endpoint: one `message_start`, at least one
 * `content_block_delta` carrying incremental content, and a terminal
 * `message_stop`.
 */
const REQUIRED_ANTHROPIC_STREAMING_EVENTS = [
  "message_start",
  "content_block_delta",
  "message_stop",
];

/**
 * Anthropic Messages events that must appear exactly once per stream.
 * Anthropic-compatible gateways with broken streaming layers have been
 * observed emitting `message_start` twice with the same message id, which
 * corrupts streaming-client state machines: the agent run then ends with an
 * empty final response even though the non-streaming path works (#6289).
 * `message_stop` is the single terminal event of the same contract.
 */
const SINGLETON_ANTHROPIC_STREAMING_EVENTS = ["message_start", "message_stop"];

export interface AnthropicStreamingProbeResult {
  ok: boolean;
  /** HTTP response status, or 0 when no HTTP response was received. */
  httpStatus: number;
  /** curl exit status, including 28 when a bounded stream timed out. */
  curlStatus: number;
  missingEvents: string[];
  duplicateEvents: string[];
  /** Order violations, e.g. content deltas before message_start or after message_stop. */
  sequenceErrors: string[];
  message: string;
}

/**
 * Known Anthropic Messages payload events that must sit between
 * `message_start` and `message_stop` in a well-formed stream.
 */
const ANTHROPIC_CONTENT_STREAMING_EVENTS = new Set([
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
]);

/**
 * Order rules for a well-formed Anthropic Messages stream: `message_start`
 * opens the stream before any content event, and `message_stop` terminates
 * it after the last one. Only evaluated once all required events are
 * present; interleaved unknown events (e.g. `ping`) are ignored.
 */
function anthropicSequenceErrors(eventSequence: string[]): string[] {
  const errors: string[] = [];
  const firstStart = eventSequence.indexOf("message_start");
  const lastStop = eventSequence.lastIndexOf("message_stop");
  const contentIndexes = eventSequence
    .map((event, index) => (ANTHROPIC_CONTENT_STREAMING_EVENTS.has(event) ? index : -1))
    .filter((index) => index >= 0);
  const firstContent = contentIndexes[0] ?? -1;
  const lastContent = contentIndexes[contentIndexes.length - 1] ?? -1;
  if (firstContent >= 0 && firstContent < firstStart) {
    errors.push("content events before message_start");
  }
  if (lastContent >= 0 && lastStop < lastContent) {
    errors.push("content events after message_stop");
  }
  return errors;
}

/**
 * Send a streaming request to an Anthropic-compatible `/v1/messages`
 * endpoint and verify the SSE event stream is well formed: the required
 * events are present, no singleton event is duplicated, and the events
 * arrive in protocol order (message_start → content deltas → message_stop).
 *
 * This catches gateways whose non-streaming responses are valid but whose
 * streaming layer is broken — runtime agents only use the streaming path,
 * so without this probe the defect first surfaces as a cryptic
 * "no final response was produced" failure inside the sandbox.
 */
export function runAnthropicStreamingEventProbe(
  argv: string[],
  opts: CurlProbeOptions = {},
): AnthropicStreamingProbeResult {
  return withTraceSpan(
    "nemoclaw.inference.curl_anthropic_streaming_probe",
    getCurlProbeTraceAttributes(argv, opts),
    () => runAnthropicStreamingEventProbeImpl(argv, opts),
  );
}

function runAnthropicStreamingEventProbeImpl(
  argv: string[],
  opts: CurlProbeOptions = {},
): AnthropicStreamingProbeResult {
  try {
    const capture = captureSseEventCounts(argv, opts, "nemoclaw-anthropic-streaming-probe", true);
    if (!capture.ok) {
      emitCurlResultTraceEvent({
        ok: false,
        http_status: capture.httpStatus,
        missing_events_count: REQUIRED_ANTHROPIC_STREAMING_EVENTS.length,
        duplicate_events_count: 0,
        sequence_errors_count: 0,
        curl_status: capture.curlStatus,
      });
      return {
        ok: false,
        httpStatus: capture.httpStatus,
        curlStatus: capture.curlStatus,
        missingEvents: REQUIRED_ANTHROPIC_STREAMING_EVENTS,
        duplicateEvents: [],
        sequenceErrors: [],
        message: `Streaming probe failed: ${compactText(capture.detail).slice(0, 200)}`,
      };
    }

    const missing = REQUIRED_ANTHROPIC_STREAMING_EVENTS.filter(
      (e) => (capture.eventCounts.get(e) ?? 0) === 0,
    );
    const duplicates = SINGLETON_ANTHROPIC_STREAMING_EVENTS.filter(
      (e) => (capture.eventCounts.get(e) ?? 0) > 1,
    );
    const sequenceErrors =
      missing.length === 0 ? anthropicSequenceErrors(capture.eventSequence) : [];
    if (missing.length > 0 || duplicates.length > 0 || sequenceErrors.length > 0) {
      const problems: string[] = [];
      if (duplicates.length > 0) {
        const detail = duplicates
          .map((e) => `${e} (${capture.eventCounts.get(e)} events for one request)`)
          .join(", ");
        problems.push(`emits duplicate ${detail}`);
      }
      if (missing.length > 0) {
        problems.push(`is missing required events: ${missing.join(", ")}`);
      }
      if (sequenceErrors.length > 0) {
        problems.push(`emits events out of order (${sequenceErrors.join("; ")})`);
      }
      emitCurlResultTraceEvent({
        ok: false,
        http_status: capture.httpStatus,
        missing_events_count: missing.length,
        duplicate_events_count: duplicates.length,
        sequence_errors_count: sequenceErrors.length,
        curl_status: capture.curlStatus,
      });
      return {
        ok: false,
        httpStatus: capture.httpStatus,
        curlStatus: capture.curlStatus,
        missingEvents: missing,
        duplicateEvents: duplicates,
        sequenceErrors,
        message:
          `Anthropic Messages streaming on this endpoint ${problems.join(" and ")}. ` +
          "Agent runs use the streaming path and would fail with an empty final response.",
      };
    }

    emitCurlResultTraceEvent({
      ok: true,
      http_status: capture.httpStatus,
      missing_events_count: 0,
      duplicate_events_count: 0,
      sequence_errors_count: 0,
      curl_status: capture.curlStatus,
    });
    return {
      ok: true,
      httpStatus: capture.httpStatus,
      curlStatus: capture.curlStatus,
      missingEvents: [],
      duplicateEvents: [],
      sequenceErrors: [],
      message: "",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const curlStatus =
      typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1;
    emitCurlResultTraceEvent({
      ok: false,
      http_status: 0,
      missing_events_count: REQUIRED_ANTHROPIC_STREAMING_EVENTS.length,
      duplicate_events_count: 0,
      sequence_errors_count: 0,
      curl_status: curlStatus,
    });
    return {
      ok: false,
      httpStatus: 0,
      curlStatus,
      missingEvents: REQUIRED_ANTHROPIC_STREAMING_EVENTS,
      duplicateEvents: [],
      sequenceErrors: [],
      message: `Streaming probe error: ${detail}`,
    };
  }
}
