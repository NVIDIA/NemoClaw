// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure reply-matching helper shared by the openclaw-inference-switch live E2E
// target and its PR-collected unit test. Extracting the predicate lets the fast
// e2e-support project verify that a wrapped/whitespace-split "PONG" reply is
// accepted while echoed or embedded tokens are rejected, without gating on
// NEMOCLAW_RUN_LIVE_E2E=1.

import type { RetryFailureClass } from "../../../tools/e2e/retry-evidence.mts";

export interface OpenClawPostSwitchInferenceAttempt {
  exitCode: number | null;
  httpStatus: string;
  malformed: boolean;
  output: string;
  productMatched: boolean;
}

export type OpenClawPostSwitchInferenceClassification =
  | { outcome: "passed" }
  | { outcome: "failed"; failureClass: RetryFailureClass };

export function classifyOpenClawPostSwitchInferenceAttempt(
  attempt: OpenClawPostSwitchInferenceAttempt,
): OpenClawPostSwitchInferenceClassification {
  if (attempt.productMatched) return { outcome: "passed" };
  if (attempt.malformed || /malformed|invalid (?:request|json)/iu.test(attempt.output)) {
    return { outcome: "failed", failureClass: "malformed-input" };
  }
  if (
    /authentication failed|unauthorized|HTTP 401\b|\b401\b|invalid (?:credential|api[_ -]?key)/iu.test(
      attempt.output,
    )
  ) {
    return { outcome: "failed", failureClass: "authentication" };
  }
  if (/authorization failed|forbidden|HTTP 403\b|\b403\b/iu.test(attempt.output)) {
    return { outcome: "failed", failureClass: "authorization" };
  }
  if (
    /denied by network policy|network policy denied|policy (?:update |validation )?failed/iu.test(
      attempt.output,
    )
  ) {
    return { outcome: "failed", failureClass: "policy-denial" };
  }
  const curlTransportExit =
    typeof attempt.exitCode === "number" && [6, 7, 28, 35, 52, 56].includes(attempt.exitCode);
  const transientTransport = curlTransportExit;
  const transientStatus =
    attempt.exitCode === 0 && /^(408|429|5[0-9]{2})$/u.test(attempt.httpStatus);
  return transientTransport || transientStatus
    ? { outcome: "failed", failureClass: "transient-external" }
    : { outcome: "failed", failureClass: "deterministic" };
}

export function agentReplyContainsToken(reply: string, expected: string): boolean {
  const normalizedReply = reply.replace(/\s+/gu, "").toUpperCase();
  const normalizedExpected = expected.replace(/\s+/gu, "").toUpperCase();
  return normalizedExpected.length > 0 && normalizedReply === normalizedExpected;
}

// Baseline (mock-Anthropic) inference config the live target builds when
// NEMOCLAW_SWITCH_MOCK_ANTHROPIC=1 points OpenClaw at a local fake OpenAI-
// compatible server. Extracted so the fast e2e-support project can assert the
// exact env wiring (credential, model, endpoint, preferred API, provider)
// without gating on NEMOCLAW_RUN_LIVE_E2E=1.
export const MOCK_BASELINE_API_KEY = "openclaw-switch-baseline-credential";
export const MOCK_BASELINE_MODEL = "openclaw-switch-baseline-model";

export interface BaselineInferenceConfig {
  apiKey: string;
  endpointUrl: string;
  env: NodeJS.ProcessEnv;
}

export function mockBaselineInference(endpointUrl: string): BaselineInferenceConfig {
  return {
    apiKey: MOCK_BASELINE_API_KEY,
    endpointUrl,
    env: {
      COMPATIBLE_API_KEY: MOCK_BASELINE_API_KEY,
      NEMOCLAW_COMPAT_MODEL: MOCK_BASELINE_MODEL,
      NEMOCLAW_ENDPOINT_URL: endpointUrl,
      NEMOCLAW_MODEL: MOCK_BASELINE_MODEL,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    },
  };
}
