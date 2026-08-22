#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Focused contract for rolling LLM latency_avg idle-expiration used by HPA.
// After load stops, the gauge must drop to 0 so scale-down is not blocked by stale samples.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.LLM_LATENCY_WINDOW_SIZE = "8";
process.env.LLM_LATENCY_IDLE_EXPIRE_MS = "100";

const metricsPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../files/metrics-proxy-metrics.ts",
);
const {
  recordLlmLatency,
  llmMetricsLines,
  setLlmMetricsClockForTests,
  resetLlmLatencyWindowForTests,
} = await import(pathToFileURL(metricsPath).href);

function gaugeValue(lines, name) {
  const prefix = `${name} `;
  const line = lines.find((entry) => entry.startsWith(prefix));
  assert.ok(line, `missing gauge ${name}`);
  return Number(line.slice(prefix.length));
}

let nowMs = 1_000_000;
setLlmMetricsClockForTests(() => nowMs);
resetLlmLatencyWindowForTests();

recordLlmLatency(5000, true);
recordLlmLatency(7000, true);
let lines = llmMetricsLines();
assert.equal(gaugeValue(lines, "nemoclaw_llm_latency_avg_milliseconds"), 6000);
assert.ok(
  !lines.some((entry) => entry.includes("latency_p50") || entry.includes("latency_p95")),
  "p50/p95 latency gauges must not be exported",
);

// Still within the idle window — gauge retains the rolling average.
nowMs += 99;
lines = llmMetricsLines();
assert.equal(gaugeValue(lines, "nemoclaw_llm_latency_avg_milliseconds"), 6000);

// Past idle expire — rolling window clears so HPA sees 0 (below target).
nowMs += 1;
lines = llmMetricsLines();
assert.equal(gaugeValue(lines, "nemoclaw_llm_latency_avg_milliseconds"), 0);

// A new sample re-arms the window.
recordLlmLatency(4000, true);
lines = llmMetricsLines();
assert.equal(gaugeValue(lines, "nemoclaw_llm_latency_avg_milliseconds"), 4000);

// Cumulative request counters are not cleared by idle expiration.
assert.match(lines.join("\n"), /nemoclaw_llm_requests_total\{result="success"\} 3/);

setLlmMetricsClockForTests(null);
console.log("OK: rolling LLM latency_avg gauge idle-expires for HPA scale-down");
