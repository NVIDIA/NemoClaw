#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// The HPA latency window ages from the newest sample, not wall-clock now.
// A 45s gap with no new samples stays inside the 60s idle expire.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.LLM_LATENCY_IDLE_EXPIRE_MS = "60000";
process.env.LLM_LATENCY_WINDOW_MS = "30000";

const metricsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../files/metrics-proxy-metrics.ts");
const {
  recordLlmLatency,
  llmMetricsLines,
  setLlmMetricsClockForTests,
  resetLlmLatencyWindowForTests,
} = await import(pathToFileURL(metricsPath).href);

function gaugeValue(lines: string[], name: string): number {
  const prefix = `${name} `;
  const line = lines.find((entry) => entry.startsWith(prefix));
  assert.ok(line, `missing gauge ${name}`);
  return Number(line.slice(prefix.length));
}

let nowMs = 1_000_000;
setLlmMetricsClockForTests(() => nowMs);
resetLlmLatencyWindowForTests();

recordLlmLatency(16000, true);
nowMs += 45_000;
let lines = llmMetricsLines();
assert.equal(gaugeValue(lines, "nemoclaw_llm_latency_avg_milliseconds"), 16000);

nowMs += 16_000;
lines = llmMetricsLines();
assert.equal(gaugeValue(lines, "nemoclaw_llm_latency_avg_milliseconds"), 0);

setLlmMetricsClockForTests(null);
console.log("OK: latency window ages from the newest sample so idle expire can apply");
