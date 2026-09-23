// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 10_000_000;

export function redactDiagnostic(value: string, limit = 4_000): string {
  return value
    .replace(/(authorization\s*:)[^\r\n]*/giu, "$1 [REDACTED]")
    .replace(/((?:token|key|secret|password)\s*=)[^\s]*/giu, "$1[REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[REDACTED]")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED]")
    .replace(/\/(?:home|Users)\/[^/\s]+/gu, "/[HOME]")
    .slice(0, limit);
}

export function projectDiagnostic(value: string, maxCharacters: number, clipMode: string): string {
  const redacted = redactDiagnostic(value, Number.MAX_SAFE_INTEGER);
  return clipMode === "head" ? redacted.slice(0, maxCharacters) : redacted.slice(-maxCharacters);
}

export async function runShell(
  command: string,
  workdir: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("bash", ["-c", command], {
      cwd: workdir,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
      timeout: timeoutMs,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const value = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      exitCode: typeof value.code === "number" ? value.code : 1,
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? value.message,
    };
  }
}

export async function runGithub(
  args: string[],
  workdir: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string }> {
  try {
    const result = await execFileAsync("gh", args, {
      cwd: workdir,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
      timeout: timeoutMs,
    });
    return { stdout: result.stdout };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("GitHub read failed: " + redactDiagnostic(message));
  }
}

export async function readBoundedJsonFile<T>(file: string, maximumBytes: number): Promise<T> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > maximumBytes)
    throw new Error(`JSON file exceeds the ${maximumBytes}-byte limit`);
  const content = await readFile(file, "utf8");
  if (Buffer.byteLength(content) !== metadata.size)
    throw new Error("JSON file changed while it was read");
  return JSON.parse(content) as T;
}
