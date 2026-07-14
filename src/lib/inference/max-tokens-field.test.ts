// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { requiresMaxCompletionTokensField, resolveMaxTokensField } from "./max-tokens-field";

describe("resolveMaxTokensField", () => {
  it("selects max_completion_tokens for the GPT-5 family (#6642)", () => {
    for (const model of ["gpt-5", "gpt-5.4", "gpt-5.4-turbo", "GPT-5.4"]) {
      expect(resolveMaxTokensField(model)).toBe("max_completion_tokens");
      expect(requiresMaxCompletionTokensField(model)).toBe(true);
    }
  });

  it("selects max_completion_tokens for OpenAI reasoning models", () => {
    for (const model of ["o1", "o1-mini", "o3", "o3-mini", "o4-mini"]) {
      expect(resolveMaxTokensField(model)).toBe("max_completion_tokens");
    }
  });

  it("strips a provider prefix before matching", () => {
    expect(resolveMaxTokensField("azure/gpt-5.4")).toBe("max_completion_tokens");
    expect(resolveMaxTokensField("openai/o3-mini")).toBe("max_completion_tokens");
  });

  it("keeps max_tokens for legacy and non-OpenAI models", () => {
    for (const model of [
      "gpt-4o",
      "gpt-4.1",
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.6",
      "deepseek-ai/deepseek-v4-pro",
    ]) {
      expect(resolveMaxTokensField(model)).toBe("max_tokens");
    }
  });

  it("does not misfire on models that merely start with the letter o", () => {
    for (const model of ["openai-gpt", "orca-2", "olmo-7b"]) {
      expect(resolveMaxTokensField(model)).toBe("max_tokens");
    }
  });

  it("defaults to max_tokens for empty or nullish model ids", () => {
    expect(resolveMaxTokensField("")).toBe("max_tokens");
    expect(resolveMaxTokensField(null)).toBe("max_tokens");
    expect(resolveMaxTokensField(undefined)).toBe("max_tokens");
  });
});
