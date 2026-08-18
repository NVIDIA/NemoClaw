// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  agentReplyContainsToken,
  classifyOpenClawPostSwitchInferenceAttempt,
  MOCK_BASELINE_API_KEY,
  MOCK_BASELINE_MODEL,
  mockBaselineInference,
} from "../live/openclaw-inference-switch-helpers.ts";

describe("openclaw-inference-switch post-switch retry classification", () => {
  const attempt = {
    exitCode: 1,
    httpStatus: "000",
    malformed: false,
    output: "",
    productMatched: false,
  };

  it.each([6, 7, 28, 35, 52, 56])(
    "retries only explicit transport and HTTP failures [%s]",
    (exitCode) => {
      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode,
          output: "curl transport failed",
        }),
      ).toEqual({ outcome: "failed", failureClass: "transient-external" });

      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode: 0,
          httpStatus: "503",
          output: "service unavailable",
        }),
      ).toEqual({ outcome: "failed", failureClass: "transient-external" });
      expect(
        classifyOpenClawPostSwitchInferenceAttempt({
          ...attempt,
          exitCode: 1,
          output: "ETIMEDOUT",
        }),
      ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    },
  );

  it("keeps terminal and successful product mismatches out of retries", () => {
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        output: "HTTP 401 authentication failed after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authentication" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "HTTP 403 authorization failed after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authorization" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "denied by network policy after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "policy-denial" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 28,
        output: "invalid API key after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "authentication" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 0,
        httpStatus: "200",
        output: "wrong model after ETIMEDOUT",
      }),
    ).toEqual({ outcome: "failed", failureClass: "deterministic" });
    expect(
      classifyOpenClawPostSwitchInferenceAttempt({
        ...attempt,
        exitCode: 0,
        httpStatus: "429",
        output: "invalid JSON after timeout",
      }),
    ).toEqual({ outcome: "failed", failureClass: "malformed-input" });
  });
});

describe("openclaw-inference-switch agent reply matching", () => {
  it("tolerates wrapped PONG", () => {
    expect(agentReplyContainsToken("P\nO N G", "PONG")).toBe(true);
    expect(agentReplyContainsToken("wrapped: p o\nng", "PONG")).toBe(false);
    expect(agentReplyContainsToken("the answer is PONG", "PONG")).toBe(false);
    expect(agentReplyContainsToken("PONG because the route works", "PONG")).toBe(false);
    expect(agentReplyContainsToken("PANG", "PONG")).toBe(false);
    expect(agentReplyContainsToken("SPONGE", "PONG")).toBe(false);
    expect(agentReplyContainsToken("pingpong", "PONG")).toBe(false);
  });
});

describe("openclaw-inference-switch mock-Anthropic baseline", () => {
  it("uses an authenticated local baseline with the compatible env wiring", () => {
    expect(mockBaselineInference("http://127.0.0.1:34567/v1")).toEqual({
      apiKey: MOCK_BASELINE_API_KEY,
      endpointUrl: "http://127.0.0.1:34567/v1",
      env: {
        COMPATIBLE_API_KEY: MOCK_BASELINE_API_KEY,
        NEMOCLAW_COMPAT_MODEL: MOCK_BASELINE_MODEL,
        NEMOCLAW_ENDPOINT_URL: "http://127.0.0.1:34567/v1",
        NEMOCLAW_MODEL: MOCK_BASELINE_MODEL,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
      },
    });
  });

  it("threads the endpoint URL into both the config and the env", () => {
    const baseline = mockBaselineInference("http://10.0.0.5:9000/v1");
    expect(baseline.endpointUrl).toBe("http://10.0.0.5:9000/v1");
    expect(baseline.env.NEMOCLAW_ENDPOINT_URL).toBe("http://10.0.0.5:9000/v1");
  });
});
