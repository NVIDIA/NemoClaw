// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "./shell-probe.ts";

const TRANSIENT_INFERENCE_SET_FAILURE =
  /timed? out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|failed to connect|error sending request|failed to verify inference endpoint|502|503|504|temporar/iu;

export function inferenceSetAttemptCount(raw: string | undefined, fallback = 3): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`NEMOCLAW_SWITCH_SET_ATTEMPTS must be a positive integer; got ${raw}`);
  }
  return parsed;
}

export function isTransientInferenceSetFailure(result: ShellProbeResult): boolean {
  return TRANSIENT_INFERENCE_SET_FAILURE.test(`${result.stdout}\n${result.stderr}`);
}

export async function runInferenceSetWithRetry(options: {
  attempts: number;
  delay?: (milliseconds: number) => Promise<void>;
  run: (attempt: number, verify: boolean) => Promise<ShellProbeResult>;
}): Promise<ShellProbeResult> {
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const result = await options.run(attempt, true);
    if (result.exitCode === 0 || !isTransientInferenceSetFailure(result)) return result;
    if (attempt < options.attempts) {
      await delay(attempt * 5_000);
      continue;
    }
    return options.run(attempt, false);
  }
  throw new Error("Inference switch retry loop completed without running an attempt.");
}
