// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  requiresMaxCompletionTokensField,
  resolveMaxTokensField,
  resolveProbeReplyTokens,
} from "./max-tokens-field";

describe("resolveMaxTokensField", () => {
  it.each(["gpt-5", "gpt-5.4", "gpt-5.4-turbo", "GPT-5.4"])(
    "selects max_completion_tokens for GPT-5 family model %s (#6642)",
    (model) => {
      expect(resolveMaxTokensField(model)).toBe("max_completion_tokens");
      expect(requiresMaxCompletionTokensField(model)).toBe(true);
    },
  );

  it.each(["o1", "o1-mini", "o3", "o3-mini", "o4-mini"])(
    "selects max_completion_tokens for OpenAI reasoning model %s",
    (model) => {
      expect(resolveMaxTokensField(model)).toBe("max_completion_tokens");
    },
  );

  it("strips a provider prefix before matching", () => {
    expect(resolveMaxTokensField("azure/gpt-5.4")).toBe("max_completion_tokens");
    expect(resolveMaxTokensField("openai/o3-mini")).toBe("max_completion_tokens");
  });

  it.each([
    "gpt-4o",
    "gpt-4.1",
    "nvidia/nemotron-3-super-120b-a12b",
    "moonshotai/kimi-k2.6",
    "deepseek-ai/deepseek-v4-pro",
  ])("keeps max_tokens for legacy or non-OpenAI model %s", (model) => {
    expect(resolveMaxTokensField(model)).toBe("max_tokens");
  });

  it.each(["openai-gpt", "orca-2", "olmo-7b"])(
    "keeps max_tokens when model %s merely starts with the letter o",
    (model) => {
      expect(resolveMaxTokensField(model)).toBe("max_tokens");
    },
  );

  it("defaults to max_tokens for empty or nullish model ids", () => {
    expect(resolveMaxTokensField("")).toBe("max_tokens");
    expect(resolveMaxTokensField(null)).toBe("max_tokens");
    expect(resolveMaxTokensField(undefined)).toBe("max_tokens");
  });
});

describe("resolveProbeReplyTokens", () => {
  it.each([
    ["gemini-api", 256],
    ["openai-api", 16],
    ["nvidia-prod", 16],
    [null, 16],
  ])("resolves the %s provider probe budget", (provider, expected) => {
    expect(resolveProbeReplyTokens(provider)).toBe(expected);
  });
});
