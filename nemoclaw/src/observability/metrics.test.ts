// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./metrics.js";

describe("MetricsRegistry", () => {
  it("does not record metrics while disabled", async () => {
    const registry = new MetricsRegistry(() => false);
    registry.incrementCounter("test_counter_total", { status: "success" });
    registry.observeHistogram("test_duration_seconds", 0.5, { status: "success" });

    const result = await registry.observeOperation("test_operation", {}, () =>
      Promise.resolve("ok"),
    );

    expect(result).toBe("ok");
    expect(registry.renderPrometheus()).toBe("");
  });

  it("exports counters with sorted and escaped labels", () => {
    const registry = new MetricsRegistry(() => true);

    registry.incrementCounter("test_counter_total", {
      status: "success",
      provider: 'nvidia"build',
    });

    expect(registry.renderPrometheus()).toContain(
      'test_counter_total{provider="nvidia\\"build",status="success"} 1',
    );
  });

  it("escapes Prometheus HELP text", () => {
    const registry = new MetricsRegistry(() => true);

    registry.incrementCounter("test_counter_total", {}, 1, "line one\\two\nline two");

    expect(registry.renderPrometheus()).toContain(
      "# HELP test_counter_total line one\\\\two\\nline two",
    );
  });

  it("exports cumulative histograms", () => {
    const registry = new MetricsRegistry(() => true);

    registry.observeHistogram("test_duration_seconds", 0.2, { status: "success" }, [0.1, 1]);

    const output = registry.renderPrometheus();
    expect(output).toContain('test_duration_seconds_bucket{status="success",le="0.1"} 0');
    expect(output).toContain('test_duration_seconds_bucket{status="success",le="1"} 1');
    expect(output).toContain('test_duration_seconds_bucket{status="success",le="+Inf"} 1');
    expect(output).toContain('test_duration_seconds_sum{status="success"} 0.2');
    expect(output).toContain('test_duration_seconds_count{status="success"} 1');
  });

  it("rejects inconsistent bucket configurations for the same histogram series", () => {
    const registry = new MetricsRegistry(() => true);

    registry.observeHistogram("test_duration_seconds", 0.2, { status: "success" }, [1, 0.1]);
    registry.observeHistogram("test_duration_seconds", 0.3, { status: "success" }, [0.1, 1]);

    expect(() => {
      registry.observeHistogram("test_duration_seconds", 0.4, { status: "success" }, [0.5, 1]);
    }).toThrow(/different bucket configuration/);
  });

  it("records operation success and error status", async () => {
    const registry = new MetricsRegistry(() => true);

    await registry.observeOperation("test_operation", { action: "plan" }, () =>
      Promise.resolve("ok"),
    );
    await expect(
      registry.observeOperation("test_operation", { action: "apply" }, () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");

    const output = registry.renderPrometheus();
    expect(output).toContain('test_operation_total{action="plan",status="success"} 1');
    expect(output).toContain('test_operation_total{action="apply",status="error"} 1');
    expect(output).toContain(
      'test_operation_duration_seconds_count{action="plan",status="success"} 1',
    );
    expect(output).toContain(
      'test_operation_duration_seconds_count{action="apply",status="error"} 1',
    );
  });
});
