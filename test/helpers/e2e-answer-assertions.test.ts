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

  it("rejects numeric answers embedded in other numbers (#10215)", () => {
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
    '[{"name":"read","description":"Returns 56"}]',
    '{"name":"read","input":{"expected":56}}',
    '{"type":"tool_use","name":"calculator","input":{"expected":56}}',
    '{"type":"tool_result","tool_call_id":"call-1","content":"56"}',
    '{"type":"toolResult","content":"56"}',
    '{"role":"tool","content":"56"}',
    '{"role":"function","content":"56"}',
    '{"role":"toolResult","content":"56"',
    'The answer is 56.\n{"role":"tool-result","content":"56"',
    '{"type":"tool_result","tool_call_id":"call-1","content":"56"',
    '{"response":{"name":"read","input":{"value":56}}}',
    '{"response":{"name":"read","input":{"value":56}',
    '{"name":"read","description":"Returns 56"',
    '{"name":"calculator","input_schema":{"type":"object","default":56}}\nextra output',
    '{"type":"tool_use","name":"calculator","input":{"default":56}}\nextra output',
    '```json\n{"name":"read","description":"Returns 56"',
    "Tool call: read returned 56",
    'The answer is 56.\n{"type":"function","function":{"name":"read","parameters":{}}}',
    'The answer is 56.\n{"type":"function","function":{"name":"read","parameters":{',
    String.raw`The answer is 56.
{"ty\u0070e":"funct\u0069on","funct\u0069on":{"name":"read"`,
    'The answer is 56.\n[{"name":"read","description":"Returns data"}]',
  ])("rejects tool-call output containing the expected answer: %s (#10215)", (output) => {
    expect(containsAnswer(output, "56"), output).toBe(false);
  });

  it("accepts conversational replies that mention tool-call capability (#10215)", () => {
    expect(containsAnswer("I cannot make tool calls, but the answer is 42.", "42")).toBe(true);
  });

  it.each([
    ["initial", "Acknowledged.", "acknowledged"],
    ["resumed", "56", "56"],
    ["continued", "The integer is 56.", "56"],
  ])("accepts the semantic %s reply used by the Hermes follow-up sequence", (_turn, output, answer) => {
    expect(containsAnswer(output, answer)).toBe(true);
  });

  it("matches deterministic reply tokens split by streaming whitespace", () => {
    expect(containsReplyTokenAllowingWhitespace("A\n2603-REPLY", "A2603-REPLY")).toBe(true);
    expect(containsReplyTokenAllowingWhitespace("B 2603-REPLY", "B2603-REPLY")).toBe(true);
  });
});
