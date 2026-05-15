// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { StdioOptions } from "node:child_process";

import { compactText } from "../core/url-utils";
import { redact } from "../security/redact";
import { cleanupTempDir, secureTempFile } from "./temp-files";

export type BackgroundForwardStartResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type BackgroundForwardStartRunner = (
  stdio: StdioOptions,
  timeoutMs: number,
) => BackgroundForwardStartResult;

function readDiagnosticFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

export function runBackgroundForwardStartWithDiagnostics(
  runForwardStart: BackgroundForwardStartRunner,
  timeoutMs = 30_000,
): { result: BackgroundForwardStartResult; diagnostic: string } {
  const forwardDiagPath = secureTempFile("nemoclaw-forward-start", ".out");
  const forwardDiagDir = path.dirname(forwardDiagPath);
  const forwardErrPath = path.join(forwardDiagDir, "nemoclaw-forward-start.err");
  let result: BackgroundForwardStartResult | null = null;
  const outFd = fs.openSync(forwardDiagPath, "w", 0o600);
  const errFd = fs.openSync(forwardErrPath, "w", 0o600);

  try {
    try {
      result = runForwardStart(["ignore", outFd, errFd], timeoutMs);
    } catch (error) {
      result = {
        status: null,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  } finally {
    try {
      fs.closeSync(outFd);
    } catch {
      /* best effort */
    }
    try {
      fs.closeSync(errFd);
    } catch {
      /* best effort */
    }
  }

  try {
    const stderr = readDiagnosticFile(forwardErrPath);
    const stdout = readDiagnosticFile(forwardDiagPath);
    const message = result?.error instanceof Error ? result.error.message : "";
    return {
      result: result ?? { status: null, error: new Error("forward start did not return a result") },
      diagnostic: compactText(redact(`${stderr} ${stdout} ${message}`)),
    };
  } finally {
    cleanupTempDir(forwardDiagPath, "nemoclaw-forward-start");
  }
}
