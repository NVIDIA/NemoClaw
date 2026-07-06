// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  agentReplyContainsToken,
  MOCK_BASELINE_API_KEY,
  MOCK_BASELINE_MODEL,
  mockBaselineInference,
} from "../live/openclaw-inference-switch-helpers.ts";

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
