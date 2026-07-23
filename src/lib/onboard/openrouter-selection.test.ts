// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isOpenAiLikeRemoteProvider } from "./openrouter-selection";

describe("remote OpenAI-like provider helpers", () => {
  it.each([
    "openai",
    "gemini",
    "openrouter",
    "atlasCloud",
  ])("treats %s as OpenAI-compatible for remote model validation", (providerKey) => {
    expect(isOpenAiLikeRemoteProvider(providerKey)).toBe(true);
  });

  it.each([
    "anthropic",
    "anthropicCompatible",
    "custom",
  ])("does not treat %s as a curated OpenAI-like remote provider", (providerKey) => {
    expect(isOpenAiLikeRemoteProvider(providerKey)).toBe(false);
  });
});
