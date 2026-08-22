// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared Prometheus helpers for metrics-proxy /metrics (LLM latency, HTTP counters).
// Rolling latency_avg gauge expires after idle so HPA can scale down once load stops.

const configuredLlmLatencyWindow = Number(process.env.LLM_LATENCY_WINDOW_SIZE ?? "128");
const LLM_LATENCY_WINDOW =
  Number.isSafeInteger(configuredLlmLatencyWindow) && configuredLlmLatencyWindow > 0
    ? Math.min(configuredLlmLatencyWindow, 10_000)
    : 128;
// After this many ms with no new samples, clear the rolling window so the HPA
// gauge reports 0 (below target) instead of retaining the last high latency.
// 0 disables idle expiration. Default 60s is below the chart's scaleDown
// stabilizationWindowSeconds (180) so scale-down can proceed after load stops.
const configuredIdleExpireMs = Number(process.env.LLM_LATENCY_IDLE_EXPIRE_MS ?? "60000");
const LLM_LATENCY_IDLE_EXPIRE_MS =
  Number.isFinite(configuredIdleExpireMs) && configuredIdleExpireMs >= 0
    ? configuredIdleExpireMs
    : 60_000;

const llmDurationsMs = [];
let llmDurationSumSec = 0;
let llmDurationCount = 0;
let llmRequestsOk = 0;
let llmRequestsError = 0;
let lastLlmSampleAtMs = 0;
let nowMsProvider = () => Date.now();
const llmHistogramBucketsSec = [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const llmHistogramCounts = Array.from({ length: llmHistogramBucketsSec.length + 1 }, () => 0);

function clearRollingLatencyWindow() {
  llmDurationsMs.length = 0;
  lastLlmSampleAtMs = 0;
}

function expireIdleRollingLatencyWindow(nowMs = nowMsProvider()) {
  if (!llmDurationsMs.length || LLM_LATENCY_IDLE_EXPIRE_MS <= 0 || lastLlmSampleAtMs <= 0) {
    return;
  }
  if (nowMs - lastLlmSampleAtMs >= LLM_LATENCY_IDLE_EXPIRE_MS) {
    clearRollingLatencyWindow();
  }
}

export function recordLlmLatency(durationMs, ok) {
  // Normalize once so the rolling window and the cumulative counters/histogram
  // below always agree on the same finite, non-negative value.
  const normalizedMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const sec = normalizedMs / 1000;
  llmDurationSumSec += sec;
  llmDurationCount += 1;
  if (ok) llmRequestsOk += 1;
  else llmRequestsError += 1;

  llmDurationsMs.push(normalizedMs);
  if (llmDurationsMs.length > LLM_LATENCY_WINDOW) llmDurationsMs.shift();
  lastLlmSampleAtMs = nowMsProvider();

  let bucketIdx = llmHistogramBucketsSec.findIndex((bound) => sec <= bound);
  if (bucketIdx === -1) bucketIdx = llmHistogramBucketsSec.length;
  for (let i = bucketIdx; i < llmHistogramCounts.length; i += 1) {
    llmHistogramCounts[i] += 1;
  }
}

function llmLatencyAvgMs() {
  expireIdleRollingLatencyWindow();
  if (!llmDurationsMs.length) return 0;
  const sum = llmDurationsMs.reduce((acc, v) => acc + v, 0);
  return sum / llmDurationsMs.length;
}

export function llmMetricsLines() {
  const avg = llmLatencyAvgMs();
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
    "# HELP nemoclaw_llm_latency_avg_milliseconds Rolling average LLM latency (recent window; idle-expires)",
    "# TYPE nemoclaw_llm_latency_avg_milliseconds gauge",
    `nemoclaw_llm_latency_avg_milliseconds ${Math.round(avg)}`,
  );
  return lines;
}

/** Test-only: override the clock used for idle expiration. Pass null to restore. */
export function setLlmMetricsClockForTests(clockFn) {
  nowMsProvider = typeof clockFn === "function" ? clockFn : () => Date.now();
}

/** Test-only: clear rolling latency samples (does not reset cumulative counters). */
export function resetLlmLatencyWindowForTests() {
  clearRollingLatencyWindow();
}
