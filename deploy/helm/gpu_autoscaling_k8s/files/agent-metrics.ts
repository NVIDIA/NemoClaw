// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared Prometheus helpers for agent /metrics (LLM latency, HTTP counters).

const configuredLlmLatencyWindow = Number(process.env.LLM_LATENCY_WINDOW_SIZE ?? "128");
const LLM_LATENCY_WINDOW =
  Number.isSafeInteger(configuredLlmLatencyWindow) && configuredLlmLatencyWindow > 0
    ? Math.min(configuredLlmLatencyWindow, 10_000)
    : 128;
const llmDurationsMs = [];
let llmDurationSumSec = 0;
let llmDurationCount = 0;
let llmRequestsOk = 0;
let llmRequestsError = 0;
const llmHistogramBucketsSec = [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const llmHistogramCounts = Array.from({ length: llmHistogramBucketsSec.length + 1 }, () => 0);

export function recordLlmLatency(durationMs, ok) {
  // Normalize once so the rolling window (p50/p95/avg) and the cumulative
  // counters/histogram below always agree on the same finite, non-negative value.
  const normalizedMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const sec = normalizedMs / 1000;
  llmDurationSumSec += sec;
  llmDurationCount += 1;
  if (ok) llmRequestsOk += 1;
  else llmRequestsError += 1;

  llmDurationsMs.push(normalizedMs);
  if (llmDurationsMs.length > LLM_LATENCY_WINDOW) llmDurationsMs.shift();

  let bucketIdx = llmHistogramBucketsSec.findIndex((bound) => sec <= bound);
  if (bucketIdx === -1) bucketIdx = llmHistogramBucketsSec.length;
  for (let i = bucketIdx; i < llmHistogramCounts.length; i += 1) {
    llmHistogramCounts[i] += 1;
  }
}

function percentileMs(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)];
}

function llmLatencySnapshotMs() {
  if (!llmDurationsMs.length) {
    return { p50: 0, p95: 0, avg: 0 };
  }
  const sorted = [...llmDurationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    p50: percentileMs(sorted, 0.5),
    p95: percentileMs(sorted, 0.95),
    avg: sum / sorted.length,
  };
}

export function llmMetricsLines() {
  const { p50, p95, avg } = llmLatencySnapshotMs();
  const lines = [
    "# HELP nemoclaw_llm_requests_total Chat/completions proxied to inference backend",
    "# TYPE nemoclaw_llm_requests_total counter",
    `nemoclaw_llm_requests_total{result="success"} ${llmRequestsOk}`,
    `nemoclaw_llm_requests_total{result="error"} ${llmRequestsError}`,
    "# HELP nemoclaw_llm_request_duration_seconds LLM chat/completions end-to-end proxy latency",
    "# TYPE nemoclaw_llm_request_duration_seconds histogram",
  ];

  for (let i = 0; i < llmHistogramBucketsSec.length; i += 1) {
    lines.push(
      `nemoclaw_llm_request_duration_seconds_bucket{le="${llmHistogramBucketsSec[i]}"} ${llmHistogramCounts[i]}`,
    );
  }
  lines.push(
    `nemoclaw_llm_request_duration_seconds_bucket{le="+Inf"} ${llmHistogramCounts[llmHistogramCounts.length - 1]}`,
    `nemoclaw_llm_request_duration_seconds_sum ${llmDurationSumSec}`,
    `nemoclaw_llm_request_duration_seconds_count ${llmDurationCount}`,
    "# HELP nemoclaw_llm_latency_p50_milliseconds Rolling p50 LLM latency (recent window)",
    "# TYPE nemoclaw_llm_latency_p50_milliseconds gauge",
    `nemoclaw_llm_latency_p50_milliseconds ${Math.round(p50)}`,
    "# HELP nemoclaw_llm_latency_p95_milliseconds Rolling p95 LLM latency (recent window)",
    "# TYPE nemoclaw_llm_latency_p95_milliseconds gauge",
    `nemoclaw_llm_latency_p95_milliseconds ${Math.round(p95)}`,
    "# HELP nemoclaw_llm_latency_avg_milliseconds Rolling average LLM latency (recent window)",
    "# TYPE nemoclaw_llm_latency_avg_milliseconds gauge",
    `nemoclaw_llm_latency_avg_milliseconds ${Math.round(avg)}`,
  );
  return lines;
}
