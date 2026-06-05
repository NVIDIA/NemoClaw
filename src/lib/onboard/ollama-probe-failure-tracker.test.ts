// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { OllamaProbeFailureTracker } from "./ollama-probe-failure-tracker";

describe("OllamaProbeFailureTracker", () => {
  it("excludes a model after the first failure and trips the limit after repeated failures", () => {
    const tracker = new OllamaProbeFailureTracker();

    expect(tracker.recordFailure("qwen3.5:9b")).toBe(false);
    expect(tracker.shouldExclude("qwen3.5:9b")).toBe(true);
    expect(tracker.excludedModels().has("qwen3.5:9b")).toBe(true);

    expect(tracker.recordFailure("qwen3.5:9b")).toBe(true);

    expect(tracker.getFailureCount("qwen3.5:9b")).toBe(2);
    expect(tracker.getTotalFailures()).toBe(2);
  });

  it("supports delaying exclusion until the per-model failure limit", () => {
    const tracker = new OllamaProbeFailureTracker({ excludeAfterFailures: 2 });

    expect(tracker.recordFailure("qwen3.5:9b")).toBe(false);
    expect(tracker.shouldExclude("qwen3.5:9b")).toBe(false);

    expect(tracker.recordFailure("qwen3.5:9b")).toBe(true);
    expect(tracker.shouldExclude("qwen3.5:9b")).toBe(true);
  });

  it("trips the global limit across distinct models", () => {
    const tracker = new OllamaProbeFailureTracker();

    expect(tracker.recordFailure("a:1b")).toBe(false);
    expect(tracker.recordFailure("b:1b")).toBe(false);
    expect(tracker.recordFailure("c:1b")).toBe(true);

    expect(tracker.shouldExclude("a:1b")).toBe(true);
    expect(tracker.getTotalFailures()).toBe(3);
    expect(tracker.formatLimitMessage("c:1b")).toContain("3 probe failure(s)");
  });

  it("resets counters and exclusions", () => {
    const tracker = new OllamaProbeFailureTracker({ maxFailuresSameModel: 1 });

    expect(tracker.recordFailure("nemotron:30b")).toBe(true);
    tracker.reset();

    expect(tracker.getTotalFailures()).toBe(0);
    expect(tracker.getFailureCount("nemotron:30b")).toBe(0);
    expect(tracker.shouldExclude("nemotron:30b")).toBe(false);
  });
});
