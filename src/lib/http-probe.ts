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

import { compactText } from "./url-utils";

// runner.js is CJS — use require so we don't pull it into the TS build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ROOT } = require("../../bin/lib/runner");

export interface CurlProbeResult {
  ok: boolean;
  httpStatus: number;
  curlStatus: number;
  body: string;
  stderr: string;
  message: string;
}

export interface CurlProbeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnSyncImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
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
