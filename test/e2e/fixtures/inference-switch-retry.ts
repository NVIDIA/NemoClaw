// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult } from "./shell-probe.ts";
import { runBoundedRetry, type RetryEvidence } from "../../../tools/e2e/retry-evidence.mts";

const TRANSIENT_INFERENCE_SET_FAILURE =
  /timed? out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|failed to connect|error sending request|\b50[234]\b/iu;
const TERMINAL_INFERENCE_SET_FAILURE =
  /authentication failed|authorization failed|unauthorized|forbidden|HTTP 40[13]\b|\b40[13]\b|denied by network policy|network policy denied|policy (?:update |validation )?failed|malformed|invalid (?:provider|model|configuration|request|[^\r\n]*(?:credential|api[_ -]?key))|(?:model|route|verification) mismatch|expected (?:model|provider|route)[^\r\n]*(?:got|found)/iu;

export interface InferenceSwitchRetryArtifactSink {
  writeJson(path: string, value: unknown): Promise<string>;
}

export async function writeInferenceSwitchRetryEvidence(
  artifacts: InferenceSwitchRetryArtifactSink,
  evidence: RetryEvidence,
): Promise<void> {
  await artifacts.writeJson("inference-switch-retry-evidence.json", evidence);
}

export function inferenceSetAttemptCount(raw: string | undefined, fallback = 3): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error(`NEMOCLAW_SWITCH_SET_ATTEMPTS must be between 1 and 10; got ${raw}`);
  }
  return parsed;
}

export function isTransientInferenceSetFailure(result: ShellProbeResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return (
    !TERMINAL_INFERENCE_SET_FAILURE.test(output) && TRANSIENT_INFERENCE_SET_FAILURE.test(output)
  );
}

export function inferenceResponseModel(raw: string): string {
  const response = JSON.parse(raw) as { model?: unknown };
  return typeof response.model === "string" ? response.model : "";
}

export async function runInferenceSetWithRetry(options: {
  attempts: number;
  delay?: (milliseconds: number) => Promise<void>;
  run: (attempt: number) => Promise<ShellProbeResult>;
  onEvidence?: (evidence: RetryEvidence) => Promise<void> | void;
}): Promise<ShellProbeResult> {
  const execution = await runBoundedRetry({
    operation: "inference.switch.verify",
    owner: "inference-provider",
    idempotence: "idempotent",
    maxAttempts: options.attempts,
    run: options.run,
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
  if (execution.outcome === "passed") return execution.value;
  if (execution.value !== undefined) return execution.value;
  throw new Error("inference switch retry failed without a command result");
}
