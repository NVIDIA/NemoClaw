// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

import type { ProbeResult } from "./onboard-types";
import { ROOT } from "./paths";
import { compactText } from "./url-utils";

export type CurlProbeResult = ProbeResult;

export interface CurlProbeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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

function secureTempFile(prefix: string, ext = ""): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(dir, `${prefix}${ext}`);
}

function cleanupTempDir(filePath: string, expectedPrefix: string): void {
  const parentDir = path.dirname(filePath);
  if (parentDir !== os.tmpdir() && path.basename(parentDir).startsWith(`${expectedPrefix}-`)) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
}

export function getCurlTimingArgs(): string[] {
  return ["--connect-timeout", "10", "--max-time", "60"];
}

export function summarizeCurlFailure(curlStatus = 0, stderr = "", body = ""): string {
  const detail = compactText(stderr || body);
  return detail
    ? `curl failed (exit ${curlStatus}): ${detail.slice(0, 200)}`
    : `curl failed (exit ${curlStatus})`;
}

export function summarizeProbeError(body = "", status = 0): string {
  if (!body) return `HTTP ${status} with no response body`;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; details?: unknown };
      message?: unknown;
      detail?: unknown;
      details?: unknown;
    };
    const message =
      parsed?.error?.message ||
      parsed?.error?.details ||
      parsed?.message ||
      parsed?.detail ||
      parsed?.details;
    if (message) return `HTTP ${status}: ${String(message)}`;
  } catch {
    /* non-JSON body — fall through to raw text */
  }
  const compact = String(body).replace(/\s+/g, " ").trim();
  return `HTTP ${status}: ${compact.slice(0, 200)}`;
}

export function summarizeProbeFailure(
  body = "",
  status = 0,
  curlStatus = 0,
  stderr = "",
): string {
  if (curlStatus) {
    return summarizeCurlFailure(curlStatus, stderr, body);
  }
  return summarizeProbeError(body, status);
}

// eslint-disable-next-line complexity
export function runCurlProbe(argv: string[], opts: CurlProbeOptions = {}): CurlProbeResult {
  const bodyFile = secureTempFile("nemoclaw-curl-probe", ".json");
  try {
    const args = [...argv];
    const url = args.pop();
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const result = spawnSyncImpl(
      "curl",
      [...args, "-o", bodyFile, "-w", "%{http_code}", String(url || "")],
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ...opts.env,
        },
      },
    );
    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";
    if (result.error) {
      const spawnError = result.error as NodeJS.ErrnoException;
      const rawErrorCode = spawnError.errno ?? spawnError.code;
      const errorCode = typeof rawErrorCode === "number" ? rawErrorCode : 1;
      const errorMessage = compactText(
        `${spawnError.message || String(spawnError)} ${String(result.stderr || "")}`,
      );
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
    return {
      ok: result.status === 0 && status >= 200 && status < 300,
      httpStatus: Number.isFinite(status) ? status : 0,
      curlStatus: result.status || 0,
      body,
      stderr: String(result.stderr || ""),
      message: summarizeProbeFailure(body, status || 0, result.status || 0, String(result.stderr || "")),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1,
      body: "",
      stderr: detail,
      message: summarizeCurlFailure(
        typeof error === "object" && error && "status" in error ? Number(error.status) || 1 : 1,
        detail,
      ),
    };
  } finally {
    cleanupTempDir(bodyFile, "nemoclaw-curl-probe");
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
  const bodyFile = secureTempFile("nemoclaw-streaming-probe", ".sse");
  try {
    const args = [...argv];
    const url = args.pop();
    const spawnSyncImpl = opts.spawnSyncImpl ?? spawnSync;
    const result = spawnSyncImpl(
      "curl",
      [...args, "-N", "-o", bodyFile, String(url || "")],
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          ...opts.env,
        },
      },
    );

    const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : "";

    if (result.error || (result.status !== null && result.status !== 0 && result.status !== 28)) {
      // curl exit 28 = timeout, which is expected — we cap with --max-time
      // and may still have collected enough events before the timeout.
      const detail = result.error
        ? String((result.error as Error).message || result.error)
        : String(result.stderr || "");
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
      return {
        ok: false,
        missingEvents: missing,
        message:
          `Responses API streaming is missing required events: ${missing.join(", ")}. ` +
          "Falling back to chat completions API.",
      };
    }

    return { ok: true, missingEvents: [], message: "" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      missingEvents: REQUIRED_STREAMING_EVENTS,
      message: `Streaming probe error: ${detail}`,
    };
  } finally {
    cleanupTempDir(bodyFile, "nemoclaw-streaming-probe");
  }
}
