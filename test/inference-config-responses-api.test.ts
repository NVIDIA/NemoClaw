// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getSandboxInferenceConfig } from "../dist/lib/inference/config.js";

// Providers in shouldSkipResponsesProbe (nvidia-prod, nvidia-nim, gemini-api) do
// not expose /v1/responses. On a provider switch the runtime API resolves to null
// and the caller falls back to the persisted shared "inference" provider api, which
// can carry a prior provider's "openai-responses" over. getSandboxInferenceConfig
// must force completions for these providers so the route does not 404 every turn.
describe("getSandboxInferenceConfig: Responses API guard for no-/responses providers", () => {
  it("forces openai-completions for nvidia-prod even when a stale openai-responses api carries over", () => {
    const cfg = getSandboxInferenceConfig(
      "meta/llama-3.1-8b-instruct",
      "nvidia-prod",
      "openai-responses",
    );
    expect(cfg.inferenceApi).toBe("openai-completions");
  });

  it("forces openai-completions for nvidia-nim and gemini-api with a stale openai-responses api", () => {
    expect(getSandboxInferenceConfig("m", "nvidia-nim", "openai-responses").inferenceApi).toBe(
      "openai-completions",
    );
    expect(getSandboxInferenceConfig("m", "gemini-api", "openai-responses").inferenceApi).toBe(
      "openai-completions",
    );
  });

  it("still honors openai-responses for a compatible-endpoint that supports it", () => {
    expect(
      getSandboxInferenceConfig("m", "compatible-endpoint", "openai-responses").inferenceApi,
    ).toBe("openai-responses");
  });

  it("leaves anthropic-prod on anthropic-messages regardless of the passed api", () => {
    expect(getSandboxInferenceConfig("m", "anthropic-prod", "openai-responses").inferenceApi).toBe(
      "anthropic-messages",
    );
  });
});
