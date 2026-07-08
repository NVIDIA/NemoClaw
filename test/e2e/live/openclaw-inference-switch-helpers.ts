// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure reply-matching helper shared by the openclaw-inference-switch live E2E
// target and its PR-collected unit test. Extracting the predicate lets the fast
// e2e-support project verify that a wrapped/whitespace-split "PONG" reply is
// accepted while echoed or embedded tokens are rejected, without gating on
// NEMOCLAW_RUN_LIVE_E2E=1.

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
