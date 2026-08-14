// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "./shell-probe.ts";
import { runBoundedRetry, type RetryEvidence } from "./retry-policy.ts";

const TRANSIENT_INFERENCE_SET_FAILURE =
  /timed? out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|failed to connect|error sending request|\b50[234]\b/iu;

export function inferenceSetAttemptCount(raw: string | undefined, fallback = 3): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(`NEMOCLAW_SWITCH_SET_ATTEMPTS must be between 1 and 10; got ${raw}`);
  }
  return parsed;
}

export function isTransientInferenceSetFailure(result: ShellProbeResult): boolean {
  return TRANSIENT_INFERENCE_SET_FAILURE.test(`${result.stdout}\n${result.stderr}`);
}

export function inferenceResponseModel(raw: string): string {
  const response = JSON.parse(raw) as { model?: unknown };
  return typeof response.model === "string" ? response.model : "";
}

export async function runInferenceSetWithRetry(options: {
  attempts: number;
  delay?: (milliseconds: number) => Promise<void>;
  run: (attempt: number, verify: boolean) => Promise<ShellProbeResult>;
  onEvidence?: (evidence: RetryEvidence) => Promise<void> | void;
}): Promise<ShellProbeResult> {
  const execution = await runBoundedRetry({
    operation: "inference.switch.verify",
    owner: "inference-provider",
    idempotence: "idempotent",
    maxAttempts: options.attempts,
    run: (attempt) => options.run(attempt, true),
    classify: (result) => {
      if (result?.exitCode === 0) return { outcome: "passed" };
      return {
        outcome: "failed",
        failureClass:
          result && isTransientInferenceSetFailure(result) ? "transient-external" : "deterministic",
      };
    },
    delayMs: (attempt) => attempt * 5_000,
    sleep: options.delay,
    onEvidence: options.onEvidence,
  });
  return execution.value!;
}
