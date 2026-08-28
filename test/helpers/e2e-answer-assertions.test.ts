// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  compactAnswerText,
  containsAnswer,
  containsInteger42Answer,
  containsIntegerAnswer,
  containsReplyTokenAllowingWhitespace,
} from "./e2e-answer-assertions.ts";

describe("E2E answer assertions", () => {
  it("normalizes harmless model-inserted whitespace", () => {
    expect(compactAnswerText("4\n2")).toBe("42");
    expect(containsInteger42Answer("4\n2")).toBe(true);
    expect(containsInteger42Answer("The answer is 4\n2.")).toBe(true);
  });

  it("does not match unrelated integers after whitespace normalization", () => {
    expect(containsInteger42Answer("142")).toBe(false);
    expect(containsInteger42Answer("420")).toBe(false);
  });

  it("accepts the expected conversational answer (#10215)", () => {
    expect(containsAnswer("The answer is 5\n6.", "56")).toBe(true);
    expect(containsAnswer("", "56")).toBe(false);
  });

  it.each([
    '{"type":"function","function":{"name":"read","parameters":{"value":56}}',
    '[{"name":"read","parameters":{"value":56}},{"name":"tts"}]',
    '{"id":"call_1","type":"function","function":{"name":"read","parameters":{"value":56}}}',
    '{"tool":"read","arguments":{"value":56}}',
    '{"tool_calls":[{"function":{"arguments":{"value":56}}}]}',
    'Tool call: {"name":"read","parameters":{"value":56}}',
    '~~~json\n{"type":"function","function":{"name":"read","param":{"value":56}}}\n~~~',
  ])("rejects internal tool output: %s (#10215)", (output) => {
    expect(containsAnswer(output, "56"), output).toBe(false);
  });

  it("matches deterministic reply tokens split by streaming whitespace", () => {
    expect(containsReplyTokenAllowingWhitespace("A\n2603-REPLY", "A2603-REPLY")).toBe(true);
    expect(containsReplyTokenAllowingWhitespace("B 2603-REPLY", "B2603-REPLY")).toBe(true);
  });
});
