// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface TimingHintSource {
  runId: number;
  artifactId: number;
  headSha: string;
  recordedAt: string;
}

export interface CliTestTimingHints {
  schemaVersion: 2;
  defaultDurationMs: number;
  sources: readonly TimingHintSource[];
  files: Readonly<Record<string, number>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCliTestTimingHints(value: unknown): CliTestTimingHints {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw new Error("CLI test timing hints must use schemaVersion 2");
  }
  if (!Number.isSafeInteger(value.defaultDurationMs) || Number(value.defaultDurationMs) <= 0) {
    throw new Error("CLI test timing hints require a positive integer defaultDurationMs");
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error("CLI test timing hints require source metadata");
  }
  const sources = value.sources.map((source) => {
    if (!isRecord(source)) throw new Error("Invalid CLI test timing hint source");
    const { runId, artifactId, headSha, recordedAt } = source;
    if (
      !Number.isSafeInteger(runId) ||
      Number(runId) <= 0 ||
      !Number.isSafeInteger(artifactId) ||
      Number(artifactId) <= 0 ||
      typeof headSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(headSha) ||
      typeof recordedAt !== "string" ||
      Number.isNaN(Date.parse(recordedAt))
    ) {
      throw new Error("Invalid CLI test timing hint source");
    }
    return { runId: Number(runId), artifactId: Number(artifactId), headSha, recordedAt };
  });
  if (!isRecord(value.files)) {
    throw new Error("CLI test timing hints require a files map");
  }

  const defaultDurationMs = Number(value.defaultDurationMs);
  const files: Record<string, number> = {};
  for (const [file, durationMs] of Object.entries(value.files)) {
    const segments = file.split("/");
    if (
      file.length === 0 ||
      file.startsWith("/") ||
      file.includes("\\") ||
      segments.includes("..") ||
      !Number.isSafeInteger(durationMs) ||
      Number(durationMs) <= defaultDurationMs
    ) {
      throw new Error(`Invalid CLI test timing hint: ${file}`);
    }
    files[file] = Number(durationMs);
  }

  return {
    schemaVersion: 2,
    defaultDurationMs,
    sources,
    files,
  };
}
