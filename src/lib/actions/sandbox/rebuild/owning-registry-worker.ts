// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { RebuildSandboxOptions } from "../../../domain/lifecycle/options";
import { rebuildSandbox } from "../rebuild-pipeline";
import type { RebuildSandboxExecutionOptions } from "../rebuild-prepared-recovery";

const MAX_REBUILD_INPUT_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInput(): {
  sandboxName: string;
  options: RebuildSandboxOptions;
  executionOptions: RebuildSandboxExecutionOptions;
} {
  const descriptor = 3;
  const chunks: Buffer[] = [];
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    bytes += count;
    if (bytes > MAX_REBUILD_INPUT_BYTES) throw new Error("Rebuild worker input is too large.");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !isRecord(parsed) ||
    typeof parsed.sandboxName !== "string" ||
    !isRecord(parsed.options) ||
    !isRecord(parsed.executionOptions)
  ) {
    throw new Error("Rebuild worker input is invalid.");
  }
  return {
    sandboxName: parsed.sandboxName,
    options: parsed.options as RebuildSandboxOptions,
    executionOptions: parsed.executionOptions as RebuildSandboxExecutionOptions,
  };
}

async function main(): Promise<void> {
  const input = readInput();
  await rebuildSandbox(input.sandboxName, input.options, {
    ...input.executionOptions,
    throwOnError: true,
  });
}

void main().catch(() => {
  console.error("Rebuild worker failed.");
  process.exitCode = 1;
});
