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
import { ROOT } from "../../state/paths";
import { addTraceEvent, withTraceSpan } from "../../trace";

export type CurlProbeResult = ProbeResult;

export interface CurlProbeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  replaceEnv?: boolean;
  timeoutMs?: number;
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
  const rawErrorCode = isErrnoException(error)
    ? (error.errno ?? error.code)
    : undefined;
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

const CURL_OPTIONS_THAT_READ_FILES = new Set(["--config", "-K", "--cookie", "-b", "--netrc-file"]);
const CURL_DATA_OPTIONS = new Set([
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--json",
  "--form",
  "-d",
  "-F",
]);

function normalizeHttpProbeUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new Error("curl probe URL is required");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`curl probe URL must use http or https: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("curl probe URL must not embed credentials");
  }
  return url.toString();
}

function curlValueReadsFromFile(value: string): boolean {
  return (value.startsWith("@") && value !== "@-") || /(^|=)@[^-]/.test(value);
}

function validateCurlProbeArgs(argv: string[]): { args: string[]; url: string } {
  const args = [...argv];
  const url = normalizeHttpProbeUrl(args.pop());
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [option, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (CURL_OPTIONS_THAT_READ_FILES.has(option)) {
      throw new Error(`curl probe option is not allowed because it reads local files: ${option}`);
    }
    if (arg === "--url" || arg.startsWith("--url=")) {
      throw new Error("curl probe URLs must be passed as the final argv entry");
    }
    if ((arg.startsWith("-d") || arg.startsWith("-F")) && arg.length > 2 && !arg.startsWith("--")) {
      const value = arg.slice(2);
      if (curlValueReadsFromFile(value)) {
        throw new Error(`curl probe option must not read request data from a file: ${arg.slice(0, 2)}`);
      }
      continue;
    }
    if (CURL_DATA_OPTIONS.has(option)) {
      const value = inlineValue ?? args[index + 1] ?? "";
      if (curlValueReadsFromFile(value)) {
        throw new Error(`curl probe option must not read request data from a file: ${option}`);
      }
      if (inlineValue === undefined) index += 1;
    }
  }
  return { args, url };
}

function getCurlProbeTraceAttributes(argv: string[], opts: CurlProbeOptions): Record<string, unknown> {
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
  return withTraceSpan("nemoclaw.inference.curl_probe", getCurlProbeTraceAttributes(argv, opts), () =>
    runCurlProbeImpl(argv, opts),
  );
}

function runCurlProbeImpl(argv: string[], opts: CurlProbeOptions = {}): CurlProbeResult {
  const bodyFile = secureTempFile("nemoclaw-curl-probe", ".json");
  try {
    const { args, url } = validateCurlProbeArgs(argv);
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const timeout = resolveCurlProcessTimeoutMs(argv, opts);
    // The URL is normalized to http(s) and curl argv is screened for options
    // that make curl read local files into the outbound request.
    // lgtm[js/file-access-to-http]
    const result = spawnSyncImpl(
      "curl",
      [...args, "-o", bodyFile, "-w", "%{http_code}", url],
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout,
        env: opts.replaceEnv ? (opts.env ?? {}) : { ...process.env, ...opts.env },
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
    const { args, url } = validateCurlProbeArgs(argv);
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const timeout = resolveCurlProcessTimeoutMs(argv, opts);
    // The URL is normalized to http(s) and curl argv is screened for options
    // that make curl read local files into the outbound request.
    // lgtm[js/file-access-to-http]
    const result = spawnSyncImpl(
      "curl",
      [...args, "-N", "-o", bodyFile, "-w", "%{http_code}", url],
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout,
        env: {
          ...process.env,
          ...opts.env,
        },
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

function runStreamingEventProbeImpl(
  argv: string[],
  opts: CurlProbeOptions = {},
): StreamingProbeResult {
  const bodyFile = secureTempFile("nemoclaw-streaming-probe", ".sse");
  try {
    const { args, url } = validateCurlProbeArgs(argv);
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const timeout = resolveCurlProcessTimeoutMs(argv, opts);
    // The URL is normalized to http(s) and curl argv is screened for options
    // that make curl read local files into the outbound request.
    // lgtm[js/file-access-to-http]
    const result = spawnSyncImpl("curl", [...args, "-N", "-o", bodyFile, url], {
      cwd: opts.cwd ?? ROOT,
      encoding: "utf8",
      timeout,
      env: {
        ...process.env,
        ...opts.env,
      },
    });

    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";

    if (result.error || (result.status !== null && result.status !== 0 && result.status !== 28)) {
      // curl exit 28 = timeout, which is expected — we cap with --max-time
      // and may still have collected enough events before the timeout.
      const curlStatus = result.error ? normalizeSpawnErrorCode(result.error) : (result.status ?? 1);
      const detail = result.error
        ? String(result.error.message || result.error)
        : String(result.stderr || "");
      emitCurlResultTraceEvent({
        ok: false,
        missing_events_count: REQUIRED_STREAMING_EVENTS.length,
        curl_status: curlStatus,
      });
      return {
        ok: false,
        missingEvents: REQUIRED_STREAMING_EVENTS,
        message: `Streaming probe failed: ${compactText(detail).slice(0, 200)}`,
      };
    }

    // Parse SSE event types from the raw output.
    // Each event line looks like: "event: response.output_text.delta"
    const eventTypes = new Set<string>();
    for (const line of body.split("\n")) {
      const match = /^event:\s*(.+)$/i.exec(line.trim());
      if (match) {
        eventTypes.add(match[1].trim());
      }
    }

    const missing = REQUIRED_STREAMING_EVENTS.filter((e) => !eventTypes.has(e));
    if (missing.length > 0) {
      emitCurlResultTraceEvent({
        ok: false,
        missing_events_count: missing.length,
        curl_status: result.status ?? 0,
      });
      return {
        ok: false,
        missingEvents: missing,
        message:
          `Responses API streaming is missing required events: ${missing.join(", ")}. ` +
          "Falling back to chat completions API.",
      };
    }

    emitCurlResultTraceEvent({ ok: true, missing_events_count: 0, curl_status: result.status ?? 0 });
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
  } finally {
    cleanupTempDir(bodyFile, "nemoclaw-streaming-probe");
  }
}
