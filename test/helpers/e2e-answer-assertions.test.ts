// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  compactAnswerText,
  containsInteger42Answer,
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

  it("matches deterministic reply tokens split by streaming whitespace", () => {
    expect(containsReplyTokenAllowingWhitespace("A\n2603-REPLY", "A2603-REPLY")).toBe(true);
    expect(containsReplyTokenAllowingWhitespace("B 2603-REPLY", "B2603-REPLY")).toBe(true);
  });
});
