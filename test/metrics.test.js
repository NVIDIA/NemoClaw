// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// Load the compiled metrics module
const metricsPath = path.resolve(__dirname, "../nemoclaw/dist/observability/metrics.js");
const { metrics, observeLatency } = require(metricsPath);

// Enable metrics for testing
process.env.NEMOCLAW_METRICS_ENABLED = "true";

test("MetricsRegistry stores and exports counters", () => {
  metrics.incrementCounter("test_counter", { foo: "bar" });
  const output = metrics.getPrometheusMetrics();
  
  assert.match(output, /# TYPE test_counter counter/);
  assert.match(output, /test_counter\{foo="bar"\} 1/);
});

test("MetricsRegistry stores and exports histograms", () => {
  metrics.observeHistogram("test_hist", 0.5, { abc: "123" });
  const output = metrics.getPrometheusMetrics();
  
  assert.match(output, /# TYPE test_hist histogram/);
  assert.match(output, /test_hist_bucket\{abc="123",le="0\.5"\} 1/);
  assert.match(output, /test_hist_sum\{abc="123"\} 0\.5/);
  assert.match(output, /test_hist_count\{abc="123"\} 1/);
});

test("observeLatency tracks success metrics", async () => {
  const result = await observeLatency("test_op", { op: "success" }, async () => {
    return "done";
  });
  
  assert.strictEqual(result, "done");
  const output = metrics.getPrometheusMetrics();
  
  assert.match(output, /test_op_total\{op="success",status="success"\} 1/);
  assert.match(output, /test_op_latency_seconds_count\{op="success",status="success"\} 1/);
});

test("observeLatency tracks error metrics", async () => {
  try {
    await observeLatency("test_op_err", { op: "fail" }, async () => {
      throw new Error("oops");
    });
  } catch (err) {
    assert.strictEqual(err.message, "oops");
  }
  
  const output = metrics.getPrometheusMetrics();
  assert.match(output, /test_op_err_total\{op="fail",status="error"\} 1/);
  assert.match(output, /test_op_err_latency_seconds_count\{op="fail",status="error"\} 1/);
});
