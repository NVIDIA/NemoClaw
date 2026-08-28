// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  compactAnswerText,
  containsAnswer,
  containsReplyTokenAllowingWhitespace,
} from "./e2e-answer-assertions.ts";

describe("E2E answer assertions", () => {
  it("normalizes harmless model-inserted whitespace", () => {
    expect(compactAnswerText("4\n2")).toBe("42");
    expect(containsAnswer("The answer is 4\n2.", "42")).toBe(true);
  });

  it("requires numeric answer boundaries (#10215)", () => {
    expect(containsAnswer("156", "56")).toBe(false);
    expect(containsAnswer("560", "56")).toBe(false);
    expect(containsAnswer("The result is [5\n6].", "56")).toBe(true);
    expect(containsAnswer("The result is {5\n6}.", "56")).toBe(true);
  });

  it("accepts text answers and rejects empty output (#10215)", () => {
    expect(containsAnswer("Request acknowledged.", "acknowledged")).toBe(true);
    expect(containsAnswer("", "56")).toBe(false);
  });

  it.each([
    '{"type":"function","function":{"name":"read","parameters":{"value":56}}',
    '[{"name":"read","parameters":{"value":56}}]',
    "Tool call: read returned 56",
  ])("rejects tool-call output containing the expected answer: %s (#10215)", (output) => {
    expect(containsAnswer(output, "56"), output).toBe(false);
  });

  it("matches deterministic reply tokens split by streaming whitespace", () => {
    expect(containsReplyTokenAllowingWhitespace("A\n2603-REPLY", "A2603-REPLY")).toBe(true);
    expect(containsReplyTokenAllowingWhitespace("B 2603-REPLY", "B2603-REPLY")).toBe(true);
  });
});
