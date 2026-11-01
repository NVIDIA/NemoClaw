// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isChatCompletionsPreference } from "./preferred-api";

describe("isChatCompletionsPreference", () => {
  it.each(["completions", "chat-completions", "openai-completions", " Completions "])(
    "selects Chat Completions for %j (#13884)",
    (value) => {
      expect(isChatCompletionsPreference(value)).toBe(true);
    },
  );

  it.each([undefined, "", "openai-responses", "anthropic-messages", "responses"])(
    "does not select Chat Completions for %j",
    (value) => {
      expect(isChatCompletionsPreference(value)).toBe(false);
    },
  );
});
