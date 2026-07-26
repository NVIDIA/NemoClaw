// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyIssue2603Run,
  normalizeIssue2603Trace,
} from "../live/openclaw-tui-run-classification.ts";

describe("OpenClaw TUI chat-event failure classification", () => {
  it.each([
    {
      name: "a clean run",
      attempts: [{ captureFailure: false, productRegression: false }],
      expected: "passed",
    },
    {
      name: "an empty-event attempt recovered by retry",
      attempts: [
        { captureFailure: true, productRegression: false },
        { captureFailure: false, productRegression: false },
      ],
      expected: "recovered_infrastructure_capture",
    },
    {
      name: "persistent empty-event capture",
      attempts: [
        { captureFailure: true, productRegression: false },
        { captureFailure: true, productRegression: false },
      ],
      expected: "infrastructure_capture_failure",
    },
    {
      name: "a correlation regression",
      attempts: [{ captureFailure: false, productRegression: true }],
      expected: "product_regression",
    },
    {
      name: "a setup failure",
      attempts: [{ captureFailure: false, productRegression: false, error: "gateway unavailable" }],
      expected: "infrastructure_setup_failure",
    },
  ])("classifies $name", ({ attempts, expected }) => {
    expect(classifyIssue2603Run(attempts)).toBe(expected);
  });

  it("rejects a run without attempts", () => {
    expect(() => classifyIssue2603Run([])).toThrow(/at least one attempt/u);
  });

  it("normalizes a setup-error trace before correlation analysis", () => {
    const event = { event: "chat", payload: { state: "error" } };

    expect(normalizeIssue2603Trace({ error: "gateway unavailable", events: [event] })).toEqual({
      sentRuns: [],
      events: [event],
      historyMessages: [],
      error: "gateway unavailable",
    });
  });
});
