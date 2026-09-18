// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function redactSecretResult(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) throw new Error("secret scan report contains a non-object result");

  // Scanner text, including paths and purportedly redacted values, can contain credentials.
  const safe: JsonRecord = {};
  if (
    typeof record.DetectorType === "number" &&
    Number.isSafeInteger(record.DetectorType) &&
    record.DetectorType >= 0
  ) {
    safe.DetectorType = record.DetectorType;
  }
  for (const field of ["Verified", "VerificationFromCache"] as const) {
    if (typeof record[field] === "boolean") safe[field] = record[field];
  }
  return safe;
}

export function parseSecretReport(source: string): JsonRecord[] {
  const lines = source.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    try {
      return redactSecretResult(JSON.parse(line) as unknown);
    } catch {
      throw new Error("secret scan report contains invalid JSON");
    }
  });
}

export function redactSecretReport(rawPath: string, stderrPath: string, reportPath: string): void {
  const temporaryReport = `${reportPath}.${process.pid}.tmp`;
  try {
    fs.rmSync(reportPath, { force: true });
    const source = fs.readFileSync(rawPath, "utf8");
    const safeResults = parseSecretReport(source);
    fs.writeFileSync(
      temporaryReport,
      safeResults.map((result) => JSON.stringify(result)).join("\n") +
        (safeResults.length > 0 ? "\n" : ""),
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporaryReport, reportPath);
  } finally {
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(stderrPath, { force: true });
    fs.rmSync(temporaryReport, { force: true });
  }
}

export function classifySecretExit(exitCode: number): "accepted" | "advisory" | "blocking" {
  if (exitCode === 0 || exitCode === 189) return "accepted";
  if (exitCode === 185) return "advisory";
  return "blocking";
}

function runCli(args: string[]): void {
  const [command, ...values] = args;
  if (command === "redact-secrets" && values.length === 3) {
    redactSecretReport(values[0]!, values[1]!, values[2]!);
    return;
  }
  if (command === "classify-secret-exit" && values.length === 1) {
    const exitCode = Number(values[0]);
    if (!Number.isInteger(exitCode) || exitCode < 0) {
      throw new Error("secret scanner exit code must be a non-negative integer");
    }
    process.stdout.write(`${classifySecretExit(exitCode)}\n`);
    return;
  }
  throw new Error("usage: security-scan-results.mts <redact-secrets|classify-secret-exit>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  }
}
